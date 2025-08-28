// ext/background.js - Main service worker entry point (Global Side Panel Mode)
// FINAL REVISION: The resetActiveMediaPlayback function now sends an explicit 'stop'
// command to the offscreen document to ensure audio is halted immediately.

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
import { onCommitted, onHistoryStateUpdated, checkAndPromptForCompletion, startVisitTimer, clearPendingVisitTimer } from './background-modules/navigation-handler.js';
import * as tabGroupHandler from './background-modules/tab-group-handler.js';
import * as sidebarHandler from './background-modules/sidebar-handler.js';
import cloudStorage from '../cloud-storage.js';

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
let resolveInitialization;

// This promise will be awaited by critical event listeners.
// It ensures they don't run until we've confirmed the extension's state.
const initializationPromise = new Promise(resolve => {
    resolveInitialization = resolve;
});

// This self-executing function checks the session state immediately when the worker starts.
(async () => {
    const isBrowserStartupComplete = await chrome.storage.session.get('isBrowserStartupComplete');
    if (isBrowserStartupComplete) {
        // This is a simple wake-up, not a fresh start.
        // The onStartup/onInstalled listeners will NOT run.
        isRestoring = false;
        logger.log('Background:Lifecycle', 'Service worker woke up. Initialization complete.');
        // Resolve the promise immediately so event listeners can proceed.
        resolveInitialization(); // <<< ADD THIS LINE();
    }
    // If the flag is not set, we do nothing. We wait for onStartup or onInstalled
    // to run and eventually call resolveInitialization().
})();

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
    instance: null, // Holds the live instance object during playback
    lastTrippedMoment: null, // Holds info about the last moment for the overlay
};

// This is the single, authoritative function for clearing the in-memory state.
export async function resetActiveMediaPlayback() {
    await controlAudioInOffscreen('stop', {});

    if (activeMediaPlayback.isPlaying && activeMediaPlayback.instance) {
        await saveCurrentTime(activeMediaPlayback.instanceId, activeMediaPlayback.pageId, 0, true);
    }
    logger.log('Background', 'CRITICAL LOG: Resetting global activeMediaPlayback state.');
    
    activeMediaPlayback = {
        tabId: null,
        instanceId: null,
        pageId: null,
        isPlaying: false,
        topic: '',
        currentTime: 0,
        duration: 0,
        instance: null,
        lastTrippedMoment: null,
    };
    
    await storage.removeSession(CONFIG.STORAGE_KEYS.ACTIVE_MEDIA_KEY);
    await notifyUIsOfStateChange();
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
        const tab = await chrome.tabs.get(tabId);
        if (!tab || !tab.url || !tab.url.startsWith('http')) {
            return;
        }

        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['overlay.js']
        });
        await chrome.scripting.insertCSS({
            target: { tabId: tabId },
            files: ['overlay.css']
        });
    } catch (e) {
        const expectedErrors = [
            "Cannot access a chrome:// URL",
            "Cannot access a chrome-extension:// URL",
            "The tab was closed.",
            "No tab with id",
            "Cannot access contents of the page",
            "Frame with ID 0 was removed."
        ];
        if (!expectedErrors.some(msg => e.message.includes(msg))) {
            logger.error('Background:injectOverlayScripts', `Failed to inject scripts into tab ${tabId}`, e);
        }
    }
}

function findMediaItemInInstance(instance, pageId) {
    if (!instance || !instance.contents || !pageId) return null;
    return instance.contents.find(item => item.pageId === pageId && item.type === 'media');
}

export async function saveCurrentTime(instanceId, pageId, providedCurrentTime, isStopping = false) {
    try {
        const instance = await storage.getPacketInstance(instanceId);
        if (!instance) return;

        const mediaItem = findMediaItemInInstance(instance, pageId);
        if (!mediaItem) return;

        let timeToSave = providedCurrentTime;
        if (typeof timeToSave === 'undefined') {
            const response = await controlAudioInOffscreen('get_current_time', { pageId });
            if (response.success) {
                timeToSave = response.currentTime;
            }
        }

        if (typeof timeToSave === 'number') {
            mediaItem.currentTime = isStopping ? 0 : timeToSave;
            await storage.savePacketInstance(instance);
            logger.log('Background:saveCurrentTime', `Saved currentTime ${mediaItem.currentTime} for ${pageId}`);
        }
    } catch (error) {
        logger.error('Background:saveCurrentTime', 'Error saving playback time', error);
    }
}

export async function notifyUIsOfStateChange(options = {}) {
    let instance = activeMediaPlayback.instance;

    if (!instance) {
        const emptyState = { 
            ...activeMediaPlayback, 
            isPlaying: false, 
            currentTime: 0, 
            duration: 0, 
            momentsTripped: [],
            lastTrippedMoment: null
        };
        sidebarHandler.notifySidebar('playback_state_updated', emptyState);
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab) {
             try {
                 await injectOverlayScripts(activeTab.id);
                 await chrome.tabs.sendMessage(activeTab.id, {
                    action: 'sync_overlay_state',
                    data: { isVisible: false }
                });
             } catch(e) {}
        }
        return;
    }
    
    const playbackStateForUI = {
        ...activeMediaPlayback,
        momentsTripped: instance.momentsTripped || [],
        ...options
    };

    const { isSidebarOpen } = await storage.getSession({ isSidebarOpen: false });
    const overlayEnabled = await shouldShowOverlay();
    playbackStateForUI.isVisible = !!activeMediaPlayback.pageId && !isSidebarOpen && overlayEnabled;

    if (activeMediaPlayback.tabId) {
        try {
            await injectOverlayScripts(activeMediaPlayback.tabId);
            await chrome.tabs.sendMessage(activeMediaPlayback.tabId, {
                action: 'sync_overlay_state',
                data: playbackStateForUI
            });
        } catch (e) {}
    }
    sidebarHandler.notifySidebar('playback_state_updated', playbackStateForUI);
}


export async function setMediaPlaybackState(newState, options = { animate: false, source: 'unknown' }) {
    // --- START OF THE FIX ---
    const oldInstanceId = activeMediaPlayback.instanceId;
    const newInstanceId = newState.instanceId || oldInstanceId;

    activeMediaPlayback = { ...activeMediaPlayback, ...newState };

    // If the instanceId has changed, or if there's an instanceId but no live instance object,
    // we need to load or reload it to ensure our live state is always accurate.
    if (newInstanceId && (newInstanceId !== oldInstanceId || !activeMediaPlayback.instance)) {
        try {
            activeMediaPlayback.instance = await storage.getPacketInstance(newInstanceId);
            logger.log('Background:setMediaPlaybackState', `Loaded/reloaded live instance data for ${newInstanceId} into active media state.`);
        } catch (error) {
            logger.error('Background:setMediaPlaybackState', `Failed to load instance ${newInstanceId}`, error);
            await resetActiveMediaPlayback(); // Reset if we can't load the instance
            return;
        }
    }
    // --- END OF THE FIX ---
    
    const isPlaying = activeMediaPlayback.isPlaying;
    const hasActiveTrack = !!activeMediaPlayback.pageId;

    if (!isPlaying && hasActiveTrack) {
        chrome.alarms.create(AUDIO_KEEP_ALIVE_ALARM, { periodInMinutes: 0.4 });
    } else {
        chrome.alarms.clear(AUDIO_KEEP_ALIVE_ALARM);
    }

    if (hasActiveTrack) {
        await storage.setSession({ [CONFIG.STORAGE_KEYS.ACTIVE_MEDIA_KEY]: activeMediaPlayback });
    } else {
        await storage.removeSession(CONFIG.STORAGE_KEYS.ACTIVE_MEDIA_KEY);
    }
    
    await notifyUIsOfStateChange(options);
}

async function restoreMediaStateOnStartup() {
    const data = await storage.getSession(CONFIG.STORAGE_KEYS.ACTIVE_MEDIA_KEY);
    if (data && data[CONFIG.STORAGE_KEYS.ACTIVE_MEDIA_KEY]) {
        activeMediaPlayback = data[CONFIG.STORAGE_KEYS.ACTIVE_MEDIA_KEY];
        // Ensure instance is reloaded from persistent storage on startup
        if (activeMediaPlayback.instanceId) {
            activeMediaPlayback.instance = await storage.getPacketInstance(activeMediaPlayback.instanceId);
        }
    }
}

// --- Event Listeners ---
chrome.runtime.onInstalled.addListener(async (details) => {
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
                 await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
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
        isRestoring = false;
        logger.log('Background:onInstalled', 'Installation complete. Navigation processing is now enabled.');
        resolveInitialization();
    }
});

chrome.runtime.onStartup.addListener(async () => {
    try {
        logger.log('Background:onStartup', 'Browser startup detected. Navigation processing is paused.');
        await initializeStorageAndSettings();
        await restoreMediaStateOnStartup();
        await cloudStorage.initialize().catch(err => {});
        await restoreContextOnStartup();
        await ruleManager.refreshAllRules();
        await getDb();
        await garbageCollectTabContexts();
        // FIX: Added cleanup for the draft tab group on startup
        await tabGroupHandler.cleanupDraftGroup();

        logger.log('Background:onStartup', 'Injecting overlay scripts into existing tabs.');
        const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
        for (const tab of tabs) {
            if (tab.id) {
                injectOverlayScripts(tab.id).catch(e => logger.warn('Background:onStartup', `Failed to inject script into tab ${tab.id}`, e));
            }
        }
        
    } finally {
        isRestoring = false;
        logger.log('Background:onStartup', 'Startup process complete. Navigation processing is now enabled.');
        resolveInitialization();
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    return msgHandler.handleMessage(message, sender, sendResponse);
});

chrome.runtime.onMessageExternal.addListener(async (message, sender, sendResponse) => {
    if (message.action === 'page_interaction_complete') {
        const context = await getPacketContext(sender.tab.id);
        if (context?.instanceId && context?.canonicalPacketUrl) {
            const visitResult = await packetUtils.markUrlAsVisited(context.instanceId, context.canonicalPacketUrl, activeMediaPlayback.instance);
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

        if (group.title === tabGroupHandler.DRAFT_GROUP_TITLE) {
            await tabGroupHandler.orderDraftTabsInGroup(groupId);
            return;
        }

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
    const closingState = await storage.getSession('isClosingGroup');
    if (closingState && closingState.isClosingGroup) {
        logger.log('Background:onActivated', 'Ignoring tab activation event due to tab group closure in progress.');
        return; // Exit immediately
    }

    const tabId = activeInfo.tabId;
    
    try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.groupId && groupsNeedingReorder.has(tab.groupId)) {
            await reorderGroupFromChangeEvent(tab.groupId);
            groupsNeedingReorder.delete(tab.groupId); // Clear the flag
        }
    } catch (e) { /* ignore error if tab is closed quickly */ }

    if (activeMediaPlayback.pageId) {
        activeMediaPlayback.tabId = tabId;
        await notifyUIsOfStateChange();
    }
    await sidebarHandler.updateActionForTab(tabId);
    const context = await getPacketContext(tabId);
    let instance = context ? await storage.getPacketInstance(context.instanceId) : null;
    
    if (instance && activeMediaPlayback.instanceId === instance.instanceId) {
        instance = activeMediaPlayback.instance;
    }

    if (sidebarHandler.isSidePanelAvailable()) {
        sidebarHandler.notifySidebar('update_sidebar_context', {
            tabId,
            instanceId: instance ? instance.instanceId : null,
            instance,
            packetUrl: context ? context.canonicalPacketUrl : null,
            currentUrl: instance ? context.currentBrowserUrl : null
        });
    }

    if (instance && context?.canonicalPacketUrl) {
        const itemForVisitTimer = instance.contents.find(i => i.url === context.canonicalPacketUrl);
        if (itemForVisitTimer && !itemForVisitTimer.interactionBasedCompletion) {
            clearPendingVisitTimer(tabId); // Ensure no old timer is running for this tab
            startVisitTimer(tabId, instance.instanceId, itemForVisitTimer.url, '[onActivated]');
        }
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

    const onCommittedWrapper = async (details) => {
        await initializationPromise;
        if (isRestoring) {
            logger.log('Background:onCommitted', 'Ignoring navigation event during restore.', { url: details.url });
            return;
        }
        onCommitted(details);
    };

    const onHistoryStateUpdatedWrapper = async (details) => {
        await initializationPromise;
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
    await notifyUIsOfStateChange();

    port.onDisconnect.addListener(async () => {
      await storage.setSession({ isSidebarOpen: false });
      
      if (activeMediaPlayback.pageId) {
          try {
              const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
              if (activeTab && activeTab.id) {
                  activeMediaPlayback.tabId = activeTab.id;
              }
          } catch (e) {
              logger.warn('Background:onDisconnect', 'Could not get active tab when sidebar closed.', e);
          }
      }
      await notifyUIsOfStateChange(null, { animate: true });
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

            const tabbableContents = instance.contents.filter(item =>
                item.type === 'external' || item.type === 'generated'
            );
            
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