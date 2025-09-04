// ext/background-modules/navigation-handler.js
// FINAL FIX: Moved the clearPendingVisitTimer call to the absolute beginning of the
// navigation event processing to definitively fix a race condition where a slow timer
// could mark the wrong page as visited during rapid navigation.
// REVISED: If a tab's context is cleared, but media is actively playing, the
// sidebar context will be overridden to "stick" to the playing packet.
// REVISED: Prevent reconcileBrowserState from running when context is overridden for
// media playback, to allow tabs to be correctly ejected from groups.
// REVISED: Refreshing a cached internal page now correctly preserves the tab's context
// by setting a trusted intent before redirecting to a blob: URL and then bypassing the
// demotion check for blob URLs.

import {
    logger,
    storage,
    packetUtils,
    shouldUseTabGroups,
    getPacketContext,
    setPacketContext,
    clearPacketContext,
    indexedDbStorage,
    sanitizeForFileName
} from '../utils.js';
import {
    activeMediaPlayback,
    resetActiveMediaPlayback,
    setMediaPlaybackState,
    setupOffscreenDocument
} from '../background.js';
import * as sidebarHandler from './sidebar-handler.js';
import * as tabGroupHandler from './tab-group-handler.js';
import { ensureHtmlIsCached } from './message-handlers.js';

const pendingVisits = {};
const pendingNavigationActionTimers = new Map();
let mostRecentInstance = null; // Cache for the most recently handled instance

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

export async function onBeforeNavigate(details) {
    if (details.frameId !== 0 || !details.url || !details.url.startsWith('http')) {
        return;
    }

    const context = await getPacketContext(details.tabId);
    if (!context || !context.instanceId) {
        return;
    }

    const instance = await storage.getPacketInstance(context.instanceId);
    const targetItem = packetUtils.isUrlInPacket(details.url, instance, { returnItem: true });

    if (targetItem && targetItem.cacheable && targetItem.lrl) {
        const indexedDbKey = sanitizeForFileName(targetItem.lrl);
        const cachedContent = await indexedDbStorage.getGeneratedContent(instance.instanceId, indexedDbKey);

        if (cachedContent && cachedContent[0]?.content) {
            logger.log('NavigationHandler:onBeforeNavigate', `Intercepting navigation to cached item: ${targetItem.title}`);
            
            const fullHtml = new TextDecoder().decode(cachedContent[0].content);
            
            await setupOffscreenDocument();
            const offscreenResponse = await chrome.runtime.sendMessage({
                target: 'offscreen',
                type: 'create-blob-url',
                data: { html: fullHtml }
            });

            if (offscreenResponse.success) {
                const trustedIntent = {
                    instanceId: instance.instanceId,
                    canonicalPacketUrl: targetItem.url
                };
                await storage.setSession({ [`trusted_intent_${details.tabId}`]: trustedIntent });
                logger.log('NavigationHandler:onBeforeNavigate', `Setting trusted intent for blob URL redirect.`, { tabId: details.tabId });

                chrome.tabs.update(details.tabId, { url: offscreenResponse.blobUrl });
            }
        }
    }
}

export async function onCommitted(details) {
    if (details.frameId !== 0) return;
    const url = details.url;
    if (!url || (!url.startsWith('http') && !url.startsWith('blob:chrome-extension://'))) return;
    
    logger.log(`[NavigationHandler Tab ${details.tabId}]`, `onCommitted event fired for URL: ${url}`);
    await processNavigationEvent(details.tabId, url, details);
}

export async function onHistoryStateUpdated(details) {
    if (details.frameId !== 0) return;
    const url = details.url;
    if (!url || (!url.startsWith('http') && !url.startsWith('blob:chrome-extension://'))) return;

    logger.log(`[NavigationHandler Tab ${details.tabId}]`, `onHistoryStateUpdated event fired for URL: ${url}`);
    await processNavigationEvent(details.tabId, url, details);
}

export async function checkAndPromptForCompletion(logPrefix, visitResult, instanceId) {
    if (visitResult?.success && visitResult?.justCompleted) {
        const instanceData = visitResult.instance || await storage.getPacketInstance(instanceId);
        if (!instanceData || instanceData.completionAcknowledged) {
            if(instanceData) logger.log('NavigationHandler', 'Completion already acknowledged for instance:', instanceId);
            return;
        }
        logger.log('NavigationHandler', 'Packet just completed. Acknowledging and showing prompt.', instanceId);

        if (sidebarHandler.isSidePanelAvailable()) {
            sidebarHandler.notifySidebar('show_confetti', { title: instanceData.title || '', instanceId: instanceId });
            
            if (await shouldUseTabGroups()) {
                const browserState = await storage.getPacketBrowserState(instanceId);
                if (browserState?.tabGroupId) {
                    sidebarHandler.notifySidebar('prompt_close_tab_group', {
                        instanceId: instanceId,
                        tabGroupId: browserState.tabGroupId,
                        topic: instanceData.title || 'this packet'
                    });
                }
            }
        }

        instanceData.completionAcknowledged = true;
        await storage.savePacketInstance(instanceData);
        sidebarHandler.notifySidebar('packet_instance_updated', { instance: instanceData, source: 'completion_ack' });
        
        if (activeMediaPlayback.instanceId === instanceId) {
            await resetActiveMediaPlayback();
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
                if (finalUrl.startsWith('blob:')) {
                    logger.log(logPrefix, 'DECISION: Navigation is to an internally-redirected blob URL. Preserving context.');
                } else {
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
    }

    let finalContext = await getPacketContext(tabId);
    logger.log(logPrefix, 'Final context after logic:', finalContext);
    let finalInstance = finalContext ? await storage.getPacketInstance(finalContext.instanceId) : null;
    let isContextOverriddenForMedia = false; // NEW: Flag to track context override
    
    if (activeMediaPlayback.instanceId) {
        if (!finalInstance) {
            finalInstance = activeMediaPlayback.instance;
            finalContext = null; 
            isContextOverriddenForMedia = true; // NEW: Set flag
            logger.log(logPrefix, 'Tab has no context, but media is playing. Overriding sidebar context.');
        } else if (finalInstance.instanceId === activeMediaPlayback.instanceId) {
            finalInstance = activeMediaPlayback.instance;
            logger.log(logPrefix, 'Using live instance data from activeMediaPlayback for focused tab.');
        }
    }
    
    mostRecentInstance = finalInstance;

    let image = finalInstance ? await storage.getPacketImage(finalInstance.imageId) : null;

    if (finalInstance && image) {
        const loadedItem = finalContext ? finalInstance.contents.find(item => item.url === finalContext.canonicalPacketUrl) : null;
        if (loadedItem) {
            let momentTripped = false;
            (finalInstance.moments || []).forEach((moment, index) => {
                if (moment.type === 'visit' && moment.sourceUrl === loadedItem.lrl && finalInstance.momentsTripped[index] === 0) {
                    finalInstance.momentsTripped[index] = 1;
                    momentTripped = true;
                    logger.log('MomentLogger:Visit', `Tripping Moment #${index} due to navigation`, {
                        instanceId: finalInstance.instanceId,
                        visitedUrl: loadedItem.url
                    });
                    logger.log(logPrefix, `DECISION: Navigation to page with URL ${loadedItem.url} is tripping moment ${index}.`);
                }
            });
            if (momentTripped) {
                await storage.savePacketInstance(finalInstance);
                if (activeMediaPlayback.instanceId === finalInstance.instanceId) {
                    activeMediaPlayback.instance = finalInstance;
                }
                sidebarHandler.notifySidebar('moment_tripped', {
                    instanceId: finalInstance.instanceId,
                    instance: finalInstance,
                });
            }
        }

        // MODIFIED: Only reconcile browser state if context isn't an override
        if (!isContextOverriddenForMedia) {
            await reconcileBrowserState(tabId, finalInstance.instanceId, finalInstance, finalUrl);
        }

        const canonicalUrlForVisit = finalContext ? finalContext.canonicalPacketUrl : null;
        const itemForVisitTimer = canonicalUrlForVisit ? finalInstance.contents.find(i => i.url === canonicalUrlForVisit) : null;

        if (itemForVisitTimer && !itemForVisitTimer.interactionBasedCompletion) {
            startVisitTimer(tabId, finalInstance.instanceId, itemForVisitTimer.url, logPrefix);
        }
        
        if (itemForVisitTimer && itemForVisitTimer.cacheable && itemForVisitTimer.lrl && !finalUrl.startsWith('blob:')) {
            ensureHtmlIsCached(finalInstance.instanceId, itemForVisitTimer.url, itemForVisitTimer.lrl).catch(err => {
                logger.error(logPrefix, `Background caching failed for ${itemForVisitTimer.lrl}`, err);
            });
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
                
                let instanceToUpdate = null;
                if (mostRecentInstance && mostRecentInstance.instanceId === instanceId) {
                    instanceToUpdate = mostRecentInstance;
                } else if (activeMediaPlayback.instanceId === instanceId) {
                    instanceToUpdate = activeMediaPlayback.instance;
                } else {
                    instanceToUpdate = await storage.getPacketInstance(instanceId);
                }
                
                if (!instanceToUpdate) {
                    logger.warn(logPrefix, "Instance not found when visit timer fired.", { instanceId });
                    return;
                }

                const visitResult = await packetUtils.markUrlAsVisited(instanceToUpdate, canonicalPacketUrl);

                if (visitResult.success && visitResult.modified) {
                    const updatedInstance = visitResult.instance; 
                    
                    await storage.savePacketInstance(updatedInstance);
                    
                    mostRecentInstance = updatedInstance;
                    if (activeMediaPlayback.instanceId === instanceId) {
                        activeMediaPlayback.instance = updatedInstance;
                    }

                    sidebarHandler.notifySidebar('packet_instance_updated', { instance: updatedInstance, source: 'dwell_visit' });
                    
                    await checkAndPromptForCompletion(logPrefix, visitResult, instanceId);
                }
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