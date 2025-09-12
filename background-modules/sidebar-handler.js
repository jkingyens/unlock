// ext/background-modules/sidebar-handler.js
// FINAL FIX: Corrected a TypeError caused by not awaiting the result of chrome.tabs.query,
// which prevented tab reordering and syncing from working correctly.

import { logger, storage, isSidePanelAvailable, getPacketContext } from '../utils.js';

let activeInstanceId = null; // Tracks the InstanceID the background thinks the sidebar should be focused on

export async function updateActionForTab(tabId) {
    if (typeof tabId !== 'number') return;
    const logPrefix = `[SidebarHandler:updateActionForTab Tab ${tabId}]`;

    try {
        const context = await getPacketContext(tabId);
        const sidePanelAvailable = isSidePanelAvailable();
        
        if (context?.instanceId && sidePanelAvailable) {
            await chrome.action.setBadgeText({ tabId: tabId, text: 'PKT' });
            
            try {
                const tab = await chrome.tabs.get(tabId);
                if (tab.groupId && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
                    const group = await chrome.tabGroups.get(tab.groupId);
                    await chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: group.color });
                } else {
                    await chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#1a73e8' });
                }
            } catch (error) {
                await chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#1a73e8' });
            }

            await chrome.action.setPopup({ tabId: tabId, popup: '' });

        } else {
            await chrome.action.setBadgeText({ tabId: tabId, text: '' });
            await chrome.action.setPopup({ tabId: tabId, popup: 'popup.html' });
        }
    } catch (error) {
        if (!error.message.toLowerCase().includes('invalid tab id') && !error.message.toLowerCase().includes('no tab with id')) {
            logger.error(logPrefix, 'Error updating action state', error);
        }
    }
}

export { isSidePanelAvailable };

export function setActivePacketId(instanceId) {
    activeInstanceId = instanceId;
}

export function getActivePacketId() {
    return activeInstanceId;
}

// --- START OF FIX: More resilient notification system ---
export async function notifySidebar(action, data) {
    if (!isSidePanelAvailable()) {
        return;
    }
    
    // Proactively check if the sidebar is open before attempting to send a message.
    const { isSidebarOpen } = await storage.getSession({ isSidebarOpen: false });
    if (!isSidebarOpen) {
        return; // Don't even try to send if we know it's closed.
    }
    
    const messageData = { ...data };
    if ('instanceId' in messageData && !('packetId' in messageData)) {
         messageData.packetId = messageData.instanceId;
    }

    chrome.runtime.sendMessage({ action: action, data: messageData }, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
             const errorMsg = lastError.message || '';
             const isExpectedError = errorMsg.includes("Could not establish connection") || 
                                     errorMsg.includes("Receiving end does not exist") ||
                                     errorMsg.includes("The message port closed before a response was received");

             if (!isExpectedError) {
                  logger.warn('SidebarHandler:notify', 'Send failed with an unexpected error', { action, error: errorMsg });
             }
        }
    });
}
// --- END OF FIX ---


/**
 * Handles the 'sidebar_ready' message from the sidebar UI script.
 * @param {object} data - The message data (unused in this handler).
 * @param {object} sender - Message sender details.
 * @param {function} sendResponse - Callback to acknowledge the message.
 */
export async function handleSidebarReady(data, sender, sendResponse) {
     logger.log('SidebarHandler:handleSidebarReady', 'Ready message received from sidebar UI');
     sendResponse({ success: true, message: "Sidebar readiness acknowledged." });
}