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

export { clearPacketContext };

function parseMpiEventFromUrl(url) {
    try {
        if (!url || !url.includes('#')) return null;
        const hash = url.substring(url.indexOf('#') + 1);
        const params = new URLSearchParams(hash);

        if (params.get(MPI_PARAMS.MARKER) === 'true') {
            const instanceId = params.get(MPI_PARAMS.INSTANCE_ID);
            const pageId = params.get(MPI_PARAMS.PAGE_ID);
            const eventName = params.get(MPI_PARAMS.EVENT_NAME);

            if (instanceId && pageId && eventName) {
                return { instanceId, pageId, eventName };
            }
        }
        return null;
    } catch (e) {
        logger.warn('NavigationHandler:parseMpiEvent', 'Error parsing MPI event from URL hash', { url, error: e });
        return null;
    }
}


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

            // Notify sidebar to show confetti
            if (instanceDataForPrompt && sidebarHandler.isSidePanelAvailable()) {
                const colorName = packetUtils.getColorForTopic(instanceDataForPrompt.topic);
                // This assumes a color map is available via packetUtils, let's pretend it is for now.
                // A better implementation would have this map in a shared config.
                // For now, we'll just send the color name.
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

// --- Core Processing Logic ---
async function processNavigationEvent(tabId, finalUrl, sourceEventName, details = {}) {
    const logPrefix = `[Unpack NavigationHandler ${sourceEventName} Tab ${tabId}]`;
    
    let packetContext = await getPacketContext(tabId);
    const decodedFinalUrl = decodeURIComponent(finalUrl);

     // --- Start of FIX ---
    // If context isn't in storage yet, check the interim map.
    if ((!packetContext || !packetContext.instanceId) && interimContextMap.has(tabId)) {
        packetContext = interimContextMap.get(tabId);
        logger.log(logPrefix, `Context restored from interim map.`, { packetContext });
        // Immediately persist this context so subsequent events don't need the map
        if (packetContext) {
            await setPacketContext(tabId, packetContext.instanceId, packetContext.packetUrl, decodedFinalUrl);
        }
        // Important: Consume the one-time context from the map
        interimContextMap.delete(tabId);
    }
    // --- End of FIX ---

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
        await sidebarHandler.updateActionForTab(tabId); // Update action to default
        if (sidebarHandler.isSidePanelAvailable()) sidebarHandler.notifySidebar('update_sidebar_context', { tabId: tabId, instanceId: null });
        return;
    }
    
    let visitResult = null;
    let packetUrlForSidebar = originalPacketUrl;
    let instanceForSidebar = instance;
    
    if (sourceEventName === 'HistoryStateUpdated') {
        logger.log(logPrefix, `HistoryStateUpdated event. Updating currentUrl but preserving original packetUrl.`);
        await setPacketContext(tabId, instanceId, originalPacketUrl, decodedFinalUrl);
    } else if (sourceEventName === 'Committed') {
        
        const clearlyNavigatingAwayTypes = ['typed', 'auto_bookmark', 'generated', 'keyword', 'form_submit'];
        
        if (clearlyNavigatingAwayTypes.includes(transitionType)) {
            const isReloadingPacketUrl = packetUtils.isUrlInPacket(decodedFinalUrl, instance);

            if (!isReloadingPacketUrl) {
                logger.log(logPrefix, `Context-breaking transition type: '${transitionType}'. Clearing context.`);
                await clearPacketContext(tabId);
                await sidebarHandler.updateActionForTab(tabId); // Update action to default
                if (sidebarHandler.isSidePanelAvailable()) sidebarHandler.notifySidebar('update_sidebar_context', { tabId: tabId, instanceId: null });
                return;
            }
            logger.log(logPrefix, `Transition '${transitionType}' was for a URL within the packet. Preserving context.`);
        }

        const matchedContentItem = packetUtils.isUrlInPacket(decodedFinalUrl, instance, { returnItem: true });

        if (matchedContentItem) {
            packetUrlForSidebar = matchedContentItem.url;
            logger.log(logPrefix, `Navigation matches a packet item. New canonical packetUrl -> ${packetUrlForSidebar}`);
            await setPacketContext(tabId, instanceId, packetUrlForSidebar, decodedFinalUrl);
            await sidebarHandler.updateActionForTab(tabId); // Update action for packet tab
        } else {
            logger.log(logPrefix, `URL external to packet: ${decodedFinalUrl}.`);
            
            const useTabGroups = await shouldUseTabGroups();
            if (useTabGroups) {
                const browserState = await storage.getPacketBrowserState(instanceId);
                if (browserState && browserState.tabGroupId) {
                    const groupIdToCollapse = browserState.tabGroupId;
                    try {
                        const tab = await chrome.tabs.get(tabId);
                        if (tab.groupId === groupIdToCollapse) {
                            logger.log(logPrefix, `Ungrouping tab ${tabId} from group ${groupIdToCollapse}.`);
                            await chrome.tabs.ungroup(tabId);

                            logger.log(logPrefix, `Collapsing group ${groupIdToCollapse} after external navigation.`);
                            await chrome.tabGroups.update(groupIdToCollapse, { collapsed: true });

                            const initialLength = browserState.activeTabIds.length;
                            browserState.activeTabIds = browserState.activeTabIds.filter(id => id !== tabId);
                            if (browserState.activeTabIds.length !== initialLength) {
                                await storage.savePacketBrowserState(browserState);
                                logger.log(logPrefix, `Removed tab ${tabId} from activeTabIds for instance ${instanceId}.`);
                            }
                        }
                    } catch (e) {
                        logger.error(logPrefix, `Error ungrouping tab or collapsing group ${groupIdToCollapse}`, e);
                    }
                }
            }
            
            logger.log(logPrefix, `Clearing context for tab ${tabId}.`);
            await clearPacketContext(tabId);
            await sidebarHandler.updateActionForTab(tabId); // Update action to default
            if (sidebarHandler.isSidePanelAvailable()) sidebarHandler.notifySidebar('update_sidebar_context', { tabId: tabId, instanceId: null });
            return;
        }
    }

    const canonicalUrlToVisit = packetUrlForSidebar;
    const itemToVisit = instance.contents.find(item => item.url && decodeURIComponent(item.url) === decodeURIComponent(canonicalUrlToVisit));

    // Only mark as visited on navigation if the item does NOT require an interaction event.
    if (itemToVisit && !itemToVisit.interactionBasedCompletion) {
        visitResult = await packetUtils.markUrlAsVisited(instanceId, canonicalUrlToVisit);
        if (visitResult.modified && sidebarHandler.isSidePanelAvailable()) {
            sidebarHandler.notifySidebar('url_visited', { packetId: instanceId, url: canonicalUrlToVisit });
        }
        instanceForSidebar = visitResult.instance || instanceForSidebar;
        await checkAndPromptForCompletion(logPrefix, visitResult, instanceId);
    }

    await updateBrowserStateAndGroups(tabId, instanceId, instanceForSidebar, decodedFinalUrl, packetUrlForSidebar);
    if (sidebarHandler.isSidePanelAvailable()) {
        sidebarHandler.notifySidebar('update_sidebar_context', {
            tabId,
            instanceId,
            instance: instanceForSidebar,
            currentUrl: decodedFinalUrl,
            packetUrl: packetUrlForSidebar
        });
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