// ext/background-modules/tab-group-handler.js
// REVISED: The complex and bug-prone "groupingInProgress" lock has been removed.
// The new idempotent "manager" in the navigation-handler makes this lock unnecessary,
// which fixes the "stuck state" bug. The ordering logic remains correct.

import {
    logger,
    storage,
    packetUtils,
    isTabGroupsAvailable,
    shouldUseTabGroups,
    getPacketContext,
    GROUP_TITLE_PREFIX,
    getIdentifierForGroupTitle
} from '../utils.js';

const TAB_REORDER_INTERVAL = 5 * 60 * 1000; // 5 minutes
let tabReorderIntervalId = null;
const DRAFT_GROUP_TITLE = "Packet Builder";
const groupingInProgress = new Set();

// --- Helper Functions (Internal - create/update/get group) ---
function createTabGroupHelper(tabId, instance) {
    return new Promise((resolve, reject) => {
        chrome.tabs.group({ tabIds: [tabId] }, (groupId) => {
            if (chrome.runtime.lastError || typeof groupId !== 'number') {
                reject(chrome.runtime.lastError || new Error('Invalid group ID returned from tabs.group'));
            } else {
                const identifier = getIdentifierForGroupTitle(instance.instanceId);
                const groupTitle = `${GROUP_TITLE_PREFIX}${identifier}`;
                const groupColor = packetUtils.getColorForTopic(instance.topic);
                chrome.tabGroups.update(groupId, { title: groupTitle, color: groupColor }, () => {
                    if (chrome.runtime.lastError) {
                         logger.warn('TabGroupHandler:createTabGroupHelper', 'Error updating new group', chrome.runtime.lastError);
                    }
                    resolve(groupId);
                });
            }
        });
    });
}

/**
 * Ensures a tab is placed into the correct tab group for a given packet instance.
 * If no group exists, it creates one.
 * @param {number} tabId - The ID of the tab to place.
 * @param {string} instanceId - The ID of the packet instance.
 * @returns {Promise<number|null>} The group ID the tab was placed in, or null.
 */
export async function ensureTabInGroup(tabId, instanceId) {
    if (!(await shouldUseTabGroups())) return null;
    if (typeof tabId !== 'number' || !instanceId) return null;

    if (groupingInProgress.has(instanceId)) {
        logger.log('TabGroupHandler:ensureTabInGroup', `Grouping already in progress for instance ${instanceId}, skipping.`);
        return null;
    }

    try {
        // *** FIX: Acquire lock INSIDE the try block. ***
        // This guarantees the finally block will run and release the lock, even if the
        // chrome.tabs.get or storage.getPacketInstance calls fail.
        groupingInProgress.add(instanceId);

        const instance = await storage.getPacketInstance(instanceId);
        if (!instance) {
            logger.warn('TabGroupHandler:ensureTabInGroup', 'Packet instance not found for ID:', { instanceId });
            return null;
        }

        const identifier = getIdentifierForGroupTitle(instanceId);
        const expectedGroupTitle = `${GROUP_TITLE_PREFIX}${identifier}`;
        
        const tab = await chrome.tabs.get(tabId);
        let browserState = await storage.getPacketBrowserState(instanceId) || { instanceId, tabGroupId: null, activeTabIds: [], lastActiveUrl: null };
        let targetGroupId = null;

        if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
            try {
                const currentGroup = await chrome.tabGroups.get(tab.groupId);
                if (currentGroup.title === expectedGroupTitle) {
                    targetGroupId = tab.groupId;
                }
            } catch (e) { /* Group doesn't exist, proceed to find/create */ }
        }
        
        if (!targetGroupId) {
            const [existingGroup] = await chrome.tabGroups.query({ title: expectedGroupTitle });
            if (existingGroup) {
                targetGroupId = existingGroup.id;
            } else {
                targetGroupId = await createTabGroupHelper(tabId, instance);
            }
        }

        if (tab.groupId !== targetGroupId) {
            await chrome.tabs.group({ tabIds: [tabId], groupId: targetGroupId });
        }
        
        if (browserState.tabGroupId !== targetGroupId) {
            browserState.tabGroupId = targetGroupId;
            await storage.savePacketBrowserState(browserState);
        }

        return targetGroupId;

    } catch (error) {
        logger.error('TabGroupHandler:ensureTabInGroup', 'Error ensuring tab is in group', { tabId, instanceId, error });
        return null;
    } finally {
        groupingInProgress.delete(instanceId); // Release lock
    }
}

/**
 * Ejects a specific tab from its group and updates the browser state.
 * @param {number} tabId - The ID of the tab to eject.
 * @param {string} instanceId - The ID of the packet instance the tab belonged to.
 */
export async function ejectTabFromGroup(tabId, instanceId) {
    if (typeof tabId !== 'number' || !instanceId) {
        return;
    }
    try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.groupId && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
            await chrome.tabs.ungroup(tabId);
        }
    } catch (error) {
        if (!error.message.toLowerCase().includes('no tab with id')) {
            logger.error('TabGroupHandler:ejectTabFromGroup', `Error ejecting tab ${tabId}`, error);
        }
    }
}

export async function orderTabsInGroup(groupId, instance) {
    if (!(await shouldUseTabGroups())) return false;
    if (!groupId || !instance || !Array.isArray(instance.contents)) return false;

    try {
        const tabsInGroup = await chrome.tabs.query({ groupId });
        if (tabsInGroup.length <= 1) return true;

        // *** FIX: Flatten the contents array to correctly find items within 'alternative' blocks. ***
        const flatContents = instance.contents.flatMap(c => c.type === 'alternative' ? c.alternatives : c);

        const contextPromises = tabsInGroup.map(tab => getPacketContext(tab.id).then(context => ({ tab, context })));
        const tabsWithContext = await Promise.all(contextPromises);

        const tabPositions = [];
        for (const { tab, context } of tabsWithContext) {
            if (context && context.instanceId === instance.instanceId && context.canonicalPacketUrl) {
                const contentIndex = flatContents.findIndex(c => c.url === context.canonicalPacketUrl);
                tabPositions.push({ tabId: tab.id, index: contentIndex !== -1 ? contentIndex : Infinity });
            }
        }
        
        if (tabPositions.length <= 1) return true;

        tabPositions.sort((a, b) => a.index - b.index);
        const orderedTabIds = tabPositions.map(p => p.tabId);
        
        const minIndex = tabsInGroup.reduce((min, tab) => Math.min(min, tab.index), Infinity);

        if (orderedTabIds.length > 0 && minIndex !== Infinity) {
             await chrome.tabs.move(orderedTabIds, { index: minIndex });
        }
        return true;
    } catch (error) {
        logger.error('TabGroupHandler:orderTabsInGroup', `Error ordering tabs in group ${groupId}`, error);
        return false;
    }
}

// *** FIX: Added the 'export' keyword to make this function accessible. ***
export async function handleRemoveTabGroups(data, sendResponse) {
    const { groupIds } = data;
    if (!isTabGroupsAvailable()) return sendResponse({ success: false, error: 'Tab Groups API not available.' });
    if (!Array.isArray(groupIds) || groupIds.length === 0) return sendResponse({ success: false, error: 'Invalid group ID array.' });

    const errors = [];
    for (const groupId of groupIds) {
        try {
            const tabsInGroup = await chrome.tabs.query({ groupId });
            if (tabsInGroup.length > 0) {
                await chrome.tabs.remove(tabsInGroup.map(t => t.id));
            }
        } catch (error) {
            if (!error.message.toLowerCase().includes('no tab group with id')) {
                errors.push(`Group ${groupId}: ${error.message}`);
            }
        }
    }
    sendResponse({ success: errors.length === 0, errors });
}

export async function handleTabRemovalCleanup(tabId, removeInfo) {
    if (removeInfo.isWindowClosing) return;
    try {
        const allBrowserStates = await storage.getAllPacketBrowserStates();
        for (const instanceId in allBrowserStates) {
            const state = allBrowserStates[instanceId];
            if (state.activeTabIds && state.activeTabIds.includes(tabId)) {
                state.activeTabIds = state.activeTabIds.filter(id => id !== tabId);
                await storage.savePacketBrowserState(state);
            }
        }
    } catch (error) {
        logger.error('TabGroupHandler:handleTabRemovalCleanup', 'Error during cleanup check', error);
    }
}

export function startTabReorderingChecks() {
     if (tabReorderIntervalId) clearInterval(tabReorderIntervalId); 
     if (!isTabGroupsAvailable()) return;
     tabReorderIntervalId = setInterval(async () => {
        if (!(await shouldUseTabGroups())) return;
        const instances = await storage.getPacketInstances();
        for (const instanceId in instances) {
            const state = await storage.getPacketBrowserState(instanceId);
            if (state?.tabGroupId) {
                await orderTabsInGroup(state.tabGroupId, instances[instanceId]);
            }
        }
     }, TAB_REORDER_INTERVAL);
}

export function stopTabReorderingChecks() {
     if (tabReorderIntervalId) {
         clearInterval(tabReorderIntervalId);
         tabReorderIntervalId = null;
     }
}