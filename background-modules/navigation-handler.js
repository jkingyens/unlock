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
    resetActiveMediaPlayback
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

    await injectOverlayScripts(tabId);

    const logPrefix = `[NavigationHandler Tab ${tabId}]`;
    clearPendingVisitTimer(tabId);

    const transitionType = details.transitionType || '';

    // Step 1: Check for the "trusted intent" token. This is the highest priority.
    const trustedIntentKey = `trusted_intent_${tabId}`;
    let sessionData = await storage.getSession(trustedIntentKey);
    const trustedContext = sessionData[trustedIntentKey];

    if (trustedContext) {
        // This is the first time we've seen this tab. Stamp its identity.
        logger.log(logPrefix, 'Trusted intent token found. Stamping tab context and setting grace period.');
        await setPacketContext(tabId, trustedContext.instanceId, trustedContext.canonicalPacketUrl, finalUrl);
        // Set a short-lived "grace period" token to handle immediate redirects.
        await storage.setSession({ [`grace_period_${tabId}`]: true });
        setTimeout(() => storage.removeSession(`grace_period_${tabId}`), 1000); // Grace period of 1 second
        
        // Clean up the one-time trusted intent token.
        await storage.removeSession(trustedIntentKey);
    }

    // Step 2: Get the tab's current context.
    let currentContext = await getPacketContext(tabId);

    // Step 3: If the tab has context, determine the next action.
    if (currentContext) {
        // Step 3a: Check if we are within the grace period.
        const gracePeriodKey = `grace_period_${tabId}`;
        sessionData = await storage.getSession(gracePeriodKey);
        if (sessionData[gracePeriodKey]) {
            logger.log(logPrefix, 'Grace period active. Updating browser URL but preserving canonical context.');
            await setPacketContext(tabId, currentContext.instanceId, currentContext.canonicalPacketUrl, finalUrl);
        } else {
            // Step 3b: Grace period is over. Handle as a normal navigation.
            // THIS IS THE FIX: Re-introduce 'link' to correctly handle user clicks away from the packet.
            const isUserInitiated = ['link', 'typed', 'auto_bookmark', 'generated', 'keyword', 'form_submit'].includes(transitionType);

            if (isUserInitiated) {
                const instance = await storage.getPacketInstance(currentContext.instanceId);
                const newItemInPacket = packetUtils.isUrlInPacket(finalUrl, instance, { returnItem: true });

                if (newItemInPacket && newItemInPacket.url !== currentContext.canonicalPacketUrl) {
                    // User navigated to another item IN the same packet. Re-stamp the tab.
                    logger.log(logPrefix, 'User navigated to another packet item. Re-stamping tab.', { newUrl: newItemInPacket.url });
                    await setPacketContext(tabId, currentContext.instanceId, newItemInPacket.url, finalUrl);
                } else if (!newItemInPacket) {
                    // User navigated OUTSIDE the packet. Demote the tab.
                    logger.log(logPrefix, 'User navigated away from the packet. Demoting tab.');
                    await clearPacketContext(tabId);
                    if (await shouldUseTabGroups()) {
                        await tabGroupHandler.ejectTabFromGroup(tabId, currentContext.instanceId);
                    }
                }
            }
        }
    }

    // Step 4: Re-fetch the context and reconcile browser state (unchanged).
    const finalContext = await getPacketContext(tabId);
    const finalInstance = finalContext ? await storage.getPacketInstance(finalContext.instanceId) : null;

    if (finalInstance) {
        await reconcileBrowserState(tabId, finalInstance.instanceId, finalInstance, finalUrl);

        const itemForVisitTimer = finalInstance.contents
            .flatMap(c => c.type === 'alternative' ? c.alternatives : c)
            .find(i => i.url === finalContext.canonicalPacketUrl);

        if (itemForVisitTimer && !itemForVisitTimer.interactionBasedCompletion) {
            startVisitTimer(tabId, finalInstance.instanceId, itemForVisitTimer.url, logPrefix);
        }
    }

    // Step 5: Update the UI (unchanged).
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

async function startVisitTimer(tabId, instanceId, canonicalPacketUrl, logPrefix) {
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