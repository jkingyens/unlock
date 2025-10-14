// ext/background-modules/navigation-handler.js
// This module now acts as a pure event listener for webNavigation events.
// It has been refactored to delegate all complex reconciliation logic to the
// PacketRuntime API, cleaning up its responsibilities.
// REVISED: The grace period for navigation has been lowered from 250ms to 50ms.

import {
    logger,
    storage,
    packetUtils,
    getPacketContext,
    setPacketContext,
    indexedDbStorage,
    sanitizeForFileName,
    shouldUseTabGroups
} from '../utils.js';
import { activeMediaPlayback, setupOffscreenDocument } from '../background.js';
import * as sidebarHandler from './sidebar-handler.js';
import PacketRuntime from './packet-runtime.js';
import cloudStorage from '../cloud-storage.js';

const pendingVisits = {};

// --- START OF FIX: Add a queuing system to prevent race conditions ---
const navigationQueues = new Map();
const processingNavigation = new Set();
// --- END OF FIX ---

export function clearPendingVisitTimer(tabId) {
    if (pendingVisits[tabId]?.timerId) {
        clearTimeout(pendingVisits[tabId].timerId);
        delete pendingVisits[tabId];
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
        // Expected to fail on non-http pages.
    }
}

export async function onBeforeNavigate(details) {
    if (details.frameId !== 0 || !details.url.startsWith('http')) {
        return;
    }

    const instances = await storage.getPacketInstances();

    for (const instanceId in instances) {
        const instance = instances[instanceId];
        const targetItem = packetUtils.isUrlInPacket(details.url, instance, { returnItem: true });

        if (targetItem) {
            const navIntent = {
                instanceId: instance.instanceId,
                canonicalPacketUrl: targetItem.url || targetItem.lrl
            };
            await storage.setSession({ [`nav_intent_${details.tabId}`]: navIntent });
            setTimeout(() => storage.removeSession(`nav_intent_${details.tabId}`), 5000);
            break;
        }
    }

    for (const instanceId in instances) {
        const instance = instances[instanceId];
        const targetItem = packetUtils.isUrlInPacket(details.url, instance, { returnItem: true });

        if (targetItem && targetItem.cacheable && targetItem.lrl) {
            const indexedDbKey = sanitizeForFileName(targetItem.lrl);
            const cachedContent = await indexedDbStorage.getGeneratedContent(instance.instanceId, indexedDbKey);

            if (cachedContent && cachedContent[0]?.content) {
                const previewUrl = chrome.runtime.getURL(`preview.html?instanceId=${instance.instanceId}&lrl=${encodeURIComponent(targetItem.lrl)}`);
                const trustedIntent = {
                    instanceId: instance.instanceId,
                    canonicalPacketUrl: targetItem.url
                };
                await storage.setSession({ [`trusted_intent_${details.tabId}`]: trustedIntent });
                chrome.tabs.update(details.tabId, { url: previewUrl });
                return;
            }
        }
    }
}

// --- START OF FIX: Route events through the queuing system ---
export async function onCommitted(details) {
    if (details.frameId !== 0) return;
    await processNavigationEvent(details.tabId, details.url, details);
}

export async function onHistoryStateUpdated(details) {
    if (details.frameId !== 0) return;
    await processNavigationEvent(details.tabId, details.url, details);
}

async function processNavigationEvent(tabId, url, details) {
    if (!navigationQueues.has(tabId)) {
        navigationQueues.set(tabId, []);
    }
    navigationQueues.get(tabId).push({ url, details });

    if (processingNavigation.has(tabId)) {
        return; // Already processing, event is queued.
    }

    processingNavigation.add(tabId);

    while (navigationQueues.get(tabId) && navigationQueues.get(tabId).length > 0) {
        const event = navigationQueues.get(tabId).shift();
        if (event) {
            try {
                await doProcessNavigationEvent(tabId, event.url, event.details);
            } catch (e) {
                logger.error('NavigationHandler', 'Error processing navigation event from queue', e);
            }
        }
    }

    processingNavigation.delete(tabId);
    navigationQueues.delete(tabId);
}
// --- END OF FIX ---

async function doProcessNavigationEvent(tabId, url, details) {
    const logPrefix = `[NavigationHandler Tab ${tabId}]`;
    if (!url || (!url.startsWith('http') && !url.startsWith('chrome-extension://'))) return;

    clearPendingVisitTimer(tabId);
    await injectOverlayScripts(tabId);

    const trustedIntentKey = `trusted_intent_${tabId}`;
    const navIntentKey = `nav_intent_${tabId}`;
    const sessionData = await storage.getSession([trustedIntentKey, navIntentKey]);
    const trustedContext = sessionData[trustedIntentKey];
    const navIntent = sessionData[navIntentKey];


    if (trustedContext) {
        logger.log(logPrefix, 'Found trusted intent token. Stamping tab context.');
        await setPacketContext(tabId, trustedContext.instanceId, trustedContext.canonicalPacketUrl, url);
        await storage.removeSession(trustedIntentKey);
    } else if (navIntent) {
        logger.log(logPrefix, 'Found navigation intent for redirect. Stamping tab context.');
        await setPacketContext(tabId, navIntent.instanceId, navIntent.canonicalPacketUrl, url);
        await storage.removeSession(navIntentKey);
    }

    const currentContext = await getPacketContext(tabId);
    let instance = null;

    if (currentContext?.instanceId) {
        instance = await storage.getPacketInstance(currentContext.instanceId);
    } else {
        const allInstances = await storage.getPacketInstances();
        for (const inst of Object.values(allInstances)) {
            if (packetUtils.isUrlInPacket(url, inst)) {
                instance = inst;
                break;
            }
        }
    }

    if (instance) {
        const runtime = new PacketRuntime(instance);
        await runtime.reconcileTab(tabId, url, details);
    }

    let finalContext = await getPacketContext(tabId);
    let finalInstance = finalContext ? await storage.getPacketInstance(finalContext.instanceId) : null;
    let isContextOverriddenForMedia = false;
    
    if (activeMediaPlayback.instanceId) {
        if (!finalInstance || finalInstance.instanceId !== activeMediaPlayback.instanceId) {
            finalInstance = activeMediaPlayback.instance;
            finalContext = null; 
            isContextOverriddenForMedia = true;
        }
    }

    if (sidebarHandler.isSidePanelAvailable()) {
        sidebarHandler.notifySidebar('update_sidebar_context', {
            tabId,
            instanceId: finalInstance ? finalInstance.instanceId : null,
            instance: finalInstance,
            packetUrl: finalContext ? finalContext.canonicalPacketUrl : null,
            currentUrl: url
        });
    }

    await sidebarHandler.updateActionForTab(tabId);
}

export async function startVisitTimer(tabId, instanceId, canonicalPacketUrl, logPrefix) {
    const settings = await storage.getSettings();
    const visitThresholdMs = (settings.visitThresholdSeconds ?? 5) * 1000;

    const visitTimer = setTimeout(async () => {
        delete pendingVisits[tabId]; 
        try {
            const tab = await chrome.tabs.get(tabId);
            if (tab && tab.active) {
                const instanceToUpdate = await storage.getPacketInstance(instanceId);
                if (!instanceToUpdate) return;

                const visitResult = await packetUtils.markUrlAsVisited(instanceToUpdate, canonicalPacketUrl);

                if (visitResult.success && visitResult.modified) {
                    await storage.savePacketInstance(visitResult.instance);
                    if (activeMediaPlayback.instanceId === instanceId) {
                        activeMediaPlayback.instance = visitResult.instance;
                    }
                    sidebarHandler.notifySidebar('packet_instance_updated', { instance: visitResult.instance, source: 'dwell_visit' });
                    await checkAndPromptForCompletion(logPrefix, visitResult, instanceId);
                }
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


export async function checkAndPromptForCompletion(logPrefix, visitResult, instanceId) {
    if (visitResult?.success && visitResult?.justCompleted) {
        const instanceData = visitResult.instance || await storage.getPacketInstance(instanceId);
        if (!instanceData || instanceData.completionAcknowledged) {
            return;
        }
        
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
    }
}