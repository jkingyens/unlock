// ext/background.js - Main service worker entry point (Global Side Panel Mode)
// FINAL REVISION: This version adds listeners for chrome.tabs.onCreated and
// chrome.tabs.onAttached. These listeners make the tab ordering system reactive,
// ensuring that a packet's tab group is re-ordered correctly whenever a new tab
// is added or moved into it, thus solving the ordering race condition.

import {
    logger,
    storage,
    getPacketContext,
    setPacketContext,
    getDb,
    shouldUseTabGroups,
    shouldShowOverlay,
    getInstanceIdFromGroupTitle,
    CONFIG,
    clearPacketContext,
    packetUtils,
    indexedDbStorage,
    arrayBufferToBase64,
    base64Decode,
    sanitizeForFileName,
    isSidePanelAvailable,
    applyThemeMode
} from './utils.js';
import * as msgHandler from './background-modules/message-handlers.js';
import * as ruleManager from './background-modules/rule-manager.js';
import { onCommitted, onHistoryStateUpdated, checkAndPromptForCompletion } from './background-modules/navigation-handler.js';
import * as tabGroupHandler from './background-modules/tab-group-handler.js';
import * as sidebarHandler from './background-modules/sidebar-handler.js';
import cloudStorage from './cloud-storage.js';

// --- THE FIX: Call the listener registration at the top level ---
attachNavigationListeners();
const reorderDebounceTimers = new Map();

// This new helper function will robustly schedule the reordering
async function scheduleReorder(groupId) {
    if (!groupId || !(await shouldUseTabGroups())) return;

    // If a reorder is already scheduled for this group, cancel it
    if (reorderDebounceTimers.has(groupId)) {
        clearTimeout(reorderDebounceTimers.get(groupId));
    }

    // Schedule a new reorder to run after a short delay
    const timerId = setTimeout(() => {
        reorderGroupFromChangeEvent(groupId)
            .catch(err => logger.error("DebouncedReorder", `Error reordering group ${groupId}`, err));
        reorderDebounceTimers.delete(groupId); // Clean up the timer
    }, 350); // 350ms is a safe delay to ensure the browser UI has settled

    reorderDebounceTimers.set(groupId, timerId);
}

// --- Modify your EXISTING listeners to use the new scheduler ---

chrome.tabs.onCreated.addListener(async (tab) => {
    if (tab.groupId && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        await scheduleReorder(tab.groupId); // Use the new scheduler
    }
});

chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
    await scheduleReorder(attachInfo.newGroupId); // Use the new scheduler
});


// --- Add this NEW listener for moved tabs ---

chrome.tabs.onMoved.addListener(async (tabId, moveInfo) => {
    try {
        // We need to get the tab to find its group ID
        const tab = await chrome.tabs.get(tabId);
        if (tab.groupId && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
            await scheduleReorder(tab.groupId); // Use the new scheduler
        }
    } catch (e) {
        // This can error if the tab is closed while being moved. It's safe to ignore.
    }
});

// --- Add a flag to gate navigation events during startup ---
let isRestoring = true;

chrome.storage.session.get(['isBrowserStartupComplete']).then(async (result) => {
    if (result.isBrowserStartupComplete) {
        // If the flag is true, this is just a wake-up, not a real startup.
        // Immediately flip the volatile flag to false.
        isRestoring = false;
        logger.log('Background:Lifecycle', 'Service worker woke up. Navigation processing is active.');
    }
    // If the flag is not set, we proceed with the onStartup/onInstalled listeners,
    // which will handle setting it for the first time.
});

const ACTIVE_MEDIA_KEY = 'activeMediaPlaybackState';
const AUDIO_KEEP_ALIVE_ALARM = 'audio-keep-alive';

// This object holds the current state and is exported for other modules to read.
export let activeMediaPlayback = {
    tabId: null,
    instanceId: null,
    pageId: null,
    isPlaying: false,
    topic: '',
    currentTime: 0,
    duration: 0,
    mentionedMediaLinks: [],
    lastMentionedLink: null
};

// This is the single, authoritative function for clearing the in-memory state.
export async function resetActiveMediaPlayback() {
    logger.log('Background', 'CRITICAL LOG: Resetting global activeMediaPlayback state.');
    
    // FIX: Define the initial state *inside* the function.
    // This resolves the ReferenceError because the constant is now in the correct scope.
    const initialMediaPlaybackState = {
        tabId: null,
        instanceId: null,
        pageId: null,
        isPlaying: false,
        topic: '',
        currentTime: 0,
        duration: 0,
        mentionedMediaLinks: [],
        lastMentionedLink: null
    };

    activeMediaPlayback = { ...initialMediaPlaybackState };
    
    // Broadcast the cleared state to all UI components to ensure they hide.
    await setMediaPlaybackState({}, { source: 'reset' });
}

// Rule refresh alarm name
const RULE_REFRESH_ALARM_NAME = 'refreshRedirectRules';

// --- Helper: Initialize Storage ---
async function initializeStorageAndSettings() {
    await storage.getSettings(); // Ensures defaults are applied if nothing exists
    logger.log('Background', 'Storage and settings initialized/verified.');
}

// --- Offscreen Document and Audio Control ---
let creatingOffscreenDocument;

async function hasOffscreenDocument() {
    if (chrome.runtime && typeof chrome.runtime.getContexts === 'function') {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT']
        });
        return contexts.length > 0;
    }
    return false; // Fallback for safety
}

async function setupOffscreenDocument() {
    try {
        if (await hasOffscreenDocument()) {
            return;
        }
        if (creatingOffscreenDocument) {
            await creatingOffscreenDocument;
        } else {
            creatingOffscreenDocument = chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['AUDIO_PLAYBACK', 'DOM_PARSER'],
                justification: 'Play audio persistently and parse HTML content.',
            });
            await creatingOffscreenDocument;
            creatingOffscreenDocument = null;
        }
    } catch (error) {
        logger.error('Background', 'Failed to create offscreen document.', error);
        creatingOffscreenDocument = null; // Reset promise on failure
        throw error; // Propagate error
    }
}


export async function controlAudioInOffscreen(command, data) {
    try {
        await setupOffscreenDocument();
        return await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'control-audio',
            data: { command, data }
        });
    } catch (error) {
        logger.error('Background', 'Error controlling audio in offscreen document.', error);
        return { success: false, error: error.message };
    }
}

// --- Universal Script Injection ---
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
        // This is expected to fail on chrome:// pages, store pages, etc. We can safely ignore these errors.
    }
}


// --- State Management and Broadcasting ---
export async function setMediaPlaybackState(newState, options = { animate: false, source: 'unknown' }) {
    logger.log('Background:setMediaPlaybackState', 'CRITICAL LOG: State update requested.', {
        source: options.source,
        newState: newState,
        currentMentionedLinks: activeMediaPlayback.mentionedMediaLinks
    });

    const oldLink = activeMediaPlayback.lastMentionedLink;
    const { lastMentionedLink, ...restOfNewState } = newState;
    const previousTabId = activeMediaPlayback.tabId;

    activeMediaPlayback = { ...activeMediaPlayback, ...restOfNewState };

    let aNewLinkWasMentioned = false;
    if (activeMediaPlayback.isPlaying && activeMediaPlayback.instanceId && activeMediaPlayback.pageId && typeof activeMediaPlayback.currentTime === 'number') {
        try {
            const instance = await storage.getPacketInstance(activeMediaPlayback.instanceId);
            let mediaItem = null;
            if (instance && instance.contents) {
                for (const item of instance.contents) {
                    if (item.pageId === activeMediaPlayback.pageId) { mediaItem = item; break; }
                    if (item.type === 'alternative' && item.alternatives) {
                        const found = item.alternatives.find(alt => alt.pageId === activeMediaPlayback.pageId);
                        if (found) { mediaItem = found; break; }
                    }
                }
            }

            if (mediaItem && mediaItem.timestamps && instance) {
                const mentionedUrls = new Set(instance.mentionedMediaLinks || []);
                let lastMentionedTimestamp = null;

                mediaItem.timestamps.forEach(ts => {
                    if (activeMediaPlayback.currentTime >= ts.startTime) {
                        mentionedUrls.add(ts.url);
                        if (!lastMentionedTimestamp || ts.startTime > lastMentionedTimestamp.startTime) {
                            lastMentionedTimestamp = ts;
                        }
                    }
                });
                
                const linkItem = lastMentionedTimestamp ? instance.contents.find(i => i.url === lastMentionedTimestamp.url) : null;
                const newLink = linkItem ? { url: linkItem.url, title: linkItem.title } : null;

                if (newLink && (!oldLink || newLink.url !== oldLink.url)) {
                    activeMediaPlayback.lastMentionedLink = newLink;
                    aNewLinkWasMentioned = true;
                } else if (!newLink && oldLink) {
                    activeMediaPlayback.lastMentionedLink = null;
                }

                if (mentionedUrls.size > (instance.mentionedMediaLinks || []).length) {
                    instance.mentionedMediaLinks = Array.from(mentionedUrls);
                    await storage.savePacketInstance(instance);
                }
                activeMediaPlayback.mentionedMediaLinks = instance.mentionedMediaLinks;
            }
        } catch (error) {
            logger.error('Background:setMediaPlaybackState', 'Error calculating/saving mentioned links', error);
        }
    }

    const isPlaying = activeMediaPlayback.isPlaying;
    const hasActiveTrack = !!activeMediaPlayback.pageId;

    if (!isPlaying && hasActiveTrack) {
        chrome.alarms.create(AUDIO_KEEP_ALIVE_ALARM, { periodInMinutes: 0.4 });
    } else {
        chrome.alarms.clear(AUDIO_KEEP_ALIVE_ALARM);
    }

    if (hasActiveTrack) {
        await storage.setSession({ [ACTIVE_MEDIA_KEY]: activeMediaPlayback });
    } else {
        await storage.removeSession(ACTIVE_MEDIA_KEY);
    }

    const { isSidebarOpen } = await storage.getSession({ isSidebarOpen: false });
    const overlayEnabled = await shouldShowOverlay();
    const isVisible = hasActiveTrack && !isSidebarOpen && overlayEnabled;

    const finalState = {
        ...activeMediaPlayback,
        isVisible,
        animate: options.animate,
        animateLinkMention: aNewLinkWasMentioned && options.source === 'time_update'
    };
    
    let targetTabId = activeMediaPlayback.tabId;
    if (!targetTabId) {
        try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (activeTab) {
                targetTabId = activeTab.id;
            }
        } catch (e) {}
    }
    
    if (previousTabId && previousTabId !== targetTabId) {
         try {
             await chrome.tabs.sendMessage(previousTabId, {
                action: 'sync_overlay_state',
                data: { isVisible: false }
            });
         } catch(e) {}
    }
    
    if (targetTabId) {
        try {
            await chrome.tabs.sendMessage(targetTabId, {
                action: 'sync_overlay_state',
                data: finalState
            });
        } catch(e) {}
    }
    
    sidebarHandler.notifySidebar('playback_state_updated', activeMediaPlayback);
}

async function restoreMediaStateOnStartup() {
    const data = await storage.getSession(ACTIVE_MEDIA_KEY);
    if (data && data[ACTIVE_MEDIA_KEY]) {
        activeMediaPlayback = data[ACTIVE_MEDIA_KEY];
    }
}

// --- Event Listeners ---
chrome.runtime.onInstalled.addListener(async (details) => {
    // Wrap the entire installation process in a try...finally block
    try {
        logger.log('Background:onInstalled', `Extension ${details.reason}`);
        await initializeStorageAndSettings();
        await restoreMediaStateOnStartup();
        await cloudStorage.initialize().catch(err => logger.error('Background:onInstalled', 'Initial cloud storage init failed', err));
        await ruleManager.refreshAllRules();

        const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
        for (const tab of tabs) {
            if (tab.id) {
                injectOverlayScripts(tab.id);
            }
        }

        try {
            if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
                 await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
            }
        } catch (error) {
             logger.error('Background:onInstalled', 'Error setting side panel behavior:', error);
        }
        await getDb();

        chrome.alarms.create(RULE_REFRESH_ALARM_NAME, {
            delayInMinutes: 55,
            periodInMinutes: 55
        });
        await chrome.storage.session.set({ isBrowserStartupComplete: true });
    } finally {
        // This will now run regardless of whether the try block succeeded or failed
        isRestoring = false;
        logger.log('Background:onInstalled', 'Installation complete. Navigation processing is now enabled.');
    }
});

chrome.runtime.onStartup.addListener(async () => {
    // Wrap the entire startup process in a try...finally block
    try {
        logger.log('Background:onStartup', 'Browser startup detected. Navigation processing is paused.');
        await initializeStorageAndSettings();
        await restoreMediaStateOnStartup();
        await cloudStorage.initialize().catch(err => {});
        await restoreContextOnStartup();
        await ruleManager.refreshAllRules();
        await getDb();
        await garbageCollectTabContexts();
    } finally {
        // This guarantees the extension becomes active even if an init step fails
        isRestoring = false;
        logger.log('Background:onStartup', 'Startup process complete. Navigation processing is now enabled.');
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    return msgHandler.handleMessage(message, sender, sendResponse);
});

chrome.runtime.onMessageExternal.addListener(async (message, sender, sendResponse) => {
    if (message.action === 'page_interaction_complete') {
        const context = await getPacketContext(sender.tab.id);
        if (context?.instanceId && context?.canonicalPacketUrl) {
            const visitResult = await packetUtils.markUrlAsVisited(context.instanceId, context.canonicalPacketUrl);
            if (visitResult.success && visitResult.modified) {
                sidebarHandler.notifySidebar('packet_instance_updated', { instance: visitResult.instance });
                await checkAndPromptForCompletion('onMessageExternal', visitResult, context.instanceId);
            }
            sendResponse({ success: true });
        } else {
            sendResponse({ success: false, error: 'No context found for sender tab.' });
        }
    }
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RULE_REFRESH_ALARM_NAME) {
        ruleManager.refreshAllRules();
    }
});

chrome.action.onClicked.addListener((tab) => {
    if (tab.id) {
        chrome.sidePanel.open({ windowId: tab.windowId });
    }
});

chrome.tabs.onCreated.addListener(async (tab) => {
    if (tab.groupId && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        await reorderGroupFromChangeEvent(tab.groupId);
    }
});

chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
    await reorderGroupFromChangeEvent(attachInfo.newGroupId);
});

async function reorderGroupFromChangeEvent(groupId) {
    if (!groupId || !(await shouldUseTabGroups())) return;
    try {
        const group = await chrome.tabGroups.get(groupId);
        const instanceId = getInstanceIdFromGroupTitle(group.title);
        if (instanceId) {
            const instance = await storage.getPacketInstance(instanceId);
            if (instance) {
                logger.log('Background:reorderGroup', `Re-ordering group ${groupId} due to tab change.`);
                await tabGroupHandler.orderTabsInGroup(groupId, instance);
            }
        }
    } catch (error) {}
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const tabId = activeInfo.tabId;

    // --- Start of new code ---
    try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.groupId && groupsNeedingReorder.has(tab.groupId)) {
            await reorderGroupFromChangeEvent(tab.groupId);
            groupsNeedingReorder.delete(tab.groupId); // Clear the flag
        }
    } catch (e) { /* ignore error if tab is closed quickly */ }
    // --- End of new code ---

    if (activeMediaPlayback.pageId) {
        await setMediaPlaybackState({ tabId: tabId }, { animate: false, source: 'tab_switch' });
    }
    await sidebarHandler.updateActionForTab(tabId);
    const context = await getPacketContext(tabId);
    if (sidebarHandler.isSidePanelAvailable()) {
        const instance = context ? await storage.getPacketInstance(context.instanceId) : null;
        sidebarHandler.notifySidebar('update_sidebar_context', {
            tabId,
            instanceId: instance ? instance.instanceId : null,
            instance,
            packetUrl: context ? context.canonicalPacketUrl : null,
            currentUrl: instance ? context.currentBrowserUrl : null
        });
    }
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    if (tabId === activeMediaPlayback.tabId) {
        logger.log('Background', `Playback tab ${tabId} was closed. Stopping media.`);
        if (typeof msgHandler.handlePlaybackActionRequest === 'function') {
            await msgHandler.handlePlaybackActionRequest({ data: { intent: 'stop' } }, {}, () => {});
        }
    }
    await tabGroupHandler.handleTabRemovalCleanup(tabId, removeInfo);
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
    injectOverlayScripts(addedTabId);
    const oldContext = await getPacketContext(removedTabId);
    if (oldContext) {
        await setPacketContext(addedTabId, oldContext.instanceId, oldContext.canonicalPacketUrl, oldContext.currentBrowserUrl);
        await clearPacketContext(removedTabId);
    }
});

function attachNavigationListeners() {
    if (!chrome.webNavigation) { return; }

    const onCommittedWrapper = (details) => {
        if (isRestoring) {
            logger.log('Background:onCommitted', 'Ignoring navigation event during restore.', { url: details.url });
            return;
        }
        onCommitted(details);
    };

    const onHistoryStateUpdatedWrapper = (details) => {
        if (isRestoring) {
            logger.log('Background:onHistoryStateUpdated', 'Ignoring navigation event during restore.', { url: details.url });
            return;
        }
        onHistoryStateUpdated(details);
    };

    if (chrome.webNavigation.onCommitted.hasListener(onCommitted)) {
        chrome.webNavigation.onCommitted.removeListener(onCommitted);
    }
    if (chrome.webNavigation.onHistoryStateUpdated.hasListener(onHistoryStateUpdated)) {
        chrome.webNavigation.onHistoryStateUpdated.removeListener(onHistoryStateUpdated);
    }
    chrome.webNavigation.onCommitted.addListener(onCommittedWrapper);
    chrome.webNavigation.onHistoryStateUpdated.addListener(onHistoryStateUpdatedWrapper);
}

chrome.runtime.onConnect.addListener(async (port) => {
  if (port.name === 'sidebar') {
    await storage.setSession({ isSidebarOpen: true });
    // FIX: Replaced the incorrect function call with the correct one.
    await setMediaPlaybackState({}, { animate: false, source: 'sidebar_connect' });

    port.onDisconnect.addListener(async () => {
      await storage.setSession({ isSidebarOpen: false });
      // FIX: Replaced the incorrect function call with the correct one.
      await setMediaPlaybackState({}, { animate: true, source: 'sidebar_disconnect' });
    });
  }
});



// --- Garbage Collection ---
async function garbageCollectTabContexts() {
    logger.log('Background:GC', 'Starting garbage collection for tab contexts...');
    let itemsRemovedCount = 0;
    try {
        const allLocalData = await storage.getLocal(null);
        if (!allLocalData) { logger.log('Background:GC', 'No local data.'); return 0; }
        const contextPrefix = CONFIG.STORAGE_KEYS.PACKET_CONTEXT_PREFIX;
        const contextKeys = Object.keys(allLocalData).filter(key => key.startsWith(contextPrefix));
        if (contextKeys.length === 0) { logger.log('Background:GC', 'No context keys found.'); return 0; }

        let allTabs = [];
        try {
            allTabs = await chrome.tabs.query({});
        } catch (e) {
            logger.error("Background:GC", "Failed to query tabs during GC, might be running too early or in a restricted context. Assuming no open tabs for this GC pass.", e);
        }
        const existingTabIds = new Set(allTabs.map(tab => tab.id));
        const keysToRemove = [];

        contextKeys.forEach(key => {
            const tabIdStr = key.substring(contextPrefix.length);
            const tabId = parseInt(tabIdStr, 10);
            if (isNaN(tabId) || (allTabs.length > 0 && !existingTabIds.has(tabId))) {
                keysToRemove.push(key);
            }
        });

        if (keysToRemove.length > 0) {
            await storage.removeLocal(keysToRemove);
            itemsRemovedCount = keysToRemove.length;
            logger.log('Background:GC', `Removed ${itemsRemovedCount} stale context entries.`);
        } else {
            logger.log('Background:GC', 'No stale context entries found.');
        }
    } catch (error) {
        logger.error('Background:GC', 'Error during context garbage collection', error);
    }
    try {
        const [allInstances, allStates] = await Promise.all([
            storage.getPacketInstances(),
            storage.getAllPacketBrowserStates()
        ]);
        const instanceIds = new Set(Object.keys(allInstances));
        let statesRemovedCount = 0;
        for (const stateInstanceId in allStates) {
            if (!instanceIds.has(stateInstanceId)) {
                await storage.deletePacketBrowserState(stateInstanceId);
                statesRemovedCount++;
            }
        }
        if (statesRemovedCount > 0) {
             logger.log('Background:GC', `Removed ${statesRemovedCount} stale browser state entries.`);
        }
    } catch(error) {
        logger.error('Background:GC', 'Error during browser state garbage collection', error);
    }
    return itemsRemovedCount;
}

async function restoreContextOnStartup() {
    logger.log('Background:restoreContext', 'Starting context restoration using tab order...');
    if (!(await shouldUseTabGroups())) {
        logger.log('Background:restoreContext', 'Tab Groups disabled, skipping restoration.');
        return;
    }

    try {
        const allGroups = await chrome.tabGroups.query({});

        for (const group of allGroups) {
            const instanceId = getInstanceIdFromGroupTitle(group.title);
            if (!instanceId) continue;

            const instance = await storage.getPacketInstance(instanceId);
            if (!instance) continue;
            
            const tabsInGroup = await chrome.tabs.query({ groupId: group.id });

            const tabbableContents = instance.contents.filter(item => item.type == 'external');

            for (let i = 0; i < tabsInGroup.length; i++) {
                const tab = tabsInGroup[i];
                const contentItem = tabbableContents[i];

                if (tab && contentItem && contentItem.url) {
                    logger.log('Background:restoreContext', `Restoring context for tab ${tab.id} to packet item "${contentItem.title}" based on tab order.`);

                    await storage.setSession({
                        [`trusted_intent_${tab.id}`]: {
                            instanceId: instance.instanceId,
                            canonicalPacketUrl: contentItem.url,
                        }
                    });

                    await setPacketContext(tab.id, instance.instanceId, contentItem.url, tab.url);
                    await sidebarHandler.updateActionForTab(tab.id);
                } else {
                    await clearPacketContext(tab.id);
                }
            }
        }
        logger.log('Background:restoreContext', 'Context restoration finished.');
    } catch (error) {
        logger.error('Background:restoreContext', 'Error during context restoration', error);
    }
}