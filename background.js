// ext/background.js - Main service worker entry point (Global Side Panel Mode)
// REVISED: Uses declarativeNetRequest via rule-manager.js instead of onBeforeNavigate.
// REVISED: Sets up a chrome.alarms trigger to periodically refresh redirect rules.
// REVISED: Calls ruleManager.refreshAllRules on startup and install.

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

// In-memory map for interim context transfer
export let interimContextMap = new Map();

// Rule refresh alarm name
const RULE_REFRESH_ALARM_NAME = 'refreshRedirectRules';

// --- Helper: Initialize Storage ---
async function initializeStorageAndSettings() {
    await storage.getSettings(); // Ensures defaults are applied if nothing exists
    logger.log('Background', 'Storage and settings initialized/verified.');
}

// --- REVISED: Listener for sidebar connection ---
chrome.runtime.onConnect.addListener(async (port) => {
  if (port.name === 'sidebar') {
    // Set the state in session storage, which persists across service worker restarts.
    await storage.setSession({ isSidebarOpen: true });
    logger.log('Background', 'Sidebar connected, set session state to OPEN.');

    // FIX: Immediately update the action for the currently active tab.
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0] && tabs[0].id) {
            await sidebarHandler.updateActionForTab(tabs[0].id);
        }
    } catch (error) {
        logger.error('Background', 'Error updating action on sidebar connect', error);
    }

    port.onDisconnect.addListener(async () => {
      // Clear the state from session storage.
      await storage.setSession({ isSidebarOpen: false });
      logger.log('Background', 'Sidebar disconnected, set session state to CLOSED. Updating action for active tab.');
      
      // When sidebar closes, update the icon for the current tab
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0] && tabs[0].id) {
          await sidebarHandler.updateActionForTab(tabs[0].id);
        }
      } catch (error) {
        logger.error('Background', 'Error updating action on sidebar disconnect', error);
      }
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

// --- Event Listeners ---
chrome.runtime.onInstalled.addListener(async (details) => {
    logger.log('Background:onInstalled', `Extension ${details.reason}`);
    await initializeStorageAndSettings();
    await cloudStorage.initialize().catch(err => logger.error('Background:onInstalled', 'Initial cloud storage init failed', err));
    await ruleManager.refreshAllRules();

    attachNavigationListeners();

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
     
     logger.log('Background:onStartup', 'Running immediate startup tasks...');
     try {
         await cloudStorage.initialize().catch(err => logger.error('Background:onStartup', 'Cloud storage init failed', err));
         await garbageCollectTabContexts();
         
         await restoreContextOnStartup();
         
         await ruleManager.refreshAllRules();
         await cleanupStuckCreatingPackets();

         attachNavigationListeners();

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

// --- External Message Listener ---
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

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const tabId = activeInfo.tabId;
    const logPrefix = `[Unpack Background:onActivated Tab ${tabId}]`;
    if (typeof tabId !== 'number') { logger.warn(logPrefix, 'Exiting: Invalid tabId.', activeInfo); return; }

    let tabData = null;
    try {
        // First, verify the tab exists and is accessible.
        tabData = await chrome.tabs.get(tabId);
    } catch (tabError) {
        // This handles the case where the tab is closed before we can get its info.
        logger.warn(logPrefix, "Failed to get tab info, tab likely closed.", { message: tabError.message });
        return;
    }

    // If we get here, the tab exists. Now we can safely perform actions.
    try {
        // Update the badge and action state.
        await sidebarHandler.updateActionForTab(tabId);

        // Continue with context update for the sidebar UI if the tab is fully loaded.
        if (tabData && tabData.status === 'complete') {
            const context = await getPacketContext(tabId);
            const instanceId = context?.instanceId || null;
            let instanceData = null;
            if (instanceId) {
                instanceData = await storage.getPacketInstance(instanceId).catch(e => null);
                if (!instanceData) {
                     logger.warn(logPrefix, `Instance data not found for existing context ${instanceId}. Clearing context.`);
                     await clearPacketContext(tabId);
                     // Rerun badge update since context is now clear.
                     await sidebarHandler.updateActionForTab(tabId);
                }
            }

            // Notify the sidebar of the current context.
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
    logger.log('Background:onRemoved', 'Tab removed', { tabId });
    if (interimContextMap.has(tabId)) {
        interimContextMap.delete(tabId);
        logger.log(`Background:onRemoved`, `Removed interim context from MAP for closed tab ${tabId}.`);
    }
    await clearPacketContext(tabId);
    await tabGroupHandler.handleTabRemovalCleanup(tabId, removeInfo);
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
    logger.log('Background:onReplaced', 'Tab replaced', { addedTabId, removedTabId });
    if (interimContextMap.has(removedTabId)) {
        interimContextMap.delete(removedTabId);
        logger.log(`Background:onReplaced`, `Removed interim context from MAP for replaced tab ${removedTabId}.`);
    }
    let oldContext = null;
    try { oldContext = await getPacketContext(removedTabId); }
    catch (e) { logger.warn('Background:onReplaced', 'Could not get context for removed tab', e); }
    await clearPacketContext(removedTabId);
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

// --- REVISED: Single, consolidated tabGroups.onUpdated listener ---
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

            // When a group is expanded, check if the active tab belongs to this group
            // and recompute the badge state for it. This ensures we don't act on
            // an unrelated active tab from a different group.
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

async function cleanupStuckCreatingPackets() {
    logger.log('Background:CleanupStuck', 'Starting cleanup of old "creating" state packets...');
    const STUCK_THRESHOLD_MS = 2 * 60 * 1000; // 2 hours

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

// Function to attach/re-attach all web navigation listeners
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

// --- Immediate Actions on Service Worker Start ---
(async () => {
    await initializeStorageAndSettings(); // Ensure settings are loaded first
    await cloudStorage.initialize().catch(err => logger.error('Background:InitialSetup', 'Initial cloud storage init failed', err));
    attachNavigationListeners(); // Attach listeners ASAP
    await getDb().catch(e => logger.error('Background:InitialSetup', 'Initial DB access failed on load', e));

    await garbageCollectTabContexts();
    await cleanupStuckCreatingPackets();

    logger.log('Background', 'Service Worker successfully started/restarted and initial tasks run.');
})();