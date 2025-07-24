// ext/background-modules/sidebar-handler.js
// REVISED: The function signature for handleSidebarReady has been corrected to accept
// the 'data' argument from the message handler. This fixes a TypeError that occurred
// because the arguments were being misinterpreted.

import { logger, storage, isSidePanelAvailable, getPacketContext } from '../utils.js';

let pendingSidebarNotifications = [];
let isSidebarReady = false;
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
        if (!error.message.toLowerCase().includes('invalid tab id')) {
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

export function notifySidebar(action, data, retry = true) {
    const noisyActions = ['update_sidebar_context', 'playback_state_updated'];
    if (!noisyActions.includes(action)) {
        logger.log('SidebarHandler:notify', 'Attempting', { action });
    }

    if (!isSidePanelAvailable()) {
        return;
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
                                     errorMsg.includes("Receiving end does not exist");

             if (!isExpectedError) {
                  logger.warn('SidebarHandler:notify', 'Send failed with an unexpected error', { action, error: errorMsg });
             }
             isSidebarReady = false;
             if (retry) {
                 pendingSidebarNotifications.push({ action, data: data, timestamp: Date.now() });
             }
        } else {
             if (!isSidebarReady) {
                  isSidebarReady = true;
                  processPendingNotifications();
             }
        }
    });
}

export function processPendingNotifications() {
    if (pendingSidebarNotifications.length === 0 || !isSidebarReady) return;
    const notificationsToProcess = [...pendingSidebarNotifications];
    pendingSidebarNotifications = [];

    notificationsToProcess.forEach(n => {
        notifySidebar(n.action, n.data, false);
    });
}

/**
 * Handles the 'sidebar_ready' message from the sidebar UI script.
 * @param {object} data - The message data (unused in this handler).
 * @param {object} sender - Message sender details.
 * @param {function} sendResponse - Callback to acknowledge the message.
 */
// *** FIX: Added the 'data' parameter to correct the function signature. ***
export async function handleSidebarReady(data, sender, sendResponse) {
     logger.log('SidebarHandler:handleSidebarReady', 'Ready message received from sidebar UI');

     isSidebarReady = true;
     processPendingNotifications();

     sendResponse({ success: true, message: "Sidebar readiness acknowledged." });
}