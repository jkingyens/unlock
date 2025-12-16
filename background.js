// ext/background.js - Main service worker entry point (Global Side Panel Mode)
// This file is now refactored to delegate lifecycle and state management
// to the new PacketRuntime API. Its role is simplified to initialization,
// event listening, and dispatching tasks to the appropriate runtime instance.
// FIX: Added a chrome.tabGroups.onUpdated listener to robustly enforce the
// canonical tab order when tabs are manually reordered.
// FIX: Added chrome.sidePanel.setPanelBehavior to ensure sidebar opens on icon click.
// FIX: Added chrome.tabGroups.onRemoved to handle manual group deletion by user.
// REVISED: Removed legacy keep-alive alarm. Added waitForRestoration to prevent state desync on service worker wakeup.

import {
    logger,
    storage,
    getPacketContext,
    setPacketContext,
    clearPacketContext,
    getInstanceIdFromGroupTitle,
    CONFIG,
    shouldUseTabGroups,
    packetUtils,
    GROUP_TITLE_PREFIX
} from './utils.js';
import * as msgHandler from './background-modules/message-handlers.js';
import * as ruleManager from './background-modules/rule-manager.js';
import {
    onCommitted,
    onHistoryStateUpdated,
    onBeforeNavigate,
    startVisitTimer,
    injectOverlayScripts
} from './background-modules/navigation-handler.js';
import * as tabGroupHandler from './background-modules/tab-group-handler.js';
import * as sidebarHandler from './background-modules/sidebar-handler.js';
import PacketRuntime from './background-modules/packet-runtime.js';

// --- Global State ---
export let activeMediaPlayback = {
    instanceId: null,
    url: null,
    lrl: null,
    isPlaying: false,
    title: '',
    currentTime: 0,
    duration: 0,
    instance: null,
    lastTrippedMoment: null,
};
let creatingOffscreenDocument;
const reorderDebounceTimers = new Map();

// [FIX] Capture restoration promise immediately to handle race conditions with incoming messages
let restorationPromise = restoreMediaStateOnStartup();

export function waitForRestoration() {
    return restorationPromise;
}

// --- Offscreen Document and Audio Management ---

async function hasOffscreenDocument() {
    if (chrome.runtime && typeof chrome.runtime.getContexts === 'function') {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT']
        });
        return contexts.length > 0;
    }
    return false;
}

export async function setupOffscreenDocument() {
    // FORCE FRESH: If one exists, kill it to ensure we run latest code.
    if (await hasOffscreenDocument()) {
        await chrome.offscreen.closeDocument();
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

        const session = await storage.getSession({ isSidebarOpen: false });
        if (session.isSidebarOpen) {
            notifyOffscreenSidebarState(true);
        }
    }
}

export async function controlAudioInOffscreen(command, data) {
    await setupOffscreenDocument();
    return await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'control-audio',
        data: {
            command,
            data
        }
    });
}

export async function notifyOffscreenSidebarState(isOpen) {
    if (await hasOffscreenDocument()) {
        chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'set_sidebar_state',
            data: { isOpen }
        }).catch(() => { });
    }
}

export async function stopAndClearActiveAudio() {
    await controlAudioInOffscreen('stop', {});
    activeMediaPlayback = {
        instanceId: null,
        url: null,
        lrl: null,
        isPlaying: false,
        title: '',
        currentTime: 0,
        duration: 0,
        instance: null,
        lastTrippedMoment: null,
    };
    await storage.removeSession(CONFIG.STORAGE_KEYS.ACTIVE_MEDIA_KEY);
}

export async function resetActiveMediaPlayback() {
    await stopAndClearActiveAudio();
    await notifyUIsOfStateChange();
}

export async function saveCurrentTime(instanceId, url, providedCurrentTime, isStopping = false) {
    try {
        const instance = await storage.getPacketInstance(instanceId);
        if (!instance) return;
        const mediaItem = instance.contents.find(item => item.url === url && item.format === 'audio');
        if (!mediaItem) return;
        let timeToSave = providedCurrentTime;
        if (typeof timeToSave === 'undefined') {
            const response = await controlAudioInOffscreen('get_current_time', {
                url
            });
            if (response.success) timeToSave = response.currentTime;
        }
        if (typeof timeToSave === 'number') {
            mediaItem.currentTime = isStopping ? 0 : timeToSave;
            await storage.savePacketInstance(instance);
        }
    } catch (error) {
        logger.error('Background:saveCurrentTime', 'Error saving playback time', error);
    }
}


// --- State Synchronization ---

export async function notifyUIsOfStateChange(options = {}) {
    // FIX: Prefer the passed-in option (which is immediate) over the async storage read (which might be stale)
    let isSidebarOpen = options.isSidebarOpen;

    if (typeof isSidebarOpen === 'undefined') {
        isSidebarOpen = (await storage.getSession({
            isSidebarOpen: false
        })).isSidebarOpen;
    }

    const fullStateForSidebar = {
        ...activeMediaPlayback,
        instance: activeMediaPlayback.instance,
        ...options
    };

    sidebarHandler.notifySidebar('playback_state_updated', fullStateForSidebar);

    try {
        const [activeTab] = await chrome.tabs.query({
            active: true,
            currentWindow: true
        });
        if (!activeTab || !activeTab.id) return;

        const lightweightStateForOverlay = {
            isVisible: !isSidebarOpen && !!activeMediaPlayback.url,
            isPlaying: activeMediaPlayback.isPlaying,
            title: activeMediaPlayback.title,
            lastTrippedMoment: activeMediaPlayback.lastTrippedMoment,
            ...options
        };

        await chrome.tabs.sendMessage(activeTab.id, {
            action: 'update_overlay_state',
            data: lightweightStateForOverlay
        }).catch(() => { });

    } catch (e) { }
}

export async function setMediaPlaybackState(newState, options = {}) {
    activeMediaPlayback = {
        ...activeMediaPlayback,
        ...newState
    };
    if (activeMediaPlayback.instanceId && !activeMediaPlayback.instance) {
        activeMediaPlayback.instance = await storage.getPacketInstance(activeMediaPlayback.instanceId);
    }
    await storage.setSession({
        [CONFIG.STORAGE_KEYS.ACTIVE_MEDIA_KEY]: activeMediaPlayback
    });
    await notifyUIsOfStateChange(options);
}


// --- Initialization and Event Listeners ---

async function initializeExtension() {
    // --- START OF FIX: Enable Side Panel on Action Click ---
    if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
        await chrome.sidePanel.setPanelBehavior({
            openPanelOnActionClick: true
        })
            .catch((error) => logger.warn('Background:init', 'Failed to set panel behavior', error));
    }
    // --- END OF FIX ---

    await storage.getSettings();

    // [FIX] Wait for the global restoration promise instead of calling again
    await restorationPromise;

    await ruleManager.refreshAllRules();
    await tabGroupHandler.cleanupDraftGroup();

    const allInstances = await storage.getPacketInstances();
    for (const instanceId in allInstances) {
        const runtime = new PacketRuntime(allInstances[instanceId]);
        await runtime.start();
    }

    await restoreContextOnStartup();
    await reinjectScriptsOnStartup();
}

async function reinjectScriptsOnStartup() {
    logger.log('Background:reinject', 'Scanning ALL open tabs to re-inject overlay scripts...');
    try {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
            if (!tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) continue;
            await injectOverlayScripts(tab.id);
        }
    } catch (error) {
        logger.error('Background:reinject', 'Error during script re-injection', error);
    }
}

chrome.runtime.onInstalled.addListener(initializeExtension);
chrome.runtime.onStartup.addListener(initializeExtension);
chrome.runtime.onMessage.addListener(msgHandler.handleMessage);

// --- Connection Listener for Sidebar ---
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'sidebar') {
        sidebarHandler.handleSidebarConnection(port);
        notifyOffscreenSidebarState(true);

        // --- FIX: Immediate UI Notification ---
        // Forces the overlay to HIDE because the sidebar is now open
        notifyUIsOfStateChange({ isSidebarOpen: true });

        port.onDisconnect.addListener(() => {
            // Forces the overlay to SHOW because the sidebar is now closed
            notifyUIsOfStateChange({ isSidebarOpen: false, animate: true });
            notifyOffscreenSidebarState(false);
        });
    }
});

// --- Tab and Group Event Listeners ---

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    await sidebarHandler.updateActionForTab(activeInfo.tabId);
    const context = await getPacketContext(activeInfo.tabId);
    let instance = context ? await storage.getPacketInstance(context.instanceId) : null;
    let packetUrl = context ? context.canonicalPacketUrl : null;

    if (activeMediaPlayback.instance && (!instance || instance.instanceId !== activeMediaPlayback.instanceId)) {
        instance = activeMediaPlayback.instance;
        packetUrl = null;
    }

    if (instance && packetUrl) {
        const itemForVisitTimer = instance.contents.find(i => i.url === packetUrl);
        if (itemForVisitTimer && !itemForVisitTimer.interactionBasedCompletion) {
            startVisitTimer(activeInfo.tabId, instance.instanceId, itemForVisitTimer.url, `[onActivated]`);
        }
    }

    sidebarHandler.notifySidebar('update_sidebar_context', {
        tabId: activeInfo.tabId,
        instanceId: instance ? instance.instanceId : null,
        instance: instance,
        packetUrl: packetUrl
    });

    await notifyUIsOfStateChange({
        animate: false
    });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (tab.url && tab.url.startsWith('http')) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['selector.js']
            });
            await chrome.scripting.insertCSS({
                target: { tabId: tabId },
                files: ['selector.css']
            });
        } catch (e) { }
    }
});


chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    tabGroupHandler.handleTabRemovalCleanup(tabId, removeInfo);
    clearPacketContext(tabId);
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
    const oldContext = await getPacketContext(removedTabId);
    if (oldContext) {
        await setPacketContext(addedTabId, oldContext.instanceId, oldContext.canonicalPacketUrl, oldContext.currentBrowserUrl);
        await clearPacketContext(removedTabId);
    }
});

chrome.tabs.onMoved.addListener(async (tabId, moveInfo) => {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.groupId && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
            await scheduleReorder(tab.groupId);
        }
    } catch (e) { }
});

// --- START OF FIX: Add robust listener for all group changes ---
if (chrome.tabGroups) {
    chrome.tabGroups.onUpdated.addListener(async (group) => {
        if (group.title && group.title.startsWith(GROUP_TITLE_PREFIX)) {
            await scheduleReorder(group.id);
        }
    });

    // --- NEW: Handle manual group removal ---
    chrome.tabGroups.onRemoved.addListener((group) => {
        tabGroupHandler.handleTabGroupRemoved(group.id);
    });
}
// --- END OF FIX ---

chrome.webNavigation.onBeforeNavigate.addListener(onBeforeNavigate);
chrome.webNavigation.onCommitted.addListener(onCommitted);
chrome.webNavigation.onHistoryStateUpdated.addListener(onHistoryStateUpdated);

// --- Helper Functions ---

async function scheduleReorder(groupId) {
    if (reorderDebounceTimers.has(groupId)) {
        clearTimeout(reorderDebounceTimers.get(groupId));
    }
    const timerId = setTimeout(() => {
        reorderGroupFromChangeEvent(groupId)
            .catch(err => logger.error("DebouncedReorder", `Error reordering group ${groupId}`, err));
        reorderDebounceTimers.delete(groupId);
    }, 350);
    reorderDebounceTimers.set(groupId, timerId);
}

async function reorderGroupFromChangeEvent(groupId) {
    if (!groupId || !(await shouldUseTabGroups())) return;
    try {
        const group = await chrome.tabGroups.get(groupId);
        const instanceId = getInstanceIdFromGroupTitle(group.title);
        if (instanceId) {
            const instance = await storage.getPacketInstance(instanceId);
            if (instance) {
                await tabGroupHandler.orderTabsInGroup(groupId, instance);
            }
        }
    } catch (error) {
        // Group may no longer exist, which is fine.
    }
}

async function restoreMediaStateOnStartup() {
    const data = await storage.getSession(CONFIG.STORAGE_KEYS.ACTIVE_MEDIA_KEY);
    if (data && data[CONFIG.STORAGE_KEYS.ACTIVE_MEDIA_KEY]) {
        activeMediaPlayback = data[CONFIG.STORAGE_KEYS.ACTIVE_MEDIA_KEY];
        if (activeMediaPlayback.instanceId) {
            activeMediaPlayback.instance = await storage.getPacketInstance(activeMediaPlayback.instanceId);
        }
    }
}

async function restoreContextOnStartup() {
    if (!(await shouldUseTabGroups())) {
        return;
    }
    try {
        const allGroups = await chrome.tabGroups.query({});
        for (const group of allGroups) {
            const instanceId = getInstanceIdFromGroupTitle(group.title);
            if (!instanceId) continue;

            const instance = await storage.getPacketInstance(instanceId);
            if (!instance) continue;

            const tabsInGroup = await chrome.tabs.query({
                groupId: group.id
            });
            for (const tab of tabsInGroup) {
                const contentItem = packetUtils.isUrlInPacket(tab.url, instance, {
                    returnItem: true
                });
                if (contentItem) {
                    await setPacketContext(tab.id, instance.instanceId, contentItem.url, tab.url);
                    await sidebarHandler.updateActionForTab(tab.id);
                }
            }
        }
    } catch (error) {
        logger.error('Background:restoreContext', 'Error during context restoration', error);
    }
}