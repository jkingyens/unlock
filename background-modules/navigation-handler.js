// ext/background-modules/navigation-handler.js

import {
    logger,
    storage,
    packetUtils,
    shouldUseTabGroups,
    getPacketContext,
    setPacketContext,
    clearPacketContext,
    CONFIG,
    MPI_PARAMS
} from '../utils.js';
import * as sidebarHandler from './sidebar-handler.js';
import * as tabGroupHandler from './tab-group-handler.js';
import cloudStorage from '../cloud-storage.js';
import { interimContextMap } from '../background.js';

const pendingVisitTimers = new Map(); // Map to track timers for marking pages as visited

export function clearPendingVisitTimer(tabId) {
    if (pendingVisitTimers.has(tabId)) {
        clearTimeout(pendingVisitTimers.get(tabId));
        pendingVisitTimers.delete(tabId);
        logger.log(`[NavigationHandler] Cleared pending visit timer for closed/navigated tab ${tabId}.`);
    }
}

export { clearPacketContext };

// ... (parseMpiEventFromUrl remains the same) ...

// --- Web Navigation Listener Functions ---

export async function onCommitted(details) {
    if (details.frameId !== 0 || !details.url?.startsWith('http')) return;
    await processNavigationEvent(details.tabId, details.url, "Committed", details);
}

export async function onHistoryStateUpdated(details) {
    if (details.frameId !== 0 || !details.url?.startsWith('http')) return;
    await processNavigationEvent(details.tabId, details.url, "HistoryStateUpdated", details);
}

// --- Helper Function to Trigger Completion Prompt ---
export async function checkAndPromptForCompletion(logPrefix, visitResult, instanceId) {
    if (visitResult?.success && visitResult?.justCompleted) {
        logger.log(logPrefix, `Packet ${instanceId} was just completed.`);
        try {
            const useGroups = await shouldUseTabGroups();
            const instanceDataForPrompt = visitResult.instance || await storage.getPacketInstance(instanceId);

            if (instanceDataForPrompt && sidebarHandler.isSidePanelAvailable()) {
                sidebarHandler.notifySidebar('show_confetti', {
                    topic: instanceDataForPrompt.topic || ''
                });
            }

            if (!useGroups) {
                logger.log(logPrefix, `Tab groups disabled, skipping close prompt.`);
                return;
            }

            const browserState = await storage.getPacketBrowserState(instanceId);
            const groupId = browserState?.tabGroupId;
            if (groupId && typeof groupId === 'number' && groupId > 0) {
                try {
                    await chrome.tabGroups.get(groupId);
                    if (instanceDataForPrompt && sidebarHandler.isSidePanelAvailable()) {
                        sidebarHandler.notifySidebar('prompt_close_tab_group', {
                            instanceId: instanceId,
                            tabGroupId: groupId,
                            topic: instanceDataForPrompt.topic || 'this packet'
                        });
                    }
                } catch (groupError) {
                    logger.warn(logPrefix, `Tab group ${groupId} associated with completed packet no longer exists.`, groupError);
                }
            }
        } catch (error) {
            logger.error(logPrefix, `Error during completion prompt check for instance ${instanceId}`, error);
        }
    }
}

// --- REVISED Core Processing Logic ---
async function processNavigationEvent(tabId, finalUrl, sourceEventName, details = {}) {
    const logPrefix = `[Unpack NavigationHandler ${sourceEventName} Tab ${tabId}]`;
    
    // Always clear any pending timer for this tab on a new navigation event.
    clearPendingVisitTimer(tabId);

    let packetContext = await getPacketContext(tabId);
    // FIX: Keep the full URL, do not strip the hash here.
    const decodedFinalUrl = decodeURIComponent(finalUrl);

    if ((!packetContext || !packetContext.instanceId) && interimContextMap.has(tabId)) {
        packetContext = interimContextMap.get(tabId);
        logger.log(logPrefix, `Context restored from interim map.`, { packetContext });
        if (packetContext) {
            await setPacketContext(tabId, packetContext.instanceId, packetContext.packetUrl, decodedFinalUrl);
        }
        interimContextMap.delete(tabId);
    }

    if (!packetContext || !packetContext.instanceId) {
        logger.log(logPrefix, `No valid PacketContext found. Tab not tracked.`);
        await sidebarHandler.updateActionForTab(tabId);
        return;
    }

    const { instanceId, packetUrl: originalPacketUrl } = packetContext;
    const transitionType = details.transitionType || '';
    const transitionQualifiers = details.transitionQualifiers || [];

    logger.log(logPrefix, `Context found (Inst: ${instanceId}). Evt: ${sourceEventName}, URL: ${finalUrl}, Type: ${transitionType}, Quals: ${transitionQualifiers.join(',')}`);
    
    let instance = await storage.getPacketInstance(instanceId);
    if (!instance) {
        logger.warn(logPrefix, `Instance ${instanceId} not found. Clearing context.`);
        await clearPacketContext(tabId);
        await sidebarHandler.updateActionForTab(tabId);
        if (sidebarHandler.isSidePanelAvailable()) sidebarHandler.notifySidebar('update_sidebar_context', { tabId: tabId, instanceId: null });
        return;
    }
    
    let packetUrlForSidebar = originalPacketUrl;
    
    if (sourceEventName === 'HistoryStateUpdated' || transitionType === 'client_redirect') {
        logger.log(logPrefix, `Non-breaking navigation event ('${sourceEventName}', type: '${transitionType}'). Updating currentUrl only.`);
        await setPacketContext(tabId, instanceId, originalPacketUrl, decodedFinalUrl);
        const matchedItem = packetUtils.isUrlInPacket(decodedFinalUrl, instance, { returnItem: true });
        if (matchedItem) {
            packetUrlForSidebar = matchedItem.url;
        }

    } else if (sourceEventName === 'Committed') {
        const clearlyNavigatingAwayTypes = ['typed', 'auto_bookmark', 'generated', 'keyword', 'form_submit'];
        
        if (clearlyNavigatingAwayTypes.includes(transitionType) || (transitionType === 'link' && !transitionQualifiers.includes('client_redirect'))) {
            // FIX: Pass the full URL to isUrlInPacket
            const isNewUrlInPacket = packetUtils.isUrlInPacket(decodedFinalUrl, instance);
            
            if (!isNewUrlInPacket) {
                logger.log(logPrefix, `Context-breaking user transition: '${transitionType}'. URL is not in packet. Clearing context.`);
                await clearPacketContext(tabId);
                await sidebarHandler.updateActionForTab(tabId);
                if (sidebarHandler.isSidePanelAvailable()) sidebarHandler.notifySidebar('update_sidebar_context', { tabId: tabId, instanceId: null });
                return; 
            } else {
                // FIX: Pass the full URL to isUrlInPacket
                const matchedContentItem = packetUtils.isUrlInPacket(decodedFinalUrl, instance, { returnItem: true });
                if (matchedContentItem) {
                    packetUrlForSidebar = matchedContentItem.url;
                    logger.log(logPrefix, `User-driven navigation matches a packet item. New canonical packetUrl -> ${packetUrlForSidebar}`);
                    await setPacketContext(tabId, instanceId, packetUrlForSidebar, decodedFinalUrl);
                    await sidebarHandler.updateActionForTab(tabId);
                }
            }
        }
    }

    await updateBrowserStateAndGroups(tabId, instanceId, instance, decodedFinalUrl, packetUrlForSidebar);
    if (sidebarHandler.isSidePanelAvailable()) {
        sidebarHandler.notifySidebar('update_sidebar_context', {
            tabId, instanceId, instance, currentUrl: decodedFinalUrl, packetUrl: packetUrlForSidebar
        });
    }

    const canonicalUrlToVisit = packetUrlForSidebar;
    const itemToVisit = instance.contents.find(item => item.url && decodeURIComponent(item.url) === decodeURIComponent(canonicalUrlToVisit));

    if (itemToVisit && !itemToVisit.interactionBasedCompletion) {

        const settings = await storage.getSettings();
        const visitThresholdMs = (settings.visitThresholdSeconds ?? 5) * 1000;
        const visitTimer = setTimeout(async () => {
            pendingVisitTimers.delete(tabId); 
            try {
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (activeTab && activeTab.id === tabId) {
                    logger.log(logPrefix, `Tab ${tabId} still active after ${visitThresholdMs}ms. Marking '${canonicalUrlToVisit}' as visited.`);
                    const visitResult = await packetUtils.markUrlAsVisited(instanceId, canonicalUrlToVisit);
                    if (visitResult.success && visitResult.modified) {
                        const updatedInstance = visitResult.instance || await storage.getPacketInstance(instanceId);
                        if (sidebarHandler.isSidePanelAvailable()) {
                            sidebarHandler.notifySidebar('update_sidebar_context', {
                                tabId, instanceId, instance: updatedInstance, currentUrl: finalUrl, packetUrl: canonicalUrlToVisit
                            });
                        }
                        await checkAndPromptForCompletion(logPrefix, visitResult, instanceId);
                    }
                } else {
                    logger.log(logPrefix, `Tab ${tabId} is no longer active. Visit not marked.`);
                }
            } catch (error) {
                logger.error(logPrefix, 'Error in delayed visit marking.', error);
            }
        }, visitThresholdMs);

        pendingVisitTimers.set(tabId, visitTimer);
        logger.log(logPrefix, `Scheduled visit check for tab ${tabId} in ${visitThresholdMs}ms.`);
    }
}


async function updateBrowserStateAndGroups(tabId, instanceId, instance, currentBrowserUrl, currentPacketUrl) {
    if (!instance) return; 
    const logPrefix = `[Unpack NavigationHandler UpdateState Tab ${tabId}]`;
    let browserState = null;
    let stateModified = false;
    try {
        browserState = await storage.getPacketBrowserState(instanceId);
        if (!browserState) { browserState = { instanceId: instanceId, tabGroupId: null, activeTabIds: [], lastActiveUrl: null }; stateModified = true; }
        
        if (browserState.lastActiveUrl !== currentBrowserUrl) { browserState.lastActiveUrl = currentBrowserUrl; stateModified = true; }
        if (!browserState.activeTabIds.includes(tabId)) { browserState.activeTabIds.push(tabId); stateModified = true; }
        
        const useTabGroups = await shouldUseTabGroups();
        if (useTabGroups) {
           const ensuredGroupId = await tabGroupHandler.ensureTabInGroup(tabId, instanceId);
           const potentiallyUpdatedBrowserState = await storage.getPacketBrowserState(instanceId);
           if (potentiallyUpdatedBrowserState) {
               browserState = potentiallyUpdatedBrowserState; 
           }
           if (browserState.tabGroupId !== ensuredGroupId && ensuredGroupId !== null) {
               browserState.tabGroupId = ensuredGroupId;
               stateModified = true;
           }
           
           if (browserState.tabGroupId && instance) { 
               await tabGroupHandler.orderTabsInGroup(browserState.tabGroupId, instance);
               await tabGroupHandler.deduplicateUrlInGroup(browserState.tabGroupId, instanceId, tabId);
           } else if (browserState.tabGroupId) {
               logger.warn(logPrefix, `Cannot order/deduplicate tabs, instance data missing for group ${browserState.tabGroupId}.`);
           }
       } else { 
           if (browserState.tabGroupId !== null) { 
               logger.log(logPrefix, `Tab groups disabled, nullifying groupId for instance ${instanceId}.`); 
               browserState.tabGroupId = null; 
               stateModified = true; 
           } 
       }
       if (stateModified) { 
           logger.log(logPrefix, `Saving modified browser state...`, browserState); 
           await storage.savePacketBrowserState(browserState); 
       }
    } catch (error) { logger.error(logPrefix, 'Error updating browser state/groups', { instanceId, error }); }
}