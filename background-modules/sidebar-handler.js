// ext/background-modules/sidebar-handler.js
// REVISED: Implemented long-lived Port connection for reliable sidebar messaging.
// This replaces the flaky sendMessage calls with a persistent connection that
// automatically handles the sidebar's lifecycle.

import { logger, storage, isSidePanelAvailable, getPacketContext } from '../utils.js';

let activeInstanceId = null; // Tracks the InstanceID the background thinks the sidebar should be focused on
let sidebarPort = null; // NEW: Track the persistent connection

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

// --- NEW: Handle Long-Lived Connection ---
export function handleSidebarConnection(port) {
    logger.log('SidebarHandler', 'Sidebar connected via port.');
    sidebarPort = port;
    
    // Update session state immediately
    storage.setSession({ isSidebarOpen: true });

    port.onDisconnect.addListener(() => {
        logger.log('SidebarHandler', 'Sidebar disconnected.');
        sidebarPort = null;
        storage.setSession({ isSidebarOpen: false });
    });
}

// --- REVISED: Notify via Port ---
export async function notifySidebar(action, data) {
    // Only attempt to send if we have an active connection.
    // This inherently solves the "Receiving end does not exist" error.
    if (sidebarPort) {
        try {
            const messageData = { ...data };
            if ('instanceId' in messageData && !('packetId' in messageData)) {
                 messageData.packetId = messageData.instanceId;
            }
            sidebarPort.postMessage({ action: action, data: messageData });
        } catch (e) {
            logger.warn('SidebarHandler:notify', 'Failed to post message to sidebar port', e);
            sidebarPort = null;
        }
    } else {
        // Optional: Log debug info if needed, but generally we just suppress the message
        // since the sidebar isn't there to care about it.
    }
}

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