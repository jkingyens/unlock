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
    logger.log(`[NavigationHandler Tab ${tabId}]`, 'Processing navigation event.', {
        url: finalUrl,
        transitionType: details.transitionType,
        transitionQualifiers: details.transitionQualifiers,
        fullDetails: details
    });

    await injectOverlayScripts(tabId);

    const logPrefix = `[NavigationHandler Tab ${tabId}]`;
    clearPendingVisitTimer(tabId);
    clearPendingNavigationActionTimer(tabId);

    const transitionType = details.transitionType || '';
    const transitionQualifiers = details.transitionQualifiers || [];

    const trustedIntentKey = `trusted_intent_${tabId}`;
    const sessionData = await storage.getSession(trustedIntentKey);
    const trustedContext = sessionData[trustedIntentKey];

    if (trustedContext) {
        await setPacketContext(tabId, trustedContext.instanceId, trustedContext.canonicalPacketUrl, finalUrl);
        await storage.removeSession(trustedIntentKey);
    }

    let currentContext = await getPacketContext(tabId);

    if (currentContext) {
        const isUserInitiated = ['typed', 'auto_bookmark', 'generated', 'keyword', 'form_submit'].includes(transitionType) ||
                                (transitionType === 'link' && !transitionQualifiers.includes('client_redirect') && !transitionQualifiers.includes('server_redirect'));

        // --- REVISED LOGIC ---
        if (isUserInitiated && finalUrl !== currentContext.currentBrowserUrl) {
            const instance = await storage.getPacketInstance(currentContext.instanceId);
            // Capture the original context before the timer
            const originalCanonicalUrl = currentContext.canonicalPacketUrl;

            const navigationActionTimer = setTimeout(async () => {
                pendingNavigationActionTimers.delete(tabId);
                const newItemInPacket = packetUtils.isUrlInPacket(finalUrl, instance, { returnItem: true });

                if (newItemInPacket) {
                    // THE FIX: If it's a new packet item, ignore it and restore the original context.
                    logger.log(logPrefix, 'Timer fired. Redirect landed on another packet item. Preserving original context.', { originalUrl: originalCanonicalUrl });
                    await setPacketContext(tabId, currentContext.instanceId, originalCanonicalUrl, finalUrl);
                } else {
                    // This part is correct: the URL is not in the packet, so demote.
                    logger.log(logPrefix, 'Timer fired. New URL is not a packet item. Demoting tab.');
                    await clearPacketContext(tabId);
                    if (await shouldUseTabGroups()) {
                        await tabGroupHandler.ejectTabFromGroup(tabId, currentContext.instanceId);
                    }
                }
                // Trigger a full UI update after the action is taken
                await processNavigationEvent(tabId, finalUrl, { ...details, transitionType: 'manual_update' });

            }, 500);

            pendingNavigationActionTimers.set(tabId, navigationActionTimer);
            return;
        }
    }
    
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