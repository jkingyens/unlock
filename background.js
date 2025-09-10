// ext/background.js - Main service worker entry point (Global Side Panel Mode)
// FINAL REVISION: The resetActiveMediaPlayback function now sends an explicit 'stop'
// command to the offscreen document to ensure audio is halted immediately.
// REVISED: The onStartup handler now ensures that clearing the instance cache is
// a blocking operation within the initialization promise, fixing a race condition
// where caches could persist across restarts.
// REVISED: Removed blob URL restoration from startup. It now happens within the
// onActivated listener, which detects if a tab's actual URL mismatches its expected
// blob URL context and reloads it from cache just-in-time.
// REVISED: The onActivated listener now unconditionally reloads any tab whose context
// points to a blob: URL, assuming it's always stale after a restart.
// REVISED: The fallback mechanism within the onActivated blob restoration logic now
// correctly reconstructs the canonical cloud URL to prevent invalid chrome-extension:// URLs.
// REVISED: The notifyUIsOfStateChange function now explicitly sends a hide message
// to the overlay when the sidebar is opened, ensuring it disappears immediately.
// REVISED: Moved the proactive blob restoration logic to the onUpdated listener to fix
// tabs as they finish loading on startup, before they are activated.

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
import { onCommitted, onHistoryStateUpdated, checkAndPromptForCompletion, startVisitTimer, clearPendingVisitTimer, onBeforeNavigate } from './background-modules/navigation-handler.js';
import * as tabGroupHandler from './background-modules/tab-group-handler.js';
import * as sidebarHandler from './background-modules/sidebar-handler.js';
import cloudStorage from '../cloud-storage.js';

// --- START: New Migration Logic ---
async function migratePacketImagesIfNecessary() {
    const MIGRATION_FLAG_LRL = 'packetImageMigrationLrlComplete';
    const flags = await storage.getLocal([MIGRATION_FLAG_LRL]);

    if (flags[MIGRATION_FLAG_LRL]) {
        logger.log('Background:Migration', 'All migrations already completed. Skipping.');
        return;
    }

    logger.log('Background:Migration', 'Running one-time migration for LRL fields...');
    const allImages = await storage.getPacketImages();
    let imagesToUpdate = {};
    let migrationNeeded = false;

    for (const imageId in allImages) {
        let image = { ...allImages[imageId] };
        let wasModified = false;

        if (image.sourceContent && Array.isArray(image.sourceContent)) {
            image.sourceContent.forEach(item => {
                // If an item is internal and has a URL but no LRL, it's from the old format.
                if (item.origin === 'internal' && item.url && !item.lrl) {
                    item.lrl = item.url; // The old URL is the new LRL.
                    item.url = null;      // The new URL should be null until published.
                    wasModified = true;
                }
            });
        }

        if (wasModified) {
            migrationNeeded = true;
            logger.log('Background:Migration', `Migrated LRL fields for packet image: ${imageId}`);
        }
        
        imagesToUpdate[imageId] = image;
    }

    if (migrationNeeded) {
        await storage.setLocal({ [CONFIG.STORAGE_KEYS.PACKET_IMAGES]: imagesToUpdate });
        logger.log('Background:Migration', 'Completed LRL field migration for all applicable Packet Images.');
    }

    await storage.setLocal({ [MIGRATION_FLAG_LRL]: true });
}

async function migrateHtmlContentToIndexedDb() {
    const MIGRATION_FLAG_HTML = 'htmlContentMigrationToIndexedDbComplete';
    const flags = await storage.getLocal([MIGRATION_FLAG_HTML]);

    if (flags[MIGRATION_FLAG_HTML]) {
        logger.log('Background:Migration', 'HTML content migration already completed. Skipping.');
        return;
    }

    logger.log('Background:Migration', 'Running one-time migration for embedded HTML content...');
    const allImages = await storage.getPacketImages();
    let imagesToUpdate = { ...allImages };
    let migrationNeeded = false;

    for (const imageId in imagesToUpdate) {
        let image = imagesToUpdate[imageId];
        let wasModified = false;

        if (image.sourceContent && Array.isArray(image.sourceContent)) {
            for (const item of image.sourceContent) {
                // Check for internal HTML items with the old base64 property
                if (item.origin === 'internal' && item.format === 'html' && item.contentB64) {
                    try {
                        const htmlBuffer = base64Decode(item.contentB64);
                        const indexedDbKey = sanitizeForFileName(item.lrl);

                        await indexedDbStorage.saveGeneratedContent(imageId, indexedDbKey, [{
                            name: 'index.html',
                            content: htmlBuffer,
                            contentType: item.contentType || 'text/html'
                        }]);
                        
                        // Clean the property from the image object
                        delete item.contentB64;
                        
                        wasModified = true;
                        logger.log('Background:Migration', `Migrated HTML content for item "${item.lrl}" in image: ${imageId}`);

                    } catch (error) {
                        logger.error('Background:Migration', `Failed to migrate HTML content for item in image ${imageId}`, { item, error });
                    }
                }
            }
        }

        if (wasModified) {
            migrationNeeded = true;
        }
    }

    if (migrationNeeded) {
        await storage.setLocal({ [CONFIG.STORAGE_KEYS.PACKET_IMAGES]: imagesToUpdate });
        logger.log('Background:Migration', 'Completed saving all packet images after HTML content migration.');
    } else {
        logger.log('Background:Migration', 'No embedded HTML content found to migrate.');
    }

    await storage.setLocal({ [MIGRATION_FLAG_HTML]: true });
}

async function migrateSummaryPagesToCacheable() {
    const MIGRATION_FLAG_CACHEABLE = 'summaryPageCacheableMigrationComplete';
    const flags = await storage.getLocal([MIGRATION_FLAG_CACHEABLE]);

    if (flags[MIGRATION_FLAG_CACHEABLE]) {
        return; // Migration already done
    }

    logger.log('Background:Migration', 'Running one-time migration to mark summary pages as cacheable...');
    const allImages = await storage.getPacketImages();
    let imagesToUpdate = { ...allImages };
    let migrationNeeded = false;

    for (const imageId in imagesToUpdate) {
        let image = imagesToUpdate[imageId];
        let wasModified = false;

        if (image.sourceContent && Array.isArray(image.sourceContent)) {
            image.sourceContent.forEach(item => {
                if (item.origin === 'internal' && item.format === 'html' && item.cacheable !== true) {
                    item.cacheable = true;
                    wasModified = true;
                }
            });
        }

        if (wasModified) {
            migrationNeeded = true;
            logger.log('Background:Migration', `Marked internal HTML as cacheable for packet image: ${imageId}`);
        }
    }

    if (migrationNeeded) {
        await storage.setLocal({ [CONFIG.STORAGE_KEYS.PACKET_IMAGES]: imagesToUpdate });
        logger.log('Background:Migration', 'Completed updating cacheable flags for all applicable packet images.');
    }

    await storage.setLocal({ [MIGRATION_FLAG_CACHEABLE]: true });
}
// --- END: New Migration Logic ---


attachNavigationListeners();
const reorderDebounceTimers = new Map();

async function scheduleReorder(groupId) {
    if (!groupId || !(await shouldUseTabGroups())) return;
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

chrome.tabs.onCreated.addListener(async (tab) => {
    if (tab.groupId && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        await scheduleReorder(tab.groupId);
    }
});

chrome.tabs.onAttached.addListener(async (tabId, attachInfo) => {
    await scheduleReorder(attachInfo.newGroupId);
});

chrome.tabs.onMoved.addListener(async (tabId, moveInfo) => {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.groupId && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
            await scheduleReorder(tab.groupId);
        }
    } catch (e) {}
});

let isRestoring = true;
let resolveInitialization;

const initializationPromise = new Promise(resolve => {
    resolveInitialization = resolve;
});

(async () => {
    const isBrowserStartupComplete = await storage.getSession('isBrowserStartupComplete');
    if (isBrowserStartupComplete) {
        isRestoring = false;
        logger.log('Background:Lifecycle', 'Service worker woke up. Initialization complete.');
        resolveInitialization();
    }
})();

const AUDIO_KEEP_ALIVE_ALARM = 'audio-keep-alive';

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

export async function resetActiveMediaPlayback() {
    await controlAudioInOffscreen('stop', {});
    if (activeMediaPlayback.isPlaying && activeMediaPlayback.instance) {
        await saveCurrentTime(activeMediaPlayback.instanceId, activeMediaPlayback.url, 0, true);
    }
    logger.log('Background', 'CRITICAL LOG: Resetting global activeMediaPlayback state.');
    activeMediaPlayback = {
        instanceId: null, url: null, lrl: null, isPlaying: false, title: '',
        currentTime: 0, duration: 0, instance: null, lastTrippedMoment: null,
    };
    await storage.removeSession(CONFIG.STORAGE_KEYS.ACTIVE_MEDIA_KEY);
    await notifyUIsOfStateChange();
}

const RULE_REFRESH_ALARM_NAME = 'refreshRedirectRules';

async function initializeStorageAndSettings() {
    await storage.getSettings();
    logger.log('Background', 'Storage and settings initialized/verified.');
}

let creatingOffscreenDocument;

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
    try {
        if (await hasOffscreenDocument()) return;
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
        creatingOffscreenDocument = null;
        throw error;
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

async function injectOverlayScripts(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        // This function now ONLY injects into external web pages.
        // Internal pages like preview.html handle their own overlay.
        if (!tab || !tab.url || !tab.url.startsWith('http')) {
            return;
        }
        
        await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['overlay.js'] });
        await chrome.scripting.insertCSS({ target: { tabId: tabId }, files: ['overlay.css'] });
    } catch (e) {
        const expectedErrors = ["Cannot access a chrome:// URL", "The tab was closed.", "No tab with id", "Cannot access contents of the page", "Frame with ID 0 was removed."];
        if (!expectedErrors.some(msg => e.message.includes(msg))) {
            logger.error('Background:injectOverlayScripts', `Failed to inject scripts into tab ${tabId}`, e);
        }
    }
}

function findMediaItemInInstance(instance, url) {
    if (!instance || !instance.contents || !url) return null;
    return instance.contents.find(item => item.url === url && item.format === 'audio');
}

export async function saveCurrentTime(instanceId, url, providedCurrentTime, isStopping = false) {
    try {
        const instance = await storage.getPacketInstance(instanceId);
        if (!instance) return;
        const mediaItem = findMediaItemInInstance(instance, url);
        if (!mediaItem) return;
        let timeToSave = providedCurrentTime;
        if (typeof timeToSave === 'undefined') {
            const response = await controlAudioInOffscreen('get_current_time', { url });
            if (response.success) timeToSave = response.currentTime;
        }
        if (typeof timeToSave === 'number') {
            mediaItem.currentTime = isStopping ? 0 : timeToSave;
            await storage.savePacketInstance(instance);
            logger.log('Background:saveCurrentTime', `Saved currentTime ${mediaItem.currentTime} for ${url}`);
        }
    } catch (error) {
        logger.error('Background:saveCurrentTime', 'Error saving playback time', error);
    }
}

export async function notifyUIsOfStateChange(options) {
    const effectiveOptions = options || {};
    
    const isSidebarOpen = typeof effectiveOptions.isSidebarOpen === 'boolean'
        ? effectiveOptions.isSidebarOpen
        : (await storage.getSession({ isSidebarOpen: false })).isSidebarOpen;

    const fullStateForSidebar = {
        ...activeMediaPlayback,
        instance: activeMediaPlayback.instance,
        momentsTripped: activeMediaPlayback.instance?.momentsTripped || [],
        ...effectiveOptions
    };
    sidebarHandler.notifySidebar('playback_state_updated', fullStateForSidebar);

    try {
        const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
        for (const tab of tabs) {
            if (!tab.id) continue;

            const overlayEnabled = await shouldShowOverlay();
            let isPathBlocked = false;
            if (tab.url) {
                try {
                    const url = new URL(tab.url);
                    if (url.pathname === '/item') isPathBlocked = true;
                } catch (e) {}
            }

            const lightweightStateForOverlay = {
                isVisible: !isSidebarOpen && !!activeMediaPlayback.url && overlayEnabled && !isPathBlocked,
                isPlaying: activeMediaPlayback.isPlaying,
                title: activeMediaPlayback.title,
                lastTrippedMoment: activeMediaPlayback.lastTrippedMoment,
                showVisitedAnimation: !!effectiveOptions.showVisitedAnimation,
                animate: !!effectiveOptions.animate,
            };
            
            await injectOverlayScripts(tab.id);
            await chrome.tabs.sendMessage(tab.id, {
                action: 'update_overlay_state',
                data: lightweightStateForOverlay
            }).catch(() => {});
        }
    } catch (e) {
        if (!e.message.toLowerCase().includes('no tab with id')) {
            logger.error('Background:notifyUIs', 'Error notifying overlay', e);
        }
    }
}

export async function setMediaPlaybackState(newState, options = { animate: false, source: 'unknown' }) {
    const oldInstanceId = activeMediaPlayback.instanceId;
    const newInstanceId = newState.instanceId || oldInstanceId;
    activeMediaPlayback = { ...activeMediaPlayback, ...newState };
    if (newInstanceId && (newInstanceId !== oldInstanceId || !activeMediaPlayback.instance)) {
        try {
            activeMediaPlayback.instance = await storage.getPacketInstance(newInstanceId);
            logger.log('Background:setMediaPlaybackState', `Loaded/reloaded live instance data for ${newInstanceId} into active media state.`);
        } catch (error) {
            logger.error('Background:setMediaPlaybackState', `Failed to load instance ${newInstanceId}`, error);
            await resetActiveMediaPlayback();
            return;
        }
    }
    const isPlaying = activeMediaPlayback.isPlaying;
    const hasActiveTrack = !!activeMediaPlayback.url;
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
        if (activeMediaPlayback.instanceId) {
            activeMediaPlayback.instance = await storage.getPacketInstance(activeMediaPlayback.instanceId);
        }
    }
}

chrome.runtime.onInstalled.addListener(async (details) => {
    try {
        logger.log('Background:onInstalled', `Extension ${details.reason}`);
        await initializeStorageAndSettings();
        
        await indexedDbStorage.garbageCollectIndexedDbContent();
        await migratePacketImagesIfNecessary();
        await migrateHtmlContentToIndexedDb(); 
        await migrateSummaryPagesToCacheable(); 

        await indexedDbStorage.debugDumpIndexedDb();
        await restoreMediaStateOnStartup();
        await cloudStorage.initialize().catch(err => logger.error('Background:onInstalled', 'Initial cloud storage init failed', err));
        
        await ruleManager.refreshAllRules();
        
        logger.log('Background:onInstalled', 'Re-injecting overlay scripts into existing web tabs.');
        const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
        for (const tab of tabs) {
            if (tab.id) {
                injectOverlayScripts(tab.id).catch(e => { /* Silently ignore errors for restricted pages */ });
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
        chrome.alarms.create(RULE_REFRESH_ALARM_NAME, { delayInMinutes: 55, periodInMinutes: 55 });
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

        await initializationPromise;

        await migratePacketImagesIfNecessary();
        await migrateHtmlContentToIndexedDb();
        await migrateSummaryPagesToCacheable();

        await indexedDbStorage.debugDumpIndexedDb();
        await restoreMediaStateOnStartup();
        await cloudStorage.initialize().catch(err => {});
        await restoreContextOnStartup();
        await ruleManager.refreshAllRules();
        await getDb();
        await garbageCollectTabContexts();
        await tabGroupHandler.cleanupDraftGroup();
        
        logger.log('Background:onStartup', 'Injecting overlay scripts into existing web tabs.');
        const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
        for (const tab of tabs) {
            if (tab.id) {
                injectOverlayScripts(tab.id).catch(e => { /* Silently ignore errors for restricted pages */ });
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
            const instance = await storage.getPacketInstance(context.instanceId);
            const visitResult = await packetUtils.markUrlAsVisited(instance, context.canonicalPacketUrl);
            if (visitResult.success && visitResult.modified) {
                await storage.savePacketInstance(visitResult.instance);
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

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' || !tab.url) {
        return;
    }

    const tabContext = await getPacketContext(tabId);

    if (tabContext?.currentBrowserUrl?.startsWith('blob:') && tab.url !== tabContext.currentBrowserUrl) {
        logger.log('Background:onUpdated', `Stale blob URL detected for tab ${tabId}. Attempting proactive restoration.`);
        
        try {
            const instance = await storage.getPacketInstance(tabContext.instanceId);
            const item = packetUtils.isUrlInPacket(tabContext.canonicalPacketUrl, instance, { returnItem: true });

            if (instance && item && item.lrl) {
                const indexedDbKey = sanitizeForFileName(item.lrl);
                const cachedContent = await indexedDbStorage.getGeneratedContent(instance.instanceId, indexedDbKey);

                if (cachedContent && cachedContent[0]?.content) {
                    const fullHtml = new TextDecoder().decode(cachedContent[0].content);
                    await setupOffscreenDocument();
                    const offscreenResponse = await chrome.runtime.sendMessage({
                        target: 'offscreen', type: 'create-blob-url', data: { html: fullHtml }
                    });

                    if (offscreenResponse.success) {
                        logger.log('Background:onUpdated', `Restoring content for tab ${tabId} with new blob URL.`);
                        const trustedIntent = {
                            instanceId: tabContext.instanceId,
                            canonicalPacketUrl: tabContext.canonicalPacketUrl
                        };
                        await storage.setSession({ [`trusted_intent_${tabId}`]: trustedIntent });
                        await chrome.tabs.update(tabId, { url: offscreenResponse.blobUrl });
                        return;
                    }
                }
            }
            
            logger.warn('Background:onUpdated', `Could not restore blob content for tab ${tabId}. Falling back to cloud URL.`);
            const fallbackUrl = cloudStorage.constructPublicUrl(tabContext.canonicalPacketUrl, item.publishContext);
            if (fallbackUrl) {
                await chrome.tabs.update(tabId, { url: fallbackUrl });
            }
        } catch (error) {
            if (!error.message.toLowerCase().includes('no tab with id')) {
                 logger.error('Background:onUpdated', `Error during proactive blob restoration for tab ${tabId}`, error);
            }
        }
    }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const closingState = await storage.getSession('isClosingGroup');
    if (closingState && closingState.isClosingGroup) {
        logger.log('Background:onActivated', 'Ignoring tab activation event due to tab group closure in progress.');
        return;
    }
    
    const tabId = activeInfo.tabId;
    
    await sidebarHandler.updateActionForTab(tabId);

    let context_to_send = {};
    const tabContext = await getPacketContext(tabId);

    if (tabContext && tabContext.instanceId) {
        context_to_send = {
            instanceId: tabContext.instanceId,
            instance: await storage.getPacketInstance(tabContext.instanceId),
            packetUrl: tabContext.canonicalPacketUrl,
            currentUrl: tabContext.currentBrowserUrl,
        };
    } 
    else if (activeMediaPlayback.url && activeMediaPlayback.instance) {
        context_to_send = {
            instanceId: activeMediaPlayback.instanceId,
            instance: activeMediaPlayback.instance,
            packetUrl: null,
            currentUrl: (await chrome.tabs.get(tabId)).url,
        };
    } 
    else {
        context_to_send = { instanceId: null, instance: null, packetUrl: null, currentUrl: null };
    }

    if (sidebarHandler.isSidePanelAvailable()) {
        sidebarHandler.notifySidebar('update_sidebar_context', {
            tabId,
            ...context_to_send
        });
    }

    if (tabContext && tabContext.instanceId) {
        const instance = await storage.getPacketInstance(tabContext.instanceId);
        if (instance) {
             const itemForVisitTimer = instance.contents.find(i => i.url === tabContext.canonicalPacketUrl);
             if (itemForVisitTimer && !itemForVisitTimer.interactionBasedCompletion) {
                 clearPendingVisitTimer(tabId);
                 startVisitTimer(tabId, instance.instanceId, itemForVisitTimer.url, '[onActivated]');
             }
        }
    }

    // Always notify the UI (especially the overlay) of the current media state
    // when a tab is activated. This ensures stale overlays are hidden.
    await notifyUIsOfStateChange({ animate: false });
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
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
    
    const onBeforeNavigateWrapper = async (details) => {
        await initializationPromise;
        if (isRestoring) return;
        onBeforeNavigate(details);
    };

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

    if (chrome.webNavigation.onBeforeNavigate.hasListener(onBeforeNavigate)) {
        chrome.webNavigation.onBeforeNavigate.removeListener(onBeforeNavigate);
    }
    if (chrome.webNavigation.onCommitted.hasListener(onCommitted)) {
        chrome.webNavigation.onCommitted.removeListener(onCommitted);
    }
    if (chrome.webNavigation.onHistoryStateUpdated.hasListener(onHistoryStateUpdated)) {
        chrome.webNavigation.onHistoryStateUpdated.removeListener(onHistoryStateUpdated);
    }

    chrome.webNavigation.onBeforeNavigate.addListener(onBeforeNavigateWrapper);
    chrome.webNavigation.onCommitted.addListener(onCommittedWrapper);
    chrome.webNavigation.onHistoryStateUpdated.addListener(onHistoryStateUpdatedWrapper);
}

// The onConnect listener was removed as part of a previous fix.
// The sidebar now uses explicit messages ('sidebar_opened', 'sidebar_closed')
// for more reliable state management.

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
            const tabbableContents = instance.contents.filter(item => item.format === 'html');
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