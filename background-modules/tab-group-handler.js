// ext/background-modules/tab-group-handler.js
// FINAL FIX: Corrected a TypeError caused by not awaiting the result of chrome.tabs.query,
// which prevented tab reordering and syncing from working correctly.

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
export const DRAFT_GROUP_TITLE = "Packet Builder";

// --- Helper Functions (Internal - create/update/get group) ---
function createTabGroupHelper(tabId, instance) {
    return new Promise((resolve, reject) => {
        chrome.tabs.group({ tabIds: [tabId] }, (groupId) => {
            if (chrome.runtime.lastError || typeof groupId !== 'number') {
                reject(chrome.runtime.lastError || new Error('Invalid group ID returned from tabs.group'));
            } else {
                const identifier = getIdentifierForGroupTitle(instance.instanceId);
                const groupTitle = `${GROUP_TITLE_PREFIX}${identifier}`;
                const groupColor = packetUtils.getColorForTopic(instance.title);
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
 * @param {object} instance - The packet instance object.
 * @returns {Promise<number|null>} The group ID the tab was placed in, or null.
 */
export async function ensureTabInGroup(tabId, instance) {
    if (!(await shouldUseTabGroups())) return null;
    if (typeof tabId !== 'number' || !instance || !instance.instanceId) return null;

    try {
        const instanceId = instance.instanceId;
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
        logger.error('TabGroupHandler:ensureTabInGroup', 'Error ensuring tab is in group', { tabId, instanceId: instance.instanceId, error });
        return null;
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

export async function orderDraftTabsInGroup(groupId, attempt = 1) {
    if (!(await shouldUseTabGroups())) return false;
    if (!groupId) return false;

    try {
        const sessionData = await storage.getSession('draftPacketForPreview');
        const draftPacket = sessionData?.draftPacketForPreview;

        if (!draftPacket || !Array.isArray(draftPacket.sourceContent)) {
            logger.warn('TabGroupHandler:orderDraftTabsInGroup', 'Draft packet not found in session storage. Cannot order tabs.');
            return false;
        }

        const tabsInGroup = await chrome.tabs.query({ groupId });
        if (tabsInGroup.length <= 1) return true;

        const getUrlForItem = (item) => {
            if (item.type === 'external') {
                return item.url;
            }
            if (item.type === 'generated' && item.pageId) {
                return chrome.runtime.getURL(`preview.html?pageId=${item.pageId}`);
            }
            return null;
        };

        const draftContentUrls = draftPacket.sourceContent.flatMap(item => {
            if (item.type === 'alternative') {
                return item.alternatives.map(alt => getUrlForItem(alt));
            }
            return getUrlForItem(item);
        }).filter(Boolean);

        const tabPositions = [];
        for (const tab of tabsInGroup) {
            const urlIndex = draftContentUrls.findIndex(url => url === tab.url);
            tabPositions.push({ tabId: tab.id, index: urlIndex !== -1 ? urlIndex : Infinity });
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
        if (error.message.includes('cannot be edited right now') && attempt < 3) {
            logger.warn('TabGroupHandler:orderDraftTabsInGroup', `Retry attempt ${attempt}: Tabs locked, retrying in 500ms.`);
            setTimeout(() => orderDraftTabsInGroup(groupId, attempt + 1), 500);
            return true;
        }
        logger.error('TabGroupHandler:orderDraftTabsInGroup', `Error ordering draft tabs in group ${groupId}`, error);
        return false;
    }
}

export async function handleRemoveTabGroups(data, sendResponse) {
    const { groupIds } = data;
    logger.log('TabGroupHandler:handleRemove', 'Received request to remove groups', { groupIds });

    if (!isTabGroupsAvailable()) {
        logger.warn('TabGroupHandler:handleRemove', 'Tab Groups API not available.');
        return sendResponse({ success: false, error: 'Tab Groups API not available.' });
    }
    if (!Array.isArray(groupIds) || groupIds.length === 0) {
        logger.warn('TabGroupHandler:handleRemove', 'Invalid or empty groupIds array provided.');
        return sendResponse({ success: false, error: 'Invalid group ID array.' });
    }

    await storage.setSession({ 'isClosingGroup': true });

    const errors = [];
    for (const groupId of groupIds) {
        try {
            const tabsInGroup = await chrome.tabs.query({ groupId });

            if (tabsInGroup.length > 0) {
                const windowId = tabsInGroup[0].windowId;
                const tabsInWindow = await chrome.tabs.query({ windowId });

                const willCloseWindow = tabsInWindow.length === tabsInGroup.length;
                
                if (willCloseWindow) {
                    await chrome.tabs.create({ windowId });
                }
                
                const tabIdsToRemove = tabsInGroup.map(t => t.id);
                await chrome.tabs.remove(tabIdsToRemove);

            } else {
                logger.log('TabGroupHandler:handleRemove', `No tabs found for group ${groupId}, considering it closed.`);
            }
        } catch (error) {
            if (error.message.toLowerCase().includes('no tab group with id')) {
                logger.log('TabGroupHandler:handleRemove', `Group ${groupId} not found, likely already closed.`);
            } else {
                logger.error('TabGroupHandler:handleRemove', `Error processing group ${groupId}`, error);
                errors.push(`Group ${groupId}: ${error.message}`);
            }
        }
    }

    setTimeout(() => {
        storage.removeSession('isClosingGroup');
    }, 500); // 500ms is a safe buffer

    const response = { success: errors.length === 0, errors };
    logger.log('TabGroupHandler:handleRemove', 'Sending response', response);
    sendResponse(response);
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

export async function orderTabsInGroup(groupId, instance, attempt = 1) {
    if (!(await shouldUseTabGroups())) return false;
    if (!groupId || !instance || !Array.isArray(instance.contents)) return false;

    try {
        const tabsInGroup = await chrome.tabs.query({ groupId });
        if (tabsInGroup.length <= 1) return true;

        // --- THE FIX: The instance.contents are already flat after migration ---
        const flatContents = instance.contents;

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
        if (error.message.includes('cannot be edited right now') && attempt < 3) {
            logger.warn('TabGroupHandler:orderTabsInGroup', `Retry attempt ${attempt}: Tabs locked, retrying in 500ms.`);
            setTimeout(() => orderTabsInGroup(groupId, instance, attempt + 1), 500);
            return true;
        }
        logger.error('TabGroupHandler:orderTabsInGroup', `Error ordering draft tabs in group ${groupId}`, error);
        return false;
    }
}


export function stopTabReorderingChecks() {
     if (tabReorderIntervalId) {
         clearInterval(tabReorderIntervalId);
         tabReorderIntervalId = null;
     }
}

// --- START OF THE FIX ---
async function findOrCreateDraftGroup() {
    const [existingGroup] = await chrome.tabGroups.query({ title: DRAFT_GROUP_TITLE });
    if (existingGroup) {
        return existingGroup.id;
    }

    const window = await chrome.windows.getLastFocused({ populate: false, windowTypes: ['normal'] });
    if (!window) {
        throw new Error("Could not find a suitable window to create the draft tab group.");
    }

    const tempTab = await chrome.tabs.create({ windowId: window.id, active: false });
    const groupId = await chrome.tabs.group({ tabIds: [tempTab.id] });
    await chrome.tabGroups.update(groupId, { title: DRAFT_GROUP_TITLE, color: 'grey' });
    await chrome.tabs.remove(tempTab.id);
    
    return groupId;
}

export async function syncDraftGroup(desiredUrls) {
    if (!(await shouldUseTabGroups())) {
        return { success: true, groupId: null };
    }
    
    try {
        const window = await chrome.windows.getLastFocused({ populate: false, windowTypes: ['normal'] });
        if (!window) {
            throw new Error("Could not find a normal window to sync the draft group.");
        }
        const targetWindowId = window.id;

        let [draftGroup] = await chrome.tabGroups.query({ title: DRAFT_GROUP_TITLE });
        let groupId = draftGroup ? draftGroup.id : null;

        const tabsInGroup = groupId ? await chrome.tabs.query({ groupId }) : [];
        const currentUrlsInGroup = new Set(tabsInGroup.map(t => t.url));

        if (groupId) {
            const tabsToClose = tabsInGroup.filter(tab => !desiredUrls.includes(tab.url));
            if (tabsToClose.length > 0) {
                await chrome.tabs.remove(tabsToClose.map(t => t.id));
            }
        }

        const urlsToHandle = desiredUrls.filter(url => !currentUrlsInGroup.has(url));

        if (urlsToHandle.length > 0 && !groupId) {
            const firstUrl = urlsToHandle.shift();
            const firstTab = await chrome.tabs.create({ url: firstUrl, active: false, windowId: targetWindowId });
            groupId = await chrome.tabs.group({ tabIds: [firstTab.id] });
            await chrome.tabGroups.update(groupId, { title: DRAFT_GROUP_TITLE, color: 'grey' });
        }

        if (groupId) {
            for (const url of urlsToHandle) {
                const newTab = await chrome.tabs.create({ url, active: false, windowId: targetWindowId });
                await chrome.tabs.group({ tabIds: [newTab.id], groupId });
            }
        }
        
        if (groupId) {
            try {
                await orderDraftTabsInGroup(groupId);
            } catch (orderError) {
                logger.warn('TabGroupHandler:syncDraftGroup', 'Non-critical error during tab ordering.', { groupId, orderError });
            }
        }
        
        return { success: true, groupId: groupId };

    } catch (error) {
        logger.error('TabGroupHandler:syncDraftGroup', 'Error syncing draft group', error);
        return { success: false, error: error.message };
    }
}
// --- END OF THE FIX ---

export async function focusOrCreateDraftTab(url) {
    if (!(await shouldUseTabGroups())) {
        chrome.tabs.create({ url, active: true });
        return;
    }

    const [existingTab] = await chrome.tabs.query({ url });
    if (existingTab) {
        chrome.tabs.update(existingTab.id, { active: true });
        if (existingTab.windowId) {
            chrome.windows.update(existingTab.windowId, { focused: true });
        }
        return;
    }
    
    let newTab;
    let [draftGroup] = await chrome.tabGroups.query({ title: DRAFT_GROUP_TITLE });

    newTab = await chrome.tabs.create({ url, active: true });
    let groupId = draftGroup ? draftGroup.id : null;

    if (groupId) {
        try {
            await chrome.tabs.group({ tabIds: [newTab.id], groupId: groupId });
        } catch (e) {
            logger.warn('TabGroupHandler:focusOrCreateDraftTab', 'Could not add new tab to existing group. It may have been closed.', e);
        }
    } else {
        groupId = await chrome.tabs.group({ tabIds: [newTab.id] });
        await chrome.tabGroups.update(groupId, { title: DRAFT_GROUP_TITLE, color: 'grey' });
    }
    
    if (groupId) {
        try {
            await orderDraftTabsInGroup(groupId);
        } catch(orderError) {
             logger.warn('TabGroupHandler:focusOrCreateDraftTab', 'Non-critical error during tab ordering.', { groupId, orderError });
        }
    }
}

export async function cleanupDraftGroup() {
    if (!(await shouldUseTabGroups())) return;
    try {
        const [draftGroup] = await chrome.tabGroups.query({ title: DRAFT_GROUP_TITLE });
        if (draftGroup) {
            const tabs = await chrome.tabs.query({ groupId: draftGroup.id });
            if (tabs.length > 0) {
                await chrome.tabs.remove(tabs.map(t => t.id));
            }
        }
    } catch (error) {
        logger.error('TabGroupHandler:cleanupDraftGroup', 'Error cleaning up draft group', error);
    }
}