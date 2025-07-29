// ext/background-modules/navigation-handler.js

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

const pendingVisitTimers = new Map();
const pendingNavigationActionTimers = new Map();

export function clearPendingVisitTimer(tabId) {
    if (pendingVisitTimers.has(tabId)) {
        clearTimeout(pendingVisitTimers.get(tabId));
        pendingVisitTimers.delete(tabId);
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
    await processNavigationEvent(details.tabId, details.url, details);
}

export async function onHistoryStateUpdated(details) {
    if (details.frameId !== 0 || !details.url?.startsWith('http')) return;
    await processNavigationEvent(details.tabId, details.url, details);
}

export async function checkAndPromptForCompletion(logPrefix, visitResult, instanceId) {
    if (visitResult?.success && visitResult?.justCompleted) {
        if (activeMediaPlayback.instanceId === instanceId) {
            logger.log('NavigationHandler', 'Completed packet was the active media packet. Resetting player state.');
            await resetActiveMediaPlayback();
        }
        const instanceDataForPrompt = visitResult.instance || await storage.getPacketInstance(instanceId);
        if (instanceDataForPrompt && sidebarHandler.isSidePanelAvailable()) {
            sidebarHandler.notifySidebar('show_confetti', { topic: instanceDataForPrompt.topic || '' });
            if (await shouldUseTabGroups()) {
                const browserState = await storage.getPacketBrowserState(instanceId);
                if (browserState?.tabGroupId) {
                    sidebarHandler.notifySidebar('prompt_close_tab_group', {
                        instanceId: instanceId,
                        tabGroupId: browserState.tabGroupId,
                        topic: instanceDataForPrompt.topic || 'this packet'
                    });
                }
            }
        }
    }
}

async function processNavigationEvent(tabId, finalUrl, details) {
    const logPrefix = `[NavigationHandler Tab ${tabId}]`;
    // --- FIX: Declare sessionData at the top of the function scope ---
    let sessionData;
    
    logger.log(logPrefix, '>>> NAVIGATION EVENT START <<<', {
        url: finalUrl,
        transition: `${details.transitionType} | ${details.transitionQualifiers.join(', ')}`,
        details: details
    });

    await injectOverlayScripts(tabId);
    clearPendingVisitTimer(tabId);

    const trustedIntentKey = `trusted_intent_${tabId}`;
    sessionData = await storage.getSession(trustedIntentKey);
    const trustedContext = sessionData[trustedIntentKey];

    if (trustedContext) {
        logger.log(logPrefix, 'DECISION: Found trusted intent token. Stamping tab context and setting grace period.');
        await setPacketContext(tabId, trustedContext.instanceId, trustedContext.canonicalPacketUrl, finalUrl);
        await storage.setSession({ [`grace_period_${tabId}`]: Date.now() });
        setTimeout(() => storage.removeSession(`grace_period_${tabId}`), 1500);
        await storage.removeSession(trustedIntentKey);
    }

    let currentContext = await getPacketContext(tabId);
    logger.log(logPrefix, 'Current context on record:', currentContext);

    if (currentContext) {
        // Step 3a: Check if we are within the grace period.
        const gracePeriodKey = `grace_period_${tabId}`;
        sessionData = await storage.getSession(gracePeriodKey); // This line was causing the error
        if (sessionData[gracePeriodKey]) {
            const age = Date.now() - sessionData[gracePeriodKey];
            logger.log(logPrefix, `DECISION: Grace period is active (${age}ms old). Preserving original context and updating URL.`);
            await setPacketContext(tabId, currentContext.instanceId, currentContext.canonicalPacketUrl, finalUrl);
        } else {
            // Step 3b: Grace period is over. Handle as a normal navigation.
            const isUserInitiated = ['link', 'typed', 'auto_bookmark', 'generated', 'keyword', 'form_submit'].includes(details.transitionType);
            logger.log(logPrefix, `Is this a user-initiated navigation? -> ${isUserInitiated}`);

            if (isUserInitiated) {
                const instance = await storage.getPacketInstance(currentContext.instanceId);
                const newItemInPacket = packetUtils.isUrlInPacket(finalUrl, instance, { returnItem: true });

                if (newItemInPacket && newItemInPacket.url !== currentContext.canonicalPacketUrl) {
                    // --- Start Duplicate Tab Cleanup Logic ---
                    let duplicateTab = null;
                    const allTabs = await chrome.tabs.query({});
                    for (const tab of allTabs) {
                        if (tab.id !== tabId) { // Don't check against the current tab
                            const otherContext = await getPacketContext(tab.id);
                            if (otherContext && otherContext.instanceId === currentContext.instanceId && otherContext.canonicalPacketUrl === newItemInPacket.url) {
                                duplicateTab = tab;
                                break;
                            }
                        }
                    }

                    if (duplicateTab) {
                        logger.log(logPrefix, `DECISION: User navigated to an item that is already open in tab ${duplicateTab.id}. Closing the pre-existing tab.`);
                        await chrome.tabs.remove(duplicateTab.id);
                        await setPacketContext(tabId, currentContext.instanceId, newItemInPacket.url, finalUrl);
                    } else {
                         logger.log(logPrefix, 'DECISION: User navigated to another item within the same packet. Re-stamping tab.');
                        await setPacketContext(tabId, currentContext.instanceId, newItemInPacket.url, finalUrl);
                    }
                    // --- End Duplicate Tab Cleanup Logic ---

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

    // Step 4: Re-fetch the context and reconcile browser state.
    const finalContext = await getPacketContext(tabId);
    logger.log(logPrefix, 'Final context after logic:', finalContext);
    const finalInstance = finalContext ? await storage.getPacketInstance(finalContext.instanceId) : null;

    if (finalInstance) {
        await reconcileBrowserState(tabId, finalInstance.instanceId, finalInstance, finalUrl);
        
        // *** THE FIX: The packet instance contents are already flattened, so a direct .find() is correct. ***
        const itemForVisitTimer = finalInstance.contents
            .find(i => i.url === finalContext.canonicalPacketUrl);

        if (itemForVisitTimer && !itemForVisitTimer.interactionBasedCompletion) {
            startVisitTimer(tabId, finalInstance.instanceId, itemForVisitTimer.url, logPrefix);
        }
    }

    // Step 5: Update the UI.
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

    const visitTimer = setTimeout(async () => {
        pendingVisitTimers.delete(tabId);
        try {
            const tab = await chrome.tabs.get(tabId);
            if (tab && tab.active) {
                const visitResult = await packetUtils.markUrlAsVisited(instanceId, canonicalPacketUrl);
                if (visitResult.success && visitResult.modified) {
                    const updatedInstance = visitResult.instance || await storage.getPacketInstance(instanceId);
                    sidebarHandler.notifySidebar('packet_instance_updated', { instance: updatedInstance, source: 'dwell_visit' });
                    // --- THE FIX: Trigger the green glow animation on the overlay ---
                    await setMediaPlaybackState({ instanceId: instanceId, tabId: tabId, topic: updatedInstance.topic }, { showVisitedAnimation: true, source: 'dwell_visit' });
                    await checkAndPromptForCompletion(logPrefix, visitResult, instanceId);
                }
            }
        } catch (error) {
            if (!error.message.toLowerCase().includes('no tab with id')) {
                logger.error(logPrefix, 'Error in delayed visit marking.', error);
            }
        }
    }, visitThresholdMs);

    pendingVisitTimers.set(tabId, visitTimer);
}