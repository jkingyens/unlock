// ext/background-modules/navigation-handler.js
// FINAL FIX: Moved the clearPendingVisitTimer call to the absolute beginning of the
// navigation event processing to definitively fix a race condition where a slow timer
// could mark the wrong page as visited during rapid navigation.

import {
    logger,
    storage,
    packetUtils,
    shouldUseTabGroups,
    getPacketContext,
    setPacketContext,
    clearPacketContext,
} from '../utils.js';
import {
    activeMediaPlayback,
    resetActiveMediaPlayback,
    setMediaPlaybackState
} from '../background.js';
import * as sidebarHandler from './sidebar-handler.js';
import * as tabGroupHandler from './tab-group-handler.js';

const pendingVisits = {};
const pendingNavigationActionTimers = new Map();

export function clearPendingVisitTimer(tabId) {
    if (pendingVisits[tabId]?.timerId) {
        clearTimeout(pendingVisits[tabId].timerId);
        delete pendingVisits[tabId];
    }
}

function clearPendingNavigationActionTimer(tabId) {
    if (pendingNavigationActionTimers.has(tabId)) {
        clearTimeout(pendingNavigationActionTimers.get(tabId));
        pendingNavigationActionTimers.delete(tabId);
    }
}

async function injectOverlayScripts(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['overlay.js']
        });
        await chrome.scripting.insertCSS({
            target: { tabId: tabId },
            files: ['overlay.css']
        });
    } catch (e) {
        // This is expected to fail on chrome:// pages, store pages, etc.
    }
}

export async function onCommitted(details) {
    if (details.frameId !== 0 || !details.url?.startsWith('http')) return;
    logger.log(`[NavigationHandler Tab ${details.tabId}]`, `onCommitted event fired for URL: ${details.url}`);
    await processNavigationEvent(details.tabId, details.url, details);
}

export async function onHistoryStateUpdated(details) {
    if (details.frameId !== 0 || !details.url?.startsWith('http')) return;
    logger.log(`[NavigationHandler Tab ${details.tabId}]`, `onHistoryStateUpdated event fired for URL: ${details.url}`);
    await processNavigationEvent(details.tabId, details.url, details);
}

export async function checkAndPromptForCompletion(logPrefix, visitResult, instanceId) {
    if (visitResult?.success && visitResult?.justCompleted) {
        const instanceData = visitResult.instance || await storage.getPacketInstance(instanceId);
        if (!instanceData || instanceData.completionAcknowledged) {
            if(instanceData) logger.log('NavigationHandler', 'Completion already acknowledged for instance:', instanceId);
            return;
        }
        logger.log('NavigationHandler', 'Packet just completed. Acknowledging and showing prompt.', instanceId);
        instanceData.completionAcknowledged = true;
        await storage.savePacketInstance(instanceData);
        sidebarHandler.notifySidebar('packet_instance_updated', { instance: instanceData, source: 'completion_ack' });
        if (activeMediaPlayback.instanceId === instanceId) {
            await resetActiveMediaPlayback();
        }
        if (sidebarHandler.isSidePanelAvailable()) {
            sidebarHandler.notifySidebar('show_confetti', { topic: instanceData.topic || '', instanceId: instanceId });
            if (await shouldUseTabGroups()) {
                const browserState = await storage.getPacketBrowserState(instanceId);
                if (browserState?.tabGroupId) {
                    sidebarHandler.notifySidebar('prompt_close_tab_group', {
                        instanceId: instanceId,
                        tabGroupId: browserState.tabGroupId,
                        topic: instanceData.topic || 'this packet'
                    });
                }
            }
        }
    }
}

async function processNavigationEvent(tabId, finalUrl, details) {
    const logPrefix = `[NavigationHandler Tab ${tabId}]`;
    
    clearPendingVisitTimer(tabId);
    logger.log(logPrefix, 'Cleared any pending visit timers for this tab.');

    logger.log(logPrefix, '>>> NAVIGATION EVENT START <<<', { url: finalUrl, transition: `${details.transitionType} | ${details.transitionQualifiers.join(', ')}` });
    await injectOverlayScripts(tabId);

    const trustedIntentKey = `trusted_intent_${tabId}`;
    const sessionData = await storage.getSession(trustedIntentKey);
    const trustedContext = sessionData[trustedIntentKey];

    if (trustedContext) {
        logger.log(logPrefix, 'DECISION: Found trusted intent token. Stamping tab context and setting grace period.');
        await setPacketContext(tabId, trustedContext.instanceId, trustedContext.canonicalPacketUrl, finalUrl);
        await storage.setSession({ [`grace_period_${tabId}`]: Date.now() });
        setTimeout(() => storage.removeSession(`grace_period_${tabId}`), 250);
        await storage.removeSession(trustedIntentKey);
    }

    let currentContext = await getPacketContext(tabId);
    logger.log(logPrefix, 'Current context on record:', currentContext);

    if (currentContext) {
        const gracePeriodKey = `grace_period_${tabId}`;
        const graceData = await storage.getSession(gracePeriodKey);
        if (graceData[gracePeriodKey]) {
            const age = Date.now() - graceData[gracePeriodKey];
            logger.log(logPrefix, `DECISION: Grace period is active (${age}ms old). Preserving original context and updating URL.`);
            await setPacketContext(tabId, currentContext.instanceId, currentContext.canonicalPacketUrl, finalUrl);
        } else {
            const isUserInitiated = ['link', 'typed', 'auto_bookmark', 'generated', 'keyword', 'form_submit'].includes(details.transitionType);
            logger.log(logPrefix, `Is this a user-initiated navigation? -> ${isUserInitiated}`);

            if (isUserInitiated) {
                const instance = await storage.getPacketInstance(currentContext.instanceId);
                const newItemInPacket = packetUtils.isUrlInPacket(finalUrl, instance, { returnItem: true });

                if (newItemInPacket && newItemInPacket.url !== currentContext.canonicalPacketUrl) {
                    let duplicateTab = null;
                    const allTabs = await chrome.tabs.query({});
                    for (const tab of allTabs) {
                        if (tab.id !== tabId) {
                            const otherContext = await getPacketContext(tab.id);
                            if (otherContext?.instanceId === currentContext.instanceId && otherContext?.canonicalPacketUrl === newItemInPacket.url) {
                                duplicateTab = tab;
                                break;
                            }
                        }
                    }

                    if (duplicateTab) {
                        logger.log(logPrefix, `DECISION: Found duplicate tab ${duplicateTab.id}. Closing it.`);
                        await chrome.tabs.remove(duplicateTab.id);
                    }
                    
                    logger.log(logPrefix, 'DECISION: Re-stamping tab context for in-packet navigation and starting grace period.');
                    await setPacketContext(tabId, currentContext.instanceId, newItemInPacket.url, finalUrl);
                    await storage.setSession({ [`grace_period_${tabId}`]: Date.now() });
                    setTimeout(() => storage.removeSession(`grace_period_${tabId}`), 250);

                } else if (!newItemInPacket) {
                    logger.log(logPrefix, 'DECISION: User navigated to a URL outside the packet. Demoting tab.');
                    await clearPacketContext(tabId);
                    if (await shouldUseTabGroups()) {
                        await tabGroupHandler.ejectTabFromGroup(tabId, currentContext.instanceId);
                    }
                } else {
                    logger.log(logPrefix, 'DECISION: Navigation is to the same packet item or a non-item URL that was not user-initiated. No context change needed.');
                }
            }
        }
    }

    const finalContext = await getPacketContext(tabId);
    logger.log(logPrefix, 'Final context after logic:', finalContext);
    let finalInstance = finalContext ? await storage.getPacketInstance(finalContext.instanceId) : null;
    let image = finalInstance ? await storage.getPacketImage(finalInstance.imageId) : null;


    if (finalInstance && image) {
        const loadedItem = finalInstance.contents.find(item => item.url === finalContext.canonicalPacketUrl);
        if (loadedItem) {
            let momentTripped = false;
            (image.moments || []).forEach((moment, index) => {
                if (moment.type === 'visit' && moment.sourcePageId === loadedItem.pageId && finalInstance.momentsTripped[index] === 0) {
                    finalInstance.momentsTripped[index] = 1;
                    momentTripped = true;
                    logger.log(logPrefix, `DECISION: Navigation to page ${loadedItem.pageId} is tripping moment ${index}.`);
                }
            });
            if (momentTripped) {
                await storage.savePacketInstance(finalInstance);
                sidebarHandler.notifySidebar('moment_tripped', {
                    instanceId: finalInstance.instanceId,
                    instance: finalInstance,
                });
            }
        }

        await reconcileBrowserState(tabId, finalInstance.instanceId, finalInstance, finalUrl);
        const canonicalUrlForVisit = finalContext.canonicalPacketUrl;
        const itemForVisitTimer = finalInstance.contents.find(i => i.url === canonicalUrlForVisit);

        if (itemForVisitTimer && !itemForVisitTimer.interactionBasedCompletion) {
            startVisitTimer(tabId, finalInstance.instanceId, itemForVisitTimer.url, logPrefix);
        }
    }

    if (sidebarHandler.isSidePanelAvailable()) {
        sidebarHandler.notifySidebar('update_sidebar_context', {
            tabId,
            instanceId: finalInstance ? finalInstance.instanceId : null,
            instance: finalInstance,
            packetUrl: finalContext ? finalContext.canonicalPacketUrl : null,
            currentUrl: finalUrl
        });
    }
    await sidebarHandler.updateActionForTab(tabId);
    logger.log(logPrefix, '>>> NAVIGATION EVENT END <<<');
}

async function reconcileBrowserState(tabId, instanceId, instance, currentBrowserUrl) {
    if (!instance) return;
    let browserState = await storage.getPacketBrowserState(instanceId) || { instanceId, tabGroupId: null, activeTabIds: [], lastActiveUrl: null };
    let stateModified = false;

    if (browserState.lastActiveUrl !== currentBrowserUrl) {
        browserState.lastActiveUrl = currentBrowserUrl;
        stateModified = true;
    }
    if (!browserState.activeTabIds.includes(tabId)) {
        browserState.activeTabIds.push(tabId);
        stateModified = true;
    }

    if (await shouldUseTabGroups()) {
        const ensuredGroupId = await tabGroupHandler.ensureTabInGroup(tabId, instanceId);
        if (browserState.tabGroupId !== ensuredGroupId && ensuredGroupId !== null) {
            browserState.tabGroupId = ensuredGroupId;
            stateModified = true;
        }
        if (browserState.tabGroupId) {
            await tabGroupHandler.orderTabsInGroup(browserState.tabGroupId, instance);
        }
    }

    if (stateModified) {
        await storage.savePacketBrowserState(browserState);
    }
}

export async function startVisitTimer(tabId, instanceId, canonicalPacketUrl, logPrefix) {
    const settings = await storage.getSettings();
    const visitThresholdMs = (settings.visitThresholdSeconds ?? 5) * 1000;

    logger.log(logPrefix, `Starting visit timer for ${visitThresholdMs}ms.`, { canonicalPacketUrl });

    const visitTimer = setTimeout(async () => {
        delete pendingVisits[tabId]; 
        try {
            const tab = await chrome.tabs.get(tabId);
            if (tab && tab.active) {
                logger.log(logPrefix, 'Visit timer fired for active tab. Marking as visited.');
                
                // --- START OF THE FIX ---
                let instanceToUpdate = (activeMediaPlayback.instanceId === instanceId)
                    ? activeMediaPlayback.instance
                    : await storage.getPacketInstance(instanceId);
                
                if (!instanceToUpdate) {
                    logger.warn(logPrefix, "Instance not found when visit timer fired.", { instanceId });
                    return;
                }

                const visitResult = await packetUtils.markUrlAsVisited(instanceToUpdate, canonicalPacketUrl);

                if (visitResult.success && visitResult.modified) {
                    const updatedInstance = visitResult.instance; 
                    
                    await storage.savePacketInstance(updatedInstance);
                    
                    if (activeMediaPlayback.instanceId === instanceId) {
                        activeMediaPlayback.instance = updatedInstance;
                    }

                    sidebarHandler.notifySidebar('packet_instance_updated', { instance: updatedInstance, source: 'dwell_visit' });
                    
                    if (activeMediaPlayback.instanceId !== instanceId) {
                        await setMediaPlaybackState({ instanceId: instanceId, tabId: tabId, topic: updatedInstance.topic }, { showVisitedAnimation: true, source: 'dwell_visit' });
                    }
                    await checkAndPromptForCompletion(logPrefix, visitResult, instanceId);
                }
                 // --- END OF THE FIX ---
            } else {
                 logger.log(logPrefix, 'Visit timer fired, but tab was not active. Visit not marked.');
            }
        } catch (error) {
            if (!error.message.toLowerCase().includes('no tab with id')) {
                logger.error(logPrefix, 'Error in delayed visit marking.', error);
            }
        }
    }, visitThresholdMs);

    pendingVisits[tabId] = {
        timerId: visitTimer,
        intendedUrl: canonicalPacketUrl
    };
}