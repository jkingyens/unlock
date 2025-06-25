// ext/background-modules/tab-group-handler.js
// Provides utility functions for managing Chrome Tab Groups related to packet instances.
// REVISED: Uses strict "PKT-{numericInstanceId}" for group titles.
// REVISED: deduplicateUrlInGroup to compare canonical packet URLs from context.

import {
    logger,
    storage,
    packetUtils,
    isTabGroupsAvailable,
    shouldUseTabGroups,
    CONFIG,
    getPacketContext, // Already imported, used for deduplication
    GROUP_TITLE_PREFIX,
    getIdentifierForGroupTitle
} from '../utils.js';

const TAB_REORDER_INTERVAL = 5 * 60 * 1000; // 5 minutes
let tabReorderIntervalId = null;
const DRAFT_GROUP_TITLE = "Packet Builder";

// --- Helper Functions (Internal - create/update/get group) ---
function createTabGroupHelper(tabId) {
    return new Promise((resolve, reject) => {
        chrome.tabs.group({ tabIds: [tabId] }, (groupId) => {
            if (chrome.runtime.lastError || typeof groupId !== 'number') {
                reject(chrome.runtime.lastError || new Error('Invalid group ID returned from tabs.group'));
            } else {
                resolve(groupId);
            }
        });
    });
}

export async function ungroupTabIfUrlExternalToPacket(tabId, groupId, targetUrl, packetInstance) {
    if (!packetInstance) {
        logger.warn('TabGroupHandler:ungroupTabIfUrlExternalToPacket', 'Packet instance data not provided. Cannot check URL.', { tabId, groupId, targetUrl });
        return;
    }

    if (!packetUtils.isUrlInPacket(targetUrl, packetInstance)) {
        logger.log('TabGroupHandler:ungroupTabIfUrlExternalToPacket', `URL ${targetUrl} is outside packet ${packetInstance.instanceId}. Ungrouping tab ${tabId} from group ${groupId}.`);
        try {
            await chrome.tabs.ungroup(tabId);
            logger.log('TabGroupHandler:ungroupTabIfUrlExternalToPacket', `Successfully ungrouped tab ${tabId}.`);

            const browserState = await storage.getPacketBrowserState(packetInstance.instanceId);
            if (browserState && Array.isArray(browserState.activeTabIds) && browserState.activeTabIds.includes(tabId)) {
                browserState.activeTabIds = browserState.activeTabIds.filter(id => id !== tabId);
                await storage.savePacketBrowserState(browserState);
                logger.log('TabGroupHandler:ungroupTabIfUrlExternalToPacket', `Removed tab ${tabId} from activeTabIds for instance ${packetInstance.instanceId}.`);
            }

        } catch (e) {
            logger.error('TabGroupHandler:ungroupTabIfUrlExternalToPacket', `Error ungrouping tab ${tabId} from group ${groupId}`, e);
        }
    } else {
        logger.log('TabGroupHandler:ungroupTabIfUrlExternalToPacket', `URL ${targetUrl} is part of packet ${packetInstance.instanceId}. Tab ${tabId} will remain in group ${groupId}.`);
    }
}

export async function deduplicateUrlInGroup(groupId, instanceId, activeTabId) {
    if (!groupId || !instanceId || typeof activeTabId !== 'number') {
        logger.log('TabGroupHandler:deduplicateUrlInGroup', 'Skipping: Invalid parameters.', { groupId, instanceId, activeTabId });
        return;
    }

    logger.log('TabGroupHandler:deduplicateUrlInGroup', `Checking for duplicate canonical URLs in group ${groupId} for instance ${instanceId}. Active tab hint: ${activeTabId}`);

    const tabsInGroup = await getTabsInGroupHelper(groupId);
    if (tabsInGroup.length < 2) return; 

    const activeTabPacketContext = await getPacketContext(activeTabId);
    if (!activeTabPacketContext || activeTabPacketContext.instanceId !== instanceId || !activeTabPacketContext.packetUrl) {
        logger.warn('TabGroupHandler:deduplicateUrlInGroup', 'Active tab context is invalid or does not match instance, or missing canonical packetUrl.', { activeTabId, instanceId, activeTabPacketContext });
        return;
    }
    const activeTabCanonicalUrl = activeTabPacketContext.packetUrl; 

    for (const otherTab of tabsInGroup) {
        if (otherTab.id === activeTabId) { 
            continue;
        }

        const otherTabPacketContext = await getPacketContext(otherTab.id);
        if (otherTabPacketContext && otherTabPacketContext.instanceId === instanceId && otherTabPacketContext.packetUrl) {
            const otherTabCanonicalUrl = otherTabPacketContext.packetUrl;

            if (otherTabCanonicalUrl === activeTabCanonicalUrl) {
                logger.log('TabGroupHandler:deduplicateUrlInGroup', `Duplicate canonical URL ${activeTabCanonicalUrl} found. Closing tab ${otherTab.id}.`);
                await chrome.tabs.remove(otherTab.id).catch(e => logger.error('TabGroupHandler:deduplicateUrlInGroup', `Error closing duplicate tab ${otherTab.id}`, e));

                try {
                    const browserState = await storage.getPacketBrowserState(instanceId);
                    if (browserState && browserState.activeTabIds && browserState.activeTabIds.includes(otherTab.id)) {
                        browserState.activeTabIds = browserState.activeTabIds.filter(id => id !== otherTab.id);
                        await storage.savePacketBrowserState(browserState);
                        logger.log('TabGroupHandler:deduplicateUrlInGroup', `Removed closed tab ${otherTab.id} from browser state for instance ${instanceId}.`);
                    }
                } catch (stateError) {
                    logger.error('TabGroupHandler:deduplicateUrlInGroup', `Error updating browser state for closed duplicate tab ${otherTab.id}`, stateError);
                }
            }
        } else {
            logger.log('TabGroupHandler:deduplicateUrlInGroup', `Skipping tab ${otherTab.id} for deduplication check: context missing, mismatched instance, or no packetUrl.`, { otherTabPacketContext });
        }
    }
}

async function updateTabGroupAppearanceHelper(groupId, instanceId, instanceTopic) {
    return new Promise(async (resolve) => { 
        const identifier = getIdentifierForGroupTitle(instanceId); 

        if (!identifier) {
            logger.error('TabGroupHandler:updateAppearanceHelper', `Could not derive identifier from instanceId: ${instanceId} for group ${groupId}. Using fallback title.`);
            const fallbackTitle = instanceId || "Unpack Packet";
            let topicForColor = instanceTopic;
            if (!topicForColor) {
                const instance = await storage.getPacketInstance(instanceId);
                topicForColor = instance?.topic || instanceId;
            }
            const groupColor = packetUtils.getColorForTopic(topicForColor);
            chrome.tabGroups.update(groupId, { title: fallbackTitle, color: groupColor }, (group) => {
                 if (chrome.runtime.lastError) logger.warn('TabGroupHandler:updateAppearanceHelper', 'Error updating group with fallback title', { groupId, error: chrome.runtime.lastError });
                 resolve(group);
            });
            return;
        }

        const groupTitle = `${GROUP_TITLE_PREFIX}${identifier}`;
        let topicForColor = instanceTopic;
        if (!topicForColor) {
            const instance = await storage.getPacketInstance(instanceId);
            topicForColor = instance?.topic || instanceId;
        }
        const groupColor = packetUtils.getColorForTopic(topicForColor);

        logger.log('TabGroupHandler:updateAppearanceHelper', `Setting group ${groupId} title to: "${groupTitle}", color: ${groupColor}`);
        chrome.tabGroups.update(groupId, { title: groupTitle, color: groupColor }, (group) => {
            if (chrome.runtime.lastError) {
                logger.warn('TabGroupHandler:updateAppearanceHelper', 'Error updating group', { groupId, title: groupTitle, error: chrome.runtime.lastError });
            }
            resolve(group);
        });
    });
}

function getTabsInGroupHelper(groupId) {
    return new Promise((resolve, reject) => {
        chrome.tabs.query({ groupId: groupId }, (tabs) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(tabs || []);
            }
        });
    });
}

async function updateBrowserStateActiveTabs(instanceId, tabId, operation) {
    if (!instanceId || typeof tabId !== 'number') return;
    try {
        const state = await storage.getPacketBrowserState(instanceId);
        const currentState = state || { instanceId: instanceId, tabGroupId: null, activeTabIds: [], lastActiveUrl: null };
        let updated = false;
        if (operation === 'add' && !currentState.activeTabIds.includes(tabId)) {
            currentState.activeTabIds.push(tabId); updated = true;
        } else if (operation === 'remove') {
            const initialLength = currentState.activeTabIds.length;
            currentState.activeTabIds = currentState.activeTabIds.filter(id => id !== tabId);
            if (currentState.activeTabIds.length !== initialLength) { updated = true; }
        }
        if (updated) { await storage.savePacketBrowserState(currentState); }
    } catch (error) {
        logger.error('TabGroupHandler:updateBrowserStateActiveTabs', `Error ${operation}ing tab ${tabId} for instance ${instanceId}`, error);
    }
}

export async function ensureTabInGroup(tabId, instanceId) {
    const useTabGroups = await shouldUseTabGroups();
    if (!useTabGroups) return null;

    if (typeof tabId !== 'number' || !instanceId) {
        logger.warn('TabGroupHandler:ensureTabInGroup', 'Invalid parameters', {tabId, instanceId});
        return null;
    }

    let instance = null; 
    try {
        instance = await storage.getPacketInstance(instanceId);
        if (!instance) {
            logger.warn('TabGroupHandler:ensureTabInGroup', 'Packet instance not found for ID:', { instanceId });
            return null;
        }
    } catch (fetchError) { 
        logger.error('TabGroupHandler:ensureTabInGroup', 'Error fetching packet instance', { instanceId, fetchError });
        return null; 
    }

    const identifier = getIdentifierForGroupTitle(instanceId); 
    if (!identifier) {
        logger.error('TabGroupHandler:ensureTabInGroup', `Could not derive identifier for instance ${instanceId}. Cannot manage group.`);
        return null;
    }
    const expectedGroupTitle = `${GROUP_TITLE_PREFIX}${identifier}`;
    let targetGroupId = null;
    let stateNeedsSaving = false;

    let currentBrowserState = await storage.getPacketBrowserState(instanceId) ||
                              { instanceId: instanceId, tabGroupId: null, activeTabIds: [], lastActiveUrl: null };

    if (currentBrowserState.tabGroupId) {
        try {
            const existingGroup = await chrome.tabGroups.get(currentBrowserState.tabGroupId);
            if (existingGroup.title === expectedGroupTitle) {
                logger.log('TabGroupHandler:ensureTabInGroup', `State group ID ${currentBrowserState.tabGroupId} is valid and title matches "${expectedGroupTitle}".`);
                targetGroupId = currentBrowserState.tabGroupId;
            } else {
                logger.warn('TabGroupHandler:ensureTabInGroup', `State group ID ${currentBrowserState.tabGroupId} title "${existingGroup.title}" does not match expected "${expectedGroupTitle}". Will search/create.`);
                currentBrowserState.tabGroupId = null; 
                stateNeedsSaving = true;
            }
        } catch (e) {
            logger.warn('TabGroupHandler:ensureTabInGroup', `State group ID ${currentBrowserState.tabGroupId} not found via get(). Will search/create. Error: ${e.message}`);
            currentBrowserState.tabGroupId = null; 
            stateNeedsSaving = true;
        }
    }

    if (!targetGroupId) {
        logger.log('TabGroupHandler:ensureTabInGroup', `No valid group from state. Querying for group with title "${expectedGroupTitle}"...`);
        try {
            const matchingGroups = await chrome.tabGroups.query({ title: expectedGroupTitle });
            if (matchingGroups.length === 1) {
                targetGroupId = matchingGroups[0].id;
                logger.log('TabGroupHandler:ensureTabInGroup', `Found existing group by title query: ID ${targetGroupId}`);
            } else if (matchingGroups.length > 1) {
                logger.warn('TabGroupHandler:ensureTabInGroup', `Found ${matchingGroups.length} groups with title "${expectedGroupTitle}". Choosing the first group (ID: ${matchingGroups[0].id}) as canonical and will attempt to merge later if necessary.`);
                targetGroupId = matchingGroups[0].id;
            } else {
                logger.log('TabGroupHandler:ensureTabInGroup', `No group found with title "${expectedGroupTitle}". Will create new.`);
            }
            
            if (targetGroupId && currentBrowserState.tabGroupId !== targetGroupId) {
                currentBrowserState.tabGroupId = targetGroupId;
                stateNeedsSaving = true;
            }
        } catch (queryError) {
            logger.error('TabGroupHandler:ensureTabInGroup', 'Error querying groups by title', { title: expectedGroupTitle, queryError });
        }
    }

    if (!targetGroupId) {
        logger.log('TabGroupHandler:ensureTabInGroup', `Creating new group for instance ${instanceId}.`);
        try {
            const newGroupId = await createTabGroupHelper(tabId); 
            await updateTabGroupAppearanceHelper(newGroupId, instance.instanceId, instance.topic);
            targetGroupId = newGroupId;
            currentBrowserState.tabGroupId = newGroupId; 
            stateNeedsSaving = true;
            logger.log('TabGroupHandler:ensureTabInGroup', `Created new group ${newGroupId} with title "${expectedGroupTitle}".`);
        } catch (creationError) {
            logger.error('TabGroupHandler:ensureTabInGroup', 'Failed to create new tab group', { instanceId, creationError });
            return null; 
        }
    }

    try {
        logger.log('TabGroupHandler:ensureTabInGroup', `Adding tab ${tabId} to group ${targetGroupId}.`);
        await new Promise((resolve, reject) => {
            chrome.tabs.group({ tabIds: [tabId], groupId: targetGroupId }, () => {
                if (chrome.runtime.lastError) {
                    return reject(chrome.runtime.lastError);
                }
                resolve();
            });
        });

        if (!currentBrowserState.activeTabIds.includes(tabId)) {
            currentBrowserState.activeTabIds.push(tabId);
            stateNeedsSaving = true;
        }
    } catch (groupingError) {
        logger.error('TabGroupHandler:ensureTabInGroup', `Failed to add tab ${tabId} to group ${targetGroupId}: ${groupingError.message}`, { groupingError });
        return null;
    }

    if (stateNeedsSaving) {
        logger.log('TabGroupHandler:ensureTabInGroup', `Saving browser state for instance ${instanceId}`, currentBrowserState);
        await storage.savePacketBrowserState(currentBrowserState);
    }

    return targetGroupId;
}


export async function orderTabsInGroup(groupId, instance) {
    const useTabGroups = await shouldUseTabGroups();
    if (!useTabGroups) return false;

    if (!groupId || !instance || !Array.isArray(instance.contents)) {
        logger.warn('TabGroupHandler:orderTabsInGroup', 'Invalid args', { groupId, instanceId: instance?.instanceId });
        return false;
    }
    const instanceId = instance.instanceId; 

    try {
        let initialTabsInGroup = await getTabsInGroupHelper(groupId);
        if (initialTabsInGroup.length <= 1) { return true; }

        const contextChecks = await Promise.allSettled( initialTabsInGroup.map(tab => getPacketContext(tab.id)) );
        const tabsToMoveOutOfGroup = [];
        const validTabsForOrdering = [];

        initialTabsInGroup.forEach((tab, index) => {
            const contextResult = contextChecks[index];
            let belongsToInstance = false;
            let packetUrl = null;
            if (contextResult.status === 'fulfilled' && contextResult.value?.instanceId === instanceId) {
                 belongsToInstance = true;
                 packetUrl = contextResult.value?.packetUrl;
            } else if (contextResult.status === 'rejected') { logger.error('TabGroupHandler:orderTabsInGroup', `Failed to get context for tab ${tab.id} during check`, contextResult.reason); }

            if (!belongsToInstance) {
                tabsToMoveOutOfGroup.push({ id: tab.id, windowId: tab.windowId });
                updateBrowserStateActiveTabs(instanceId, tab.id, 'remove').catch(e => logger.error('TabGroupHandler:orderTabsInGroup', 'Failed background update of activeTabIds on ejection', e));
            } else if (packetUrl) {
                validTabsForOrdering.push({ ...tab, packetUrl: packetUrl });
            } else {
                 logger.warn('TabGroupHandler:orderTabsInGroup', `Tab ${tab.id} belongs to instance ${instanceId} but context lacks packetUrl. Cannot order this tab.`);
            }
        });

       if (tabsToMoveOutOfGroup.length > 0) {
            let windowTabs = []; let isGroupRightmost = false;
            try { if (tabsToMoveOutOfGroup[0]?.windowId) { const winInfo = await chrome.windows.get(tabsToMoveOutOfGroup[0].windowId, { populate: true }); windowTabs = winInfo?.tabs || []; } } catch (winError) { logger.error('TabGroupHandler:orderTabsInGroup', 'Failed get window info for ejection', winError); }
            if (windowTabs.length > 0) { const groupIndices = windowTabs.filter(t => t.groupId === groupId).map(t => t.index); if (groupIndices.length > 0) { isGroupRightmost = (Math.max(...groupIndices) === windowTabs.length - 1); } }
            for (const tabInfo of tabsToMoveOutOfGroup) { let moveIndex = isGroupRightmost ? 0 : -1; try { await chrome.tabs.move(tabInfo.id, { index: moveIndex, windowId: tabInfo.windowId }); } catch (ejectError) { logger.error('TabGroupHandler:orderTabsInGroup', `Error moving unrelated tab ${tabInfo.id}`, { error: ejectError }); } }
       }

        const tabPositions = [];
        validTabsForOrdering.forEach(tab => {
             const contentIndex = instance.contents.findIndex(c => c.url === tab.packetUrl);
             if (contentIndex !== -1) {
                  tabPositions.push({ tabId: tab.id, currentIndex: tab.index, contentIndex: contentIndex });
             } else {
                  tabPositions.push({ tabId: tab.id, currentIndex: tab.index, contentIndex: Infinity });
             }
        });

        if (tabPositions.length <= 1) {
            return true;
        }
        tabPositions.sort((a, b) => a.contentIndex - b.contentIndex);
        const currentTabsInGroupAfterEjection = await getTabsInGroupHelper(groupId); 
        const currentIndicesMap = new Map(currentTabsInGroupAfterEjection.map(t => [t.id, t.index]));
        const minCurrentIndex = tabPositions.reduce((min, pos) => {
            const currentIdx = currentIndicesMap.get(pos.tabId);
            return (currentIdx !== undefined) ? Math.min(min, currentIdx) : min;
        }, Infinity);

        if (minCurrentIndex === Infinity) {
            return false;
        }
        let targetIndex = minCurrentIndex;
        const moves = [];
        for (const pos of tabPositions) {
            const currentActualIndex = currentIndicesMap.get(pos.tabId);
            if (currentActualIndex === undefined) {
                continue;
            }
            if (currentActualIndex !== targetIndex) {
                 moves.push({ tabId: pos.tabId, index: targetIndex });
            }
            targetIndex++;
        }
        if (moves.length === 0) {
             return true;
        }
        for (const move of moves) {
            try {
                 await chrome.tabs.get(move.tabId);
                 await chrome.tabs.move(move.tabId, { index: move.index });
            } catch (moveError) {
                 logger.error('TabGroupHandler:orderTabsInGroup', `Move failed for tab ${move.tabId} to index ${move.index}`, moveError);
            }
        }
        return true;
    } catch (error) {
      logger.error('TabGroupHandler:orderTabsInGroup', `Error ordering/ungrouping tabs in Group ${groupId} for Instance ${instanceId}`, error);
      return false;
    }
}

export async function handleRemoveTabGroups(data, sendResponse) {
    const { groupIds } = data;
    if (!isTabGroupsAvailable()) { sendResponse({ success: false, error: 'Tab Groups API not available.' }); return; }
    if (!Array.isArray(groupIds) || groupIds.length === 0) { sendResponse({ success: false, error: 'Invalid group ID array.' }); return; }
    logger.log('TabGroupHandler:handleRemoveTabGroups', 'Processing request', groupIds);
    let allSucceeded = true; let errors = [];
    let groupIdToInstanceIdMap = new Map();
    try { const allStates = await storage.getAllPacketBrowserStates(); for (const instanceId in allStates) { const stateGroupId = allStates[instanceId]?.tabGroupId; if (stateGroupId && typeof stateGroupId === 'number' && stateGroupId > 0) { groupIdToInstanceIdMap.set(stateGroupId, instanceId); } } }
    catch (stateError) { logger.error('TabGroupHandler:handleRemoveTabGroups', 'Failed to fetch browser states for cleanup', stateError); errors.push('Failed to fetch browser states for cleanup.'); }
    for (const groupId of groupIds) { if (typeof groupId !== 'number' || groupId <= 0) continue; let instanceIdToClean = groupIdToInstanceIdMap.get(groupId); try { const tabsInGroup = await getTabsInGroupHelper(groupId); if (tabsInGroup.length > 0) { await chrome.tabs.remove(tabsInGroup.map(t => t.id)); logger.log('TabGroupHandler:handleRemoveTabGroups', `Removed ${tabsInGroup.length} tabs in group ${groupId}`); } else { logger.log('TabGroupHandler:handleRemoveTabGroups', `Group ${groupId} was already empty.`); try { await chrome.tabGroups.get(groupId); /* Check if group exists before removing */ await chrome.tabGroups.remove(groupId); logger.log('TabGroupHandler:handleRemoveTabGroups', `Removed empty group ${groupId}.`); } catch { /* Ignore if group doesn't exist */ } } if (instanceIdToClean) { logger.log('TabGroupHandler:handleRemoveTabGroups', `Cleaning up browser state for instance ${instanceIdToClean} associated with group ${groupId}`); try { const state = await storage.getPacketBrowserState(instanceIdToClean); if (state && state.tabGroupId === groupId) { state.tabGroupId = null; state.activeTabIds = []; await storage.savePacketBrowserState(state); logger.log('TabGroupHandler:handleRemoveTabGroups', `Nullified tabGroupId and cleared activeTabs in browser state for ${instanceIdToClean}.`); } else { logger.log('TabGroupHandler:handleRemoveTabGroups', `Browser state for ${instanceIdToClean} already clean or doesn't match group ${groupId}.`); } } catch (stateUpdateError) { logger.error('TabGroupHandler:handleRemoveTabGroups', `Error cleaning browser state for instance ${instanceIdToClean}`, stateUpdateError); errors.push(`Browser state cleanup failed for group ${groupId}: ${stateUpdateError.message}`); } } else { logger.log('TabGroupHandler:handleRemoveTabGroups', `No instance found associated with group ${groupId} in browser states map.`); } } catch (error) { logger.error('TabGroupHandler:handleRemoveTabGroups', `Error removing group ${groupId} or its tabs`, error); allSucceeded = false; errors.push(`Group ${groupId}: ${error.message || 'Unknown error'}`); } } sendResponse({ success: allSucceeded, errors: errors });
}

export async function handleTabRemovalCleanup(tabId, removeInfo) {
    if (removeInfo.isWindowClosing) return;
    try {
        const allBrowserStates = await storage.getAllPacketBrowserStates();
        const useTabGroups = await shouldUseTabGroups();
        let statesToSave = [];
        for (const instanceId in allBrowserStates) {
            const state = allBrowserStates[instanceId];
            let stateModified = false;
            const initialActiveCount = state.activeTabIds?.length || 0; state.activeTabIds = (state.activeTabIds || []).filter(id => id !== tabId); if (state.activeTabIds.length !== initialActiveCount) { logger.log('TabGroupHandler:handleTabRemovalCleanup', `Removed closed tab ${tabId} from active list for instance ${instanceId}`); stateModified = true; }
            if (state.tabGroupId && useTabGroups) {
                try {
                    await chrome.tabGroups.get(state.tabGroupId);
                    const tabs = await getTabsInGroupHelper(state.tabGroupId);
                    const groupStillHasActiveInstanceTabs = tabs.some(t => state.activeTabIds.includes(t.id));
                     if (!groupStillHasActiveInstanceTabs && tabs.length === 0) { logger.log('TabGroupHandler:handleTabRemovalCleanup', `Group ${state.tabGroupId} for instance ${instanceId} became empty. Nullifying groupId.`); state.tabGroupId = null; stateModified = true;
                     } else if (!groupStillHasActiveInstanceTabs && tabs.length > 0) { logger.log('TabGroupHandler:handleTabRemovalCleanup', `Group ${state.tabGroupId} still has tabs, but none match instance ${instanceId}'s active list. Leaving group ID for now.`); }
                } catch (e) { logger.log('TabGroupHandler:handleTabRemovalCleanup', `Group ${state.tabGroupId} likely gone. Nullifying groupId. Error: ${e.message}`); state.tabGroupId = null; stateModified = true; }
            }
            if (stateModified) { statesToSave.push(state); }
        }
        if (statesToSave.length > 0) { logger.log('TabGroupHandler:handleTabRemovalCleanup', `Saving ${statesToSave.length} browser states after cleanup.`); await Promise.all(statesToSave.map(stateToSave => storage.savePacketBrowserState(stateToSave))); }
    } catch (error) { logger.error('TabGroupHandler:handleTabRemovalCleanup', 'Error during cleanup check', error); }
}

export function handleReorderAllTabs(sendResponse) {
    reorderAllInstanceTabs()
        .then(results => sendResponse({ success: true, results }))
        .catch(error => sendResponse({ success: false, error: error.message }));
}

export async function handleFocusTabGroup(data) {
    const { focusedGroupId } = data;
    if (typeof focusedGroupId !== 'number') {
        logger.warn('TabGroupHandler:handleFocusTabGroup', 'Invalid focusedGroupId provided.', data);
        return { success: false, error: 'Invalid focusedGroupId' };
    }

    logger.log('TabGroupHandler:handleFocusTabGroup', `Focusing group ${focusedGroupId}.`);

    try {
        const allBrowserStates = await storage.getAllPacketBrowserStates();
        const promises = [];

        for (const instanceId in allBrowserStates) {
            const state = allBrowserStates[instanceId];
            if (state && typeof state.tabGroupId === 'number' && state.tabGroupId > 0) {
                const isFocused = state.tabGroupId === focusedGroupId;
                const promise = chrome.tabGroups.update(state.tabGroupId, { collapsed: !isFocused })
                    .catch(e => {
                        if (!e.message.toLowerCase().includes('no tab group with id')) {
                            logger.warn('TabGroupHandler:handleFocusTabGroup', `Error updating group ${state.tabGroupId}`, e);
                        }
                    });
                promises.push(promise);
            }
        }

        await Promise.all(promises);
        logger.log('TabGroupHandler:handleFocusTabGroup', `Finished updating collapsed state for all groups.`);
        return { success: true };
    } catch (error) {
        logger.error('TabGroupHandler:handleFocusTabGroup', 'Error during focus operation', error);
        return { success: false, error: error.message };
    }
}

async function reorderAllInstanceTabs() {
     const useTabGroups = await shouldUseTabGroups();
     if (!useTabGroups) { logger.log('TabGroupHandler:reorderAllInstanceTabs', 'Skipping periodic check (Tab Groups Disabled)'); return { success: false, error: 'Tab Groups feature is disabled in settings' }; }
     logger.log('TabGroupHandler:reorderAllInstanceTabs', 'Starting periodic reorder/cleanup (Tab Groups Enabled)...');
     try {
         const [instancesMap, browserStatesMap] = await Promise.all([ storage.getPacketInstances(), storage.getAllPacketBrowserStates() ]);
         const results = { processed: 0, skipped_no_group: 0, skipped_error: 0, cleaned: 0, errors: [] }; let statesNeedSaving = [];
         for (const instanceId in instancesMap) {
             const instance = instancesMap[instanceId]; const browserState = browserStatesMap[instanceId];
             if (browserState?.tabGroupId) {
                 try { await chrome.tabGroups.get(browserState.tabGroupId); const res = await orderTabsInGroup(browserState.tabGroupId, instance); if (res) results.processed++; else results.skipped_error++; }
                 catch (e) { logger.warn('TabGroupHandler:reorderAllInstanceTabs', `Cleaning invalid groupId ${browserState.tabGroupId} for instance ${instanceId}`); results.skipped_error++; results.errors.push({ instanceId: instanceId, error: `Invalid group ID ${browserState.tabGroupId}: ${e.message}` }); browserState.tabGroupId = null; statesNeedSaving.push(browserState); results.cleaned++; }
             } else { results.skipped_no_group++; }
         }
         if (statesNeedSaving.length > 0) { logger.log('TabGroupHandler:reorderAllInstanceTabs', `Saving ${statesNeedSaving.length} browser states after cleaning.`); await Promise.all(statesNeedSaving.map(stateToSave => storage.savePacketBrowserState(stateToSave))); }
         logger.log('TabGroupHandler:reorderAllInstanceTabs', 'Periodic check complete', results); return results;
     } catch (e) { logger.error('TabGroupHandler:reorderAllInstanceTabs', 'Error during periodic check', e); return { success: false, error: e.message }; }
}
export function startTabReorderingChecks() {
     if (tabReorderIntervalId) clearInterval(tabReorderIntervalId); if (!isTabGroupsAvailable()) { logger.log('TabGroupHandler', 'Tab Groups API unavailable, skipping periodic reorder checks.'); return; } logger.log('TabGroupHandler', 'Starting periodic instance reorder/cleanup checks (assuming feature is enabled)'); reorderAllInstanceTabs().catch(e => logger.error('TabGroupHandler', 'Initial reorder/cleanup failed', e)); tabReorderIntervalId = setInterval(() => { reorderAllInstanceTabs().catch(e => logger.error('TabGroupHandler', 'Periodic reorder/cleanup failed', e)); }, TAB_REORDER_INTERVAL);
}
export function stopTabReorderingChecks() {
     if (tabReorderIntervalId) { clearInterval(tabReorderIntervalId); tabReorderIntervalId = null; logger.log('TabGroupHandler', 'Stopped periodic reorder/cleanup checks.'); }
}

export async function syncDraftGroup(desiredUrls) {
    if (!(await shouldUseTabGroups())) {
        return { success: true, groupId: null };
    }

    const logPrefix = '[TabGroupHandler:syncDraftGroup]';
    try {
        const [existingGroup] = await chrome.tabGroups.query({ title: DRAFT_GROUP_TITLE });
        let groupId = existingGroup?.id || null;

        // 1. Get current state, mapping tabs to their ORIGINAL URLs from session storage
        let tabsInGroup = groupId ? await getTabsInGroupHelper(groupId) : [];
        const tabIds = tabsInGroup.map(t => t.id);
        const sessionKeys = tabIds.map(id => `draft_tab_${id}`);
        const sessionData = await storage.getSession(sessionKeys);
        
        const currentUrlMap = new Map(); // Map<originalUrl, tabObject>
        tabsInGroup.forEach(tab => {
            const originalUrl = sessionData[`draft_tab_${tab.id}`] || tab.url;
            currentUrlMap.set(originalUrl, tab);
        });

        // 2. Calculate diff
        const desiredUrlsSet = new Set(desiredUrls);
        const tabsToClose = [];
        const sessionKeysToRemove = [];

        for (const [originalUrl, tab] of currentUrlMap.entries()) {
            if (!desiredUrlsSet.has(originalUrl)) {
                tabsToClose.push(tab.id);
                sessionKeysToRemove.push(`draft_tab_${tab.id}`);
            }
        }
        
        const urlsToOpen = desiredUrls.filter(url => !currentUrlMap.has(url));

        // 3. Perform actions
        if (tabsToClose.length > 0) {
            await chrome.tabs.remove(tabsToClose);
            await storage.removeSession(sessionKeysToRemove);
        }

        if (urlsToOpen.length > 0) {
            const newTabs = await Promise.all(urlsToOpen.map(url => chrome.tabs.create({ url, active: false })));
            const newSessionData = {};
            const newTabIds = [];
            for (let i = 0; i < newTabs.length; i++) {
                const tab = newTabs[i];
                const originalUrl = urlsToOpen[i];
                newSessionData[`draft_tab_${tab.id}`] = originalUrl;
                newTabIds.push(tab.id);
            }
            await storage.setSession(newSessionData);
            
            if (!groupId) {
                groupId = await chrome.tabs.group({ tabIds: newTabIds });
                await chrome.tabGroups.update(groupId, { title: DRAFT_GROUP_TITLE, color: 'grey' });
            } else {
                await chrome.tabs.group({ tabIds: newTabIds, groupId });
            }
        }
        
        const [finalGroup] = await chrome.tabGroups.query({ title: DRAFT_GROUP_TITLE });
        groupId = finalGroup?.id || null;
        if (!groupId) return { success: true, groupId: null };

        // 4. Re-query and Reorder
        const finalTabsInGroup = await getTabsInGroupHelper(groupId);
        if (finalTabsInGroup.length > 1) {
            const finalSessionKeys = finalTabsInGroup.map(t => `draft_tab_${t.id}`);
            const finalSessionData = await storage.getSession(finalSessionKeys);

            const urlToTabIdMap = new Map();
            finalTabsInGroup.forEach(tab => {
                const originalUrl = finalSessionData[`draft_tab_${tab.id}`] || tab.url;
                urlToTabIdMap.set(originalUrl, tab.id);
            });
            
            const orderedTabIds = desiredUrls.map(url => urlToTabIdMap.get(url)).filter(Boolean);
            
            if (orderedTabIds.length === finalTabsInGroup.length) {
                const minIndex = finalTabsInGroup.reduce((min, tab) => Math.min(min, tab.index), Infinity);
                if (minIndex !== Infinity) {
                    await chrome.tabs.move(orderedTabIds, { index: minIndex });
                }
            }
        }
        
        return { success: true, groupId };
    } catch (error) {
        logger.error(logPrefix, 'Error during sync of draft group', error);
        return { success: false, groupId: null, error: error.message };
    }
}

export async function focusOrCreateDraftTab(url) {
    if (!url || !(await shouldUseTabGroups())) return { success: false };
    
    try {
        const [draftGroup] = await chrome.tabGroups.query({ title: DRAFT_GROUP_TITLE });
        let existingTab = null;

        if (draftGroup) {
            const tabsInGroup = await getTabsInGroupHelper(draftGroup.id);
            const sessionKeys = tabsInGroup.map(t => `draft_tab_${t.id}`);
            const sessionData = await storage.getSession(sessionKeys);
            
            for (const tab of tabsInGroup) {
                const originalUrl = sessionData[`draft_tab_${tab.id}`] || tab.url;
                if (originalUrl === url) {
                    existingTab = tab;
                    break;
                }
            }
        }
        
        if (existingTab) {
            await chrome.tabs.update(existingTab.id, { active: true });
            await chrome.windows.update(existingTab.windowId, { focused: true });
        } else {
            let groupIdToUse = draftGroup?.id;
            const newTab = await chrome.tabs.create({ url, active: true });
            await storage.setSession({ [`draft_tab_${newTab.id}`]: url });

            if (!groupIdToUse) {
                groupIdToUse = await chrome.tabs.group({ tabIds: [newTab.id] });
                await chrome.tabGroups.update(groupIdToUse, { title: DRAFT_GROUP_TITLE, color: 'grey' });
            } else {
                await chrome.tabs.group({ tabIds: [newTab.id], groupId: groupIdToUse });
            }
            
            await chrome.windows.update(newTab.windowId, { focused: true });
        }
        return { success: true };
    } catch (error) {
        logger.error('TabGroupHandler:focusOrCreateDraftTab', 'Error focusing or creating draft tab', error);
        return { success: false, error: error.message };
    }
}

export async function cleanupDraftGroup() {
    if (!(await shouldUseTabGroups())) return { success: true };

    try {
        const [existingGroup] = await chrome.tabGroups.query({ title: DRAFT_GROUP_TITLE });
        if (existingGroup) {
            const tabs = await getTabsInGroupHelper(existingGroup.id);
            if (tabs.length > 0) {
                await chrome.tabs.remove(tabs.map(t => t.id));
            }
        }
        return { success: true };
    } catch (error) {
        if (!error.message.toLowerCase().includes('no tab group')) {
            logger.error('TabGroupHandler:cleanupDraftGroup', 'Error cleaning up draft group', { error });
        }
        return { success: true };
    }
}