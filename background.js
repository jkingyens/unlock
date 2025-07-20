// ext/background.js - Main service worker entry point (Global Side Panel Mode)
// REVISED: Added proactive state synchronization on startup to fix stale overlay issue.
// REVISED: The onActivated listener now passes an 'animate' flag to the overlay.
// REVISED: Centralized all playback and overlay visibility logic into setMediaPlaybackState.

// --- Imports ---
import {
    logger,
    storage,
    CONFIG,
    clearPacketContext,
    getPacketContext,
    setPacketContext,
    getDb,
    isTabGroupsAvailable,
    shouldUseTabGroups,
    packetUtils,
    GROUP_TITLE_PREFIX,
    getInstanceIdFromGroupTitle,
    indexedDbStorage
} from './utils.js';
import * as msgHandler from './background-modules/message-handlers.js';
import * as ruleManager from './background-modules/rule-manager.js';
import { onCommitted, onHistoryStateUpdated, checkAndPromptForCompletion } from './background-modules/navigation-handler.js';
import * as tabGroupHandler from './background-modules/tab-group-handler.js';
import * as sidebarHandler from './background-modules/sidebar-handler.js';
import cloudStorage from './cloud-storage.js';

const ACTIVE_MEDIA_KEY = 'activeMediaPlaybackState';
const AUDIO_KEEP_ALIVE_ALARM = 'audio-keep-alive';


// In-memory map for interim context transfer
export let interimContextMap = new Map();

// --- REVISED: State for Dynamic Island Feature ---
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

// Rule refresh alarm name
const RULE_REFRESH_ALARM_NAME = 'refreshRedirectRules';

// --- Centralized timer logic ---
const pendingVisitTimers = new Map();

function clearPendingVisitTimer(tabId) {
    if (pendingVisitTimers.has(tabId)) {
        clearTimeout(pendingVisitTimers.get(tabId));
        pendingVisitTimers.delete(tabId);
    }
}

async function handleTabVisit(tabId, url) {
    clearPendingVisitTimer(tabId); // Clear any existing timer for this tab

    const context = await getPacketContext(tabId);
    if (!context || !context.instanceId || !context.packetUrl) return;

    const instance = await storage.getPacketInstance(context.instanceId);
    if (!instance) return;

    const itemToVisit = packetUtils.isUrlInPacket(url, instance, { returnItem: true });

    if (itemToVisit && itemToVisit.interactionBasedCompletion !== true) {
        const settings = await storage.getSettings();
        const visitThresholdMs = (settings.visitThresholdSeconds ?? 5) * 1000;

        const visitTimer = setTimeout(async () => {
            pendingVisitTimers.delete(tabId);
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

            if (activeTab && activeTab.id === tabId) {
                const visitResult = await packetUtils.markUrlAsVisited(context.instanceId, itemToVisit.url);
                if (visitResult.success && visitResult.modified) {
                    const updatedInstance = visitResult.instance || await storage.getPacketInstance(context.instanceId);
                    if (sidebarHandler.isSidePanelAvailable()) {
                         sidebarHandler.notifySidebar('update_sidebar_context', {
                             tabId, instanceId: updatedInstance.instanceId, instance: updatedInstance, currentUrl: url, packetUrl: itemToVisit.url
                         });
                    }
                    await checkAndPromptForCompletion(`[Background:Timer]`, visitResult, context.instanceId);
                }
            }
        }, visitThresholdMs);
        pendingVisitTimers.set(tabId, visitTimer);
    }
}

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

// --- NEW: Universal Script Injection ---
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


// --- REVISED & CENTRALIZED: State Management and Broadcasting ---
export async function setMediaPlaybackState(newState, options = { animate: false }) {
    const oldLink = activeMediaPlayback.lastMentionedLink;
    const { lastMentionedLink, ...restOfNewState } = newState;
    const previousTabId = activeMediaPlayback.tabId;

    // 1. Update the central state object
    activeMediaPlayback = { ...activeMediaPlayback, ...restOfNewState };

    // 2. Recalculate derived state (e.g., mentioned links)
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
                const originalMentionedCount = (instance.mentionedMediaLinks || []).length;
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
                }

                if (mentionedUrls.size > originalMentionedCount) {
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

    // Handle keep-alive alarm
    if (!isPlaying && hasActiveTrack) {
        chrome.alarms.create(AUDIO_KEEP_ALIVE_ALARM, { periodInMinutes: 0.4 });
    } else {
        chrome.alarms.clear(AUDIO_KEEP_ALIVE_ALARM);
    }

    // Handle session persistence
    if (hasActiveTrack) {
        await storage.setSession({ [ACTIVE_MEDIA_KEY]: activeMediaPlayback });
    } else {
        await storage.removeSession(ACTIVE_MEDIA_KEY);
    }

    // 3. NEW: Determine overlay visibility within this function
    const { isSidebarOpen } = await storage.getSession({ isSidebarOpen: false });
    const isVisible = hasActiveTrack && !isSidebarOpen;

    // 4. Construct the complete state payload, including the animation flag
    const finalState = { ...activeMediaPlayback, isVisible, animate: options.animate };
    
    // 5. Broadcast the final, complete state
    // If the active tab has changed, hide the overlay on the old tab
    if (previousTabId && previousTabId !== activeMediaPlayback.tabId) {
         chrome.tabs.sendMessage(previousTabId, {
            action: 'sync_overlay_state',
            data: { isVisible: false } // A minimal message to hide it
        }).catch(e => {}); // Ignore errors, tab might be closed
    }

    // Always send the latest state to the current active tab
    if (activeMediaPlayback.tabId) {
        chrome.tabs.sendMessage(activeMediaPlayback.tabId, {
            action: 'sync_overlay_state',
            data: finalState
        }).catch(e => {}); // Ignore errors, script might not be injected yet
    }
    
    // Also notify the sidebar
    sidebarHandler.notifySidebar('playback_state_updated', activeMediaPlayback);
}


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
    logger.log('Background:restoreContext', 'Starting context restoration (Strict ID-as-Title)...');

    if (!(await shouldUseTabGroups())) {
        logger.log('Background:restoreContext', 'Tab Groups feature disabled, skipping restoration based on groups.');
        return;
    }

    try {
        const [allApiGroups, allTabs, instancesMap, browserStatesMap] = await Promise.all([
            chrome.tabGroups.query({}).catch(e => { logger.error('RestoreContext', 'Error querying groups', e); return []; }),
            chrome.tabs.query({}).catch(e => { logger.error('RestoreContext', 'Error querying tabs', e); return []; }),
            storage.getPacketInstances().catch(e => { logger.error('RestoreContext', 'Error getting instances', e); return {}; }),
            storage.getAllPacketBrowserStates().catch(e => { logger.error('RestoreContext', 'Error getting browser states', e); return {}; })
        ]);

        if (Object.keys(instancesMap).length === 0 ) {
            logger.log('Background:restoreContext', 'No instances to process. Skipping detailed restoration.');
            return;
        }

        if (allApiGroups.length === 0 && allTabs.length > 0) {
             logger.log('Background:restoreContext', 'No API groups, but tabs exist. Attempting to restore context for ungrouped tabs.');
             for (const tab of allTabs) {
                 if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
                     for (const instanceId in instancesMap) {
                         const instance = instancesMap[instanceId];
                         await linkTabsInGroup(chrome.tabGroups.TAB_GROUP_ID_NONE, instanceId, instance, [tab], null, true);
                     }
                 }
             }
        }

        const statesToUpdate = new Map();
        const matchedGroupIds = new Set();

        logger.log('Background:restoreContext', `Processing ${allApiGroups.length} API groups and ${Object.keys(instancesMap).length} instances.`);

        for (const group of allApiGroups) {
            if (!group.title) continue;

            const restoredInstanceId = getInstanceIdFromGroupTitle(group.title);

            if (restoredInstanceId && instancesMap[restoredInstanceId]) {
                const instanceData = instancesMap[restoredInstanceId];
                logger.log('Background:restoreContext', `MATCHED Group ID ${group.id} (Title: "${group.title}") to Instance ${restoredInstanceId}.`);

                let state = browserStatesMap[restoredInstanceId] ||
                            { instanceId: restoredInstanceId, tabGroupId: null, activeTabIds: [], lastActiveUrl: null };

                let stateChanged = false;
                if (state.tabGroupId !== group.id) {
                    logger.log('Background:restoreContext', `Updating PacketBrowserState for ${restoredInstanceId}: tabGroupId from ${state.tabGroupId} to ${group.id}.`);
                    state.tabGroupId = group.id;
                    stateChanged = true;
                }

                const oldActiveTabIdsCount = state.activeTabIds.length;
                await linkTabsInGroup(group.id, restoredInstanceId, instanceData, allTabs, state, false);
                if(state.activeTabIds.length !== oldActiveTabIdsCount) stateChanged = true;

                if (stateChanged || !browserStatesMap[restoredInstanceId]) {
                    statesToUpdate.set(restoredInstanceId, state);
                }
                matchedGroupIds.add(group.id);
            } else if (group.title.startsWith(GROUP_TITLE_PREFIX)) {
                logger.warn('Background:restoreContext', `Group "${group.title}" (ID: ${group.id}) has Unpack prefix but no matching instance found for parsed ID "${restoredInstanceId}".`);
            }
        }

        if (allApiGroups.length > 0) {
            let browserStatesCleanedCount = 0;
            for (const instanceId in browserStatesMap) {
                const state = browserStatesMap[instanceId];
                if (state.tabGroupId !== null && !matchedGroupIds.has(state.tabGroupId)) {
                    logger.log('Background:restoreContext', `Clearing stale tabGroupId ${state.tabGroupId} for instance ${instanceId} (group no longer found or title mismatched).`);
                    const updatedState = statesToUpdate.get(instanceId) || { ...state };
                    updatedState.tabGroupId = null;
                    updatedState.activeTabIds = [];
                    statesToUpdate.set(instanceId, updatedState);
                    browserStatesCleanedCount++;
                }
            }
            if (browserStatesCleanedCount > 0) {
                 logger.log('Background:restoreContext', `Cleaned stale tabGroupIds from ${browserStatesCleanedCount} browser states.`);
            }
        } else {
            logger.log('Background:restoreContext', 'Skipping stale tabGroupId cleanup because no groups were queryable at this time.');
        }

        const statesToSaveArray = Array.from(statesToUpdate.values());
        if (statesToSaveArray.length > 0) {
            logger.log('Background:restoreContext', `Saving ${statesToSaveArray.length} browser states...`);
            await Promise.all(
                statesToSaveArray.map(s => storage.savePacketBrowserState(s))
            );
            logger.log('Background:restoreContext', 'Browser states saved.');
        } else {
            logger.log('Background:restoreContext', 'No browser states needed updating after restoration.');
        }
        logger.log('Background:restoreContext', 'Strict ID-as-Title restoration finished.');
    } catch (error) {
        logger.error('Background:restoreContext', 'CRITICAL Error during context restoration', error);
    }
}

async function linkTabsInGroup(groupId, instanceId, instance, allTabs, browserState, isUngroupedCheck = false) {
    const tabsToProcess = isUngroupedCheck ? allTabs : allTabs.filter(tab => tab.groupId === groupId);

    if (tabsToProcess.length === 0) {
        if (browserState && browserState.activeTabIds.length > 0 && !isUngroupedCheck) {
            logger.log(`Background:linkTabsInGroup`, `Group ${groupId} for instance ${instanceId} has no tabs in API, clearing activeTabIds from state.`);
            browserState.activeTabIds = [];
        }
        return;
    }
    if (tabsToProcess.length === 0) return;

    logger.log(`Background:linkTabsInGroup`, `Linking ${tabsToProcess.length} tabs (Group/Context: ${isUngroupedCheck ? 'Ungrouped' : groupId}) to Instance ${instanceId}...`);

    const newActiveTabIdsForState = browserState ? [...(browserState.activeTabIds || [])] : [];

    for (const tab of tabsToProcess) {
        const currentTabLoadedUrl = tab.url || '';
        if (!currentTabLoadedUrl) continue; // Skip tabs with no URL

        let canonicalPacketKeyForContext = null;
        
        const matchedItem = packetUtils.isUrlInPacket(currentTabLoadedUrl, instance, { returnItem: true });

        if (matchedItem) {
            canonicalPacketKeyForContext = matchedItem.url;
            logger.log(`Background:linkTabsInGroup`, `MATCH! Tab ${tab.id} URL "${currentTabLoadedUrl.substring(0,100)}..." matches item "${canonicalPacketKeyForContext}" in instance ${instanceId}.`);
        } else {
            const existingTabContext = await getPacketContext(tab.id);
            if (existingTabContext && existingTabContext.instanceId === instanceId && existingTabContext.packetUrl) {
                canonicalPacketKeyForContext = existingTabContext.packetUrl;
                logger.log(`Background:linkTabsInGroup`, `Tab ${tab.id} URL "${currentTabLoadedUrl.substring(0,100)}..." did not directly match content, but existing context for instance ${instanceId} found with packetUrl: ${canonicalPacketKeyForContext}.`);
            } else {
                if (isUngroupedCheck) {
                    logger.log(`Background:linkTabsInGroup (Ungrouped)`, `Tab ${tab.id} URL "${currentTabLoadedUrl.substring(0,100)}..." not matched to instance ${instanceId} content.`);
                }
            }
        }

        if (canonicalPacketKeyForContext) {
            logger.log(`Background:linkTabsInGroup`, `Setting context for Tab ${tab.id}: Inst=${instanceId}, PacketKey=${canonicalPacketKeyForContext}, CurrentLoadedURL=${currentTabLoadedUrl.substring(0,100)}...`);
            await setPacketContext(tab.id, instanceId, canonicalPacketKeyForContext, currentTabLoadedUrl);
            if (browserState && !newActiveTabIdsForState.includes(tab.id)) {
                newActiveTabIdsForState.push(tab.id);
            }
        } else if (!isUngroupedCheck) {
            logger.warn(`Background:linkTabsInGroup`, `Tab ${tab.id} in group ${groupId} for instance ${instanceId} does not match any packet content. Clearing context and deleting tab.`);

            await clearPacketContext(tab.id);

            try {
                const allTabsInWindow = await chrome.tabs.query({ windowId: tab.windowId });
                if (allTabsInWindow.length > 1) {
                    await chrome.tabs.remove(tab.id);
                } else {
                    logger.warn(`Background:linkTabsInGroup`, `Skipped deleting tab ${tab.id} as it is the last tab in its window. Ungrouping instead.`);
                    await chrome.tabs.ungroup(tab.id);
                }
            } catch (e) {
                logger.error(`Background:linkTabsInGroup`, `Failed to remove or ungroup tab ${tab.id}`, e);
            }

            if (browserState && Array.isArray(browserState.activeTabIds) && browserState.activeTabIds.includes(tab.id)) {
                browserState.activeTabIds = browserState.activeTabIds.filter(id => id !== tab.id);
            }
        }
    }

    if (browserState) {
        const finalActiveIds = [...new Set(newActiveTabIdsForState)];
        if (JSON.stringify(browserState.activeTabIds.sort()) !== JSON.stringify(finalActiveIds.sort())) {
            logger.log(`Background:linkTabsInGroup`, `Updating activeTabIds for instance ${instanceId} from ${browserState.activeTabIds} to ${finalActiveIds}`);
            browserState.activeTabIds = finalActiveIds;
        }
    }
}

async function restoreMediaStateOnStartup() {
    const data = await storage.getSession(ACTIVE_MEDIA_KEY);
    if (data && data[ACTIVE_MEDIA_KEY]) {
        activeMediaPlayback = data[ACTIVE_MEDIA_KEY];
        logger.log('Background', 'Restored active media playback state from session storage.', activeMediaPlayback);
    }
}

async function cleanupStuckCreatingPackets() {
    logger.log('Background:CleanupStuck', 'Starting cleanup of old "creating" state packets...');
    const STUCK_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

    try {
        const allInstances = await storage.getPacketInstances();
        const now = Date.now();
        let stuckPacketsFound = 0;
        let cleanedCount = 0;
        for (const instanceId in allInstances) {
            const instance = allInstances[instanceId];
            if (instance && instance.status === 'creating') {
                stuckPacketsFound++;
                const createdTime = new Date(instance.created || instance.instantiated || 0).getTime();
                if ((now - createdTime) > STUCK_THRESHOLD_MS) {
                    logger.warn('Background:CleanupStuck', `Found stuck "creating" packet: ${instanceId} (Topic: ${instance.topic || 'N/A'}), created at ${new Date(createdTime).toISOString()}. Attempting cleanup.`);
                    const imageId = instance.imageId;
                    await storage.deletePacketInstance(instanceId);
                    logger.log('Background:CleanupStuck', `Deleted PacketInstance: ${instanceId}`);
                    await storage.deletePacketBrowserState(instanceId).catch(e => logger.warn('Background:CleanupStuck', `Error deleting browser state for ${instanceId}`, e));
                    if (imageId) {
                        const remainingInstancesForImage = await storage.getInstanceCountForImage(imageId);
                        if (remainingInstancesForImage === 0) {
                            logger.log('Background:CleanupStuck', `No other instances use image ${imageId}. Deleting image and its IDB content.`);
                            await storage.deletePacketImage(imageId).catch(e => logger.warn('Background:CleanupStuck', `Error deleting packet image ${imageId}`, e));
                            await indexedDbStorage.deleteGeneratedContentForImage(imageId).catch(e => logger.warn('Background:CleanupStuck', `Error deleting IDB content for image ${imageId}`, e));
                        }
                    }
                    await ruleManager.removePacketRules(instanceId); // Also remove rules for the stuck packet
                    cleanedCount++;
                    try { chrome.runtime.sendMessage({ action: 'packet_instance_deleted', data: { packetId: instanceId, source: 'stuck_creation_cleanup' } }); } catch (e) { /* ignore */ }
                }
            }
        }
        if (stuckPacketsFound === 0) logger.log('Background:CleanupStuck', 'No packets currently in "creating" state found.');
        else if (cleanedCount > 0) logger.log('Background:CleanupStuck', `Cleanup finished. Removed ${cleanedCount} stuck "creating" packets.`);
        else logger.log('Background:CleanupStuck', 'Cleanup finished. No "creating" packets were old enough to be removed with the current threshold.');
    } catch (error) {
        logger.error('Background:CleanupStuck', 'Error during cleanup of stuck creating packets', error);
    }
}


// --- Event Listeners ---
chrome.runtime.onInstalled.addListener(async (details) => {
    logger.log('Background:onInstalled', `Extension ${details.reason}`);
    await initializeStorageAndSettings();
    await restoreMediaStateOnStartup();
    await cloudStorage.initialize().catch(err => logger.error('Background:onInstalled', 'Initial cloud storage init failed', err));
    await ruleManager.refreshAllRules();

    attachNavigationListeners();

    // Universal script injection and state sync on install/reload
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    for (const tab of tabs) {
        if (tab.id) {
            injectOverlayScripts(tab.id);
            // FIX: Proactively send the initial (empty) state to fix stale overlays
            chrome.tabs.sendMessage(tab.id, {
                action: 'sync_overlay_state',
                data: { ...activeMediaPlayback, isVisible: false }
            }).catch(e => {});
        }
    }

    if (await shouldUseTabGroups()) {
         logger.log('Background:onInstalled', 'Tab Groups enabled, starting reorder checks.');
         tabGroupHandler.startTabReorderingChecks();
    } else {
         logger.log('Background:onInstalled', 'Tab Groups disabled, stopping reorder checks.');
         tabGroupHandler.stopTabReorderingChecks();
    }
    try {
        if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
             await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
             logger.log('Background:onInstalled', 'Set side panel behavior.');
        } else {
             logger.warn('Background:onInstalled', 'chrome.sidePanel.setPanelBehavior API not available.');
        }
    } catch (error) {
         logger.error('Background:onInstalled', 'Error setting side panel behavior:', error);
    }
    try { await getDb(); } catch (dbError) { logger.error('Background:onInstalled', 'Failed to initialize IndexedDB', dbError); }

    await garbageCollectTabContexts();
    await cleanupStuckCreatingPackets();

    chrome.alarms.create(RULE_REFRESH_ALARM_NAME, {
        delayInMinutes: 55,
        periodInMinutes: 55
    });
    logger.log('Background:onInstalled', `Alarm '${RULE_REFRESH_ALARM_NAME}' created.`);
});

chrome.runtime.onStartup.addListener(async () => {
     logger.log('Background:onStartup', 'Browser startup detected.');
     await initializeStorageAndSettings();
     await restoreMediaStateOnStartup();
     
     logger.log('Background:onStartup', 'Running immediate startup tasks...');
     try {
         await cloudStorage.initialize().catch(err => logger.error('Background:onStartup', 'Cloud storage init failed', err));
         await garbageCollectTabContexts();
         
         await restoreContextOnStartup();
         
         await ruleManager.refreshAllRules();
         await cleanupStuckCreatingPackets();

         attachNavigationListeners();
         
         // FIX: Sync state with existing tabs on browser startup
         const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
         for (const tab of tabs) {
             if (tab.id) {
                 chrome.tabs.sendMessage(tab.id, {
                     action: 'sync_overlay_state',
                     data: { ...activeMediaPlayback, isVisible: false }
                 }).catch(e => {});
             }
         }

         if (await shouldUseTabGroups()) {
             logger.log('Background:onStartup', 'Tab Groups enabled, starting reorder checks.');
             tabGroupHandler.startTabReorderingChecks();
         } else {
             logger.log('Background:onStartup', 'Tab Groups disabled, stopping reorder checks.');
             tabGroupHandler.stopTabReorderingChecks();
         }
         try { await getDb(); } catch (dbError) { logger.error('Background:onStartup', 'Delayed IndexedDB initialization failed', dbError); }
         logger.log('Background:onStartup', 'Immediate startup tasks complete.');
     } catch (error) {
         logger.error('Background:onStartup', 'Error during immediate startup tasks', error);
     }
 });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!cloudStorage.initialized) {
        cloudStorage.initialize().catch(err => logger.warn('Background:onMessage', 'Lazy cloud storage init failed', err));
    }
    return msgHandler.handleMessage(message, sender, sendResponse);
});

chrome.runtime.onMessageExternal.addListener(async (message, sender, sendResponse) => {
    const logPrefix = '[Unpack Background:onMessageExternal]';
    logger.log(logPrefix, 'Received external message', { message, sender });

    if (message.action === 'page_interaction_complete') {
        if (sender.tab && sender.tab.id) {
            const context = await getPacketContext(sender.tab.id);
            if (context && context.instanceId && context.packetUrl) {
                const { instanceId, packetUrl } = context;
                const visitResult = await packetUtils.markUrlAsVisited(instanceId, packetUrl);

                if (visitResult.success && visitResult.modified) {
                    const updatedInstance = visitResult.instance || await storage.getPacketInstance(instanceId);
                    if (updatedInstance) {
                        sidebarHandler.notifySidebar('packet_instance_updated', { instance: updatedInstance, source: 'page_interaction_complete_external' });
                    }
                }
                await checkAndPromptForCompletion(logPrefix, visitResult, instanceId);
                sendResponse({ success: true });
            } else {
                sendResponse({ success: false, error: 'No context found for sender tab.' });
            }
        } else {
            sendResponse({ success: false, error: 'External message did not have a sender tab.' });
        }
        return; // Keep channel open for async response
    }
    
    sendResponse({ success: false, error: 'Unknown external action' });
});


chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RULE_REFRESH_ALARM_NAME) {
        logger.log('Background:onAlarm', `Alarm '${alarm.name}' triggered. Refreshing rules.`);
        ruleManager.refreshAllRules();
    }
    if (alarm.name === AUDIO_KEEP_ALIVE_ALARM) {
      logger.log('Background:onAlarm', 'Audio keep-alive alarm triggered.');
    }
});

chrome.action.onClicked.addListener((tab) => {
    if (tab.id) {
        logger.log('Background:onClicked', `Action clicked for tab ${tab.id}. Opening side panel.`);
        chrome.sidePanel.open({ windowId: tab.windowId });
    }
});

chrome.tabs.onCreated.addListener(async (newTab) => {
    if (newTab.openerTabId) {
        const openerTabId = newTab.openerTabId;
        const newTabId = newTab.id;
        getPacketContext(openerTabId).then(sourceContext => {
            if (sourceContext && sourceContext.instanceId && sourceContext.packetUrl) {
                interimContextMap.set(newTabId, {
                    instanceId: sourceContext.instanceId,
                    packetUrl: sourceContext.packetUrl
                });
                logger.log(`Background:onCreated`, `Stored interim context for Tab ${newTabId} (Canonical PacketURL: ${sourceContext.packetUrl}) from opener ${openerTabId}`);
            }
        }).catch(error => {
            logger.error(`Background:onCreated`, `Error checking opener context for Tab ${newTabId}`, error);
        });
    }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url && (tab.url.startsWith('http') || tab.url.startsWith('file'))) {
        injectOverlayScripts(tabId);
    }
});

// REVISED: Centralized state update on activation, now with animation hint
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const tabId = activeInfo.tabId;
    const logPrefix = `[Unpack Background:onActivated Tab ${tabId}]`;
    
    // Update the tabId in the central state and trigger a broadcast.
    // This ensures the overlay moves correctly and has the right visibility.
    if (activeMediaPlayback.pageId) {
        // Pass the animate flag because this is a tab switch
        await setMediaPlaybackState({ tabId: tabId }, { animate: true });
    }

    if (typeof tabId !== 'number') { logger.warn(logPrefix, 'Exiting: Invalid tabId.', activeInfo); return; }

    let tabData = null;
    try {
        tabData = await chrome.tabs.get(tabId);
    } catch (tabError) {
        logger.warn(logPrefix, "Failed to get tab info, tab likely closed.", { message: tabError.message });
        return;
    }

    try {
        await sidebarHandler.updateActionForTab(tabId);

        if (tabData && tabData.status === 'complete') {
            const context = await getPacketContext(tabId);
            const instanceId = context?.instanceId || null;
            let instanceData = null;

            const urlToVisit = context?.currentUrl || tabData.url;
            if (urlToVisit) {
                await handleTabVisit(tabId, urlToVisit);
            }

            if (instanceId) {
                instanceData = await storage.getPacketInstance(instanceId).catch(e => null);
                if (!instanceData) {
                     logger.warn(logPrefix, `Instance data not found for existing context ${instanceId}. Clearing context.`);
                     await clearPacketContext(tabId);
                     await sidebarHandler.updateActionForTab(tabId);
                }
            }

            if (sidebarHandler.isSidePanelAvailable()) {
                 const contextToSend = {
                     tabId: tabId,
                     instanceId: instanceId && instanceData ? instanceId : null,
                     instance: instanceData,
                     packetUrl: context?.packetUrl || null,
                     currentUrl: tabData?.url || context?.currentUrl || null
                 };
                 sidebarHandler.notifySidebar('update_sidebar_context', contextToSend);
            }
        }
    } catch (error) {
         logger.error(logPrefix, 'CRITICAL Error processing tab activation', error);
    }
});


chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    const logPrefix = `[Unpack Background:onRemoved Tab ${tabId}]`;
    logger.log(logPrefix, 'Tab removed');
    
    clearPendingVisitTimer(tabId);

    if (interimContextMap.has(tabId)) {
        interimContextMap.delete(tabId);
        logger.log(logPrefix, `Removed interim context from MAP for closed tab ${tabId}.`);
    }
    await clearPacketContext(tabId);
    // Also clean up any draft tab tags from session storage
    await storage.removeSession(`draft_tab_${tabId}`);
    logger.log(logPrefix, `Cleaned up draft tag for tab ${tabId}.`);
    
    await tabGroupHandler.handleTabRemovalCleanup(tabId, removeInfo);
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
    logger.log('Background:onReplaced', 'Tab replaced', { addedTabId, removedTabId });
    injectOverlayScripts(addedTabId); // Inject into the new tab

    if (interimContextMap.has(removedTabId)) {
        interimContextMap.delete(removedTabId);
        logger.log(`Background:onReplaced`, `Removed interim context from MAP for replaced tab ${removedTabId}.`);
    }
    let oldContext = null;
    try { oldContext = await getPacketContext(removedTabId); }
    catch (e) { logger.warn('Background:onReplaced', 'Could not get context for removed tab', e); }
    await clearPacketContext(removedTabId);
    
    // Transfer draft tab tag as well
    const draftTagKey = `draft_tab_${removedTabId}`;
    const sessionData = await storage.getSession(draftTagKey);
    if (sessionData[draftTagKey]) {
        await storage.setSession({ [`draft_tab_${addedTabId}`]: sessionData[draftTagKey] });
        await storage.removeSession(draftTagKey);
        logger.log('Background:onReplaced', `Transferred draft tag from tab ${removedTabId} to ${addedTabId}.`);
    }

    try {
        if (oldContext && oldContext.instanceId && oldContext.packetUrl && oldContext.currentUrl) {
             logger.log('Background:onReplaced', `Attempting to apply old context to new tab ${addedTabId}`);
             await setPacketContext(addedTabId, oldContext.instanceId, oldContext.packetUrl, oldContext.currentUrl);
        }
        const allStates = await storage.getAllPacketBrowserStates();
        let stateWasModified = false;
        for (const instanceId in allStates) {
            const state = allStates[instanceId];
            const index = state.activeTabIds.indexOf(removedTabId);
            if (index !== -1) {
                state.activeTabIds.splice(index, 1);
                if (!state.activeTabIds.includes(addedTabId)) {
                    state.activeTabIds.push(addedTabId);
                }
                if (oldContext && oldContext.instanceId === instanceId) {
                   state.lastActiveUrl = oldContext.packetUrl;
                }
                await storage.savePacketBrowserState(state);
                stateWasModified = true;
                logger.log('Background:onReplaced', `Updated browser state for instance ${instanceId}`, { removedTabId, addedTabId });
                break;
            }
        }
         if (!stateWasModified && oldContext) {
             logger.warn('Background:onReplaced', `Old context existed for ${removedTabId} but no browser state found tracking it.`);
         }
    } catch(error) {
        logger.error('Background:onReplaced', 'Error transferring context or updating browser state', { error });
    }
});

// REVISED: Single, consolidated tabGroups.onUpdated listener
chrome.tabGroups.onUpdated.addListener(async (group) => {
    if (!group.title) {
        logger.log('Background:tabGroups.onUpdated', `Skipping group update for Group ${group.id} because title is empty.`);
        return;
    }

    if (group.collapsed === false) {
        logger.log('Background:tabGroups.onUpdated', `Group ${group.id} (Title: "${group.title}") was expanded. Triggering context and action update.`);
        
        await new Promise(resolve => setTimeout(resolve, 250));

        try {
            const restoredInstanceId = getInstanceIdFromGroupTitle(group.title);
            if (restoredInstanceId) {
                const [allTabsInGroup, instancesMap, browserStatesMap] = await Promise.all([
                    chrome.tabs.query({ groupId: group.id }),
                    storage.getPacketInstances(),
                    storage.getAllPacketBrowserStates()
                ]);

                if (allTabsInGroup.length === 0) {
                    logger.warn('Background:tabGroups.onUpdated', `Still no tabs found in group ${group.id} after delay. Aborting.`);
                    return;
                }

                if (instancesMap[restoredInstanceId]) {
                    const instanceData = instancesMap[restoredInstanceId];
                    let state = browserStatesMap[restoredInstanceId] || { instanceId: restoredInstanceId, tabGroupId: group.id, activeTabIds: [], lastActiveUrl: null };
                    if (state.tabGroupId !== group.id) {
                        state.tabGroupId = group.id;
                    }
                    await linkTabsInGroup(group.id, restoredInstanceId, instanceData, allTabsInGroup, state, false);
                    await storage.savePacketBrowserState(state);
                } else {
                     logger.warn('Background:tabGroups.onUpdated', `Expanded group ${group.id} has valid prefix but instance ${restoredInstanceId} was not found.`);
                }
            } else {
                logger.warn('Background:tabGroups.onUpdated', `Expanded group ${group.id} does not have a valid packet title format.`);
            }

            try {
                const [activeTab] = await chrome.tabs.query({ active: true, windowId: group.windowId });
                if (activeTab && activeTab.groupId === group.id) {
                    logger.log('Background:tabGroups.onUpdated', `Recomputing badge for active tab ${activeTab.id} in newly expanded group ${group.id}.`);
                    await sidebarHandler.updateActionForTab(activeTab.id);
                } else {
                    logger.log('Background:tabGroups.onUpdated', `Expanded group ${group.id}, but the active tab ${activeTab?.id} is not in it. Deferring to onActivated listener.`);
                }
            } catch (error) {
                logger.error('Background:tabGroups.onUpdated', `Error recomputing badge for expanded group ${group.id}`, error);
            }

        } catch (error) {
            logger.error('Background:tabGroups.onUpdated', `Error during context/action update for expanded group ${group.id}`, error);
        }
    }
});

function attachNavigationListeners() {
    if (!chrome.webNavigation) { logger.error('Background', 'WebNavigation API not available.'); return; }

    if (typeof onCommitted === 'function' && chrome.webNavigation.onCommitted.hasListener(onCommitted)) {
        chrome.webNavigation.onCommitted.removeListener(onCommitted);
    }
    if (typeof onHistoryStateUpdated === 'function' && chrome.webNavigation.onHistoryStateUpdated.hasListener(onHistoryStateUpdated)) {
        chrome.webNavigation.onHistoryStateUpdated.removeListener(onHistoryStateUpdated);
    }

    if (typeof onCommitted === 'function') {
        chrome.webNavigation.onCommitted.addListener(onCommitted);
    }
    if (typeof onHistoryStateUpdated === 'function') {
        chrome.webNavigation.onHistoryStateUpdated.addListener(onHistoryStateUpdated);
    }

    logger.log('Background', 'Core WebNavigation listeners (onCommitted, onHistoryStateUpdated) attached/re-attached.');
}

// --- REVISED: Sidebar connect/disconnect now uses the central state function ---
chrome.runtime.onConnect.addListener(async (port) => {
  if (port.name === 'sidebar') {
    await storage.setSession({ isSidebarOpen: true });
    logger.log('Background', 'Sidebar connected, triggering state update.');
    await setMediaPlaybackState({}, { animate: false }); // Trigger re-evaluation, no animation

    port.onDisconnect.addListener(async () => {
      await storage.setSession({ isSidebarOpen: false });
      logger.log('Background', 'Sidebar disconnected, triggering state update.');
      await setMediaPlaybackState({}, { animate: true }); // Trigger re-evaluation, animate if showing
    });
  }
});


// --- Immediate Actions on Service Worker Start ---
(async () => {
    await initializeStorageAndSettings(); // Ensure settings are loaded first
    await restoreMediaStateOnStartup(); // Restore state on load
    await cloudStorage.initialize().catch(err => logger.error('Background:InitialSetup', 'Initial cloud storage init failed', err));
    attachNavigationListeners(); // Attach listeners ASAP
    await getDb().catch(e => logger.error('Background:InitialSetup', 'Initial DB access failed on load', e));

    await garbageCollectTabContexts();
    await cleanupStuckCreatingPackets();

    logger.log('Background', 'Service Worker successfully started/restarted and initial tasks run.');
})();