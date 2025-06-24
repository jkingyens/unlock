// ext/background-modules/sidebar-handler.js

import { logger, storage, isSidePanelAvailable, getPacketContext } from '../utils.js';

let pendingSidebarNotifications = [];
let isSidebarReady = false;
let activeInstanceId = null; // Tracks the InstanceID the background thinks the sidebar should be focused on

// --- REVISED: updateActionForTab now reads from session storage ---
export async function updateActionForTab(tabId) {
    if (typeof tabId !== 'number') return;
    const logPrefix = `[SidebarHandler:updateActionForTab Tab ${tabId}]`;

    try {
        // Read the sidebar state directly from session storage for persistence
        const { isSidebarOpen } = await storage.getSession({ isSidebarOpen: false });
        const context = await getPacketContext(tabId);
        const sidePanelAvailable = isSidePanelAvailable();

        if (context?.instanceId && sidePanelAvailable) {
            // It's a packet tab and the side panel feature exists.
            if (isSidebarOpen) {
                // Sidebar is open, hide badge and enable create packet popup
                logger.log(logPrefix, 'Packet tab is active and sidebar is OPEN. Hiding badge, enabling default popup.');
                await chrome.action.setBadgeText({ tabId: tabId, text: '' });
                await chrome.action.setPopup({ tabId: tabId, popup: 'popup.html' });
            } else {
                // Sidebar is closed, show badge and set click to open sidebar
                logger.log(logPrefix, 'Packet tab is active and sidebar is CLOSED. Showing badge, setting action to open sidebar.');
                await chrome.action.setBadgeText({ tabId: tabId, text: 'PKT' });

                // Set badge color from tab group
                try {
                    const tab = await chrome.tabs.get(tabId);
                    if (tab.groupId && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
                        const group = await chrome.tabGroups.get(tab.groupId);
                        await chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: group.color });
                        logger.log(logPrefix, `Set badge color to match group color: ${group.color}`);
                    } else {
                        await chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#1a73e8' });
                    }
                } catch (error) {
                    logger.warn(logPrefix, `Could not get tab group color, using default.`, error);
                    await chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#1a73e8' });
                }

                await chrome.action.setPopup({ tabId: tabId, popup: '' });
            }
        } else {
            // Not a packet tab, or side panel isn't available. Default behavior.
            logger.log(logPrefix, 'Not a packet tab or sidebar unavailable. Resetting to default action.');
            await chrome.action.setBadgeText({ tabId: tabId, text: '' });
            await chrome.action.setPopup({ tabId: tabId, popup: 'popup.html' });
        }
    } catch (error) {
        if (!error.message.toLowerCase().includes('invalid tab id')) {
            logger.error(logPrefix, 'Error updating action state', error);
        }
    }
}


// --- Exports for other modules ---

export { isSidePanelAvailable }; // Re-export if needed by others

/**
 * Sets the active packet instance ID tracked by the background.
 * @param {string | null} instanceId - The ID of the active instance, or null.
 */
export function setActivePacketId(instanceId) {
    if (activeInstanceId !== instanceId) {
         // logger.log('SidebarHandler:setActivePacketId', `Changing active ID from ${activeInstanceId} to ${instanceId}`); // Reduce noise
         activeInstanceId = instanceId;
    }
}

/**
 * Gets the currently tracked active packet instance ID.
 * @returns {string | null}
 */
export function getActivePacketId() {
    return activeInstanceId;
}

/**
 * Send a notification message to the sidebar reliably.
 * Queues message if sidebar is not ready or message send fails.
 * @param {string} action - The action name for the message.
 * @param {object} data - The data payload for the message.
 * @param {boolean} [retry=true] - Whether to queue if send fails initially.
 */
export function notifySidebar(action, data, retry = true) {
    const noisyActions = ['update_sidebar_context']; // Actions to log less often
    if (!noisyActions.includes(action)) {
        // Log potentially sensitive data carefully if needed
        logger.log('SidebarHandler:notify', 'Attempting', { action /*, data: data */ }); // Avoid logging full data by default
    }

    if (!isSidePanelAvailable()) {
        // Don't warn every time, this is expected if the API isn't there
        // logger.warn('SidebarHandler:notify', 'Skipped: Side Panel API unavailable.');
        return;
    }

    // Sidebar UI script (sidebar.js) might expect 'packetId' key for instance ID.
    const messageData = { ...data };
    if ('instanceId' in messageData && !('packetId' in messageData)) {
         messageData.packetId = messageData.instanceId;
         // delete messageData.instanceId; // Decide if sidebar needs instanceId too
    }
    // Keep the warning for potentially incorrect IDs being sent
    if ('packetId' in messageData && messageData.packetId !== null && !String(messageData.packetId).startsWith('inst_')) {
        logger.warn('SidebarHandler:notify', `Sending non-instance ID as packetId for action '${action}'`, { packetId: messageData.packetId });
    }

    chrome.runtime.sendMessage({ action: action, data: messageData }, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
             const errorMsg = lastError.message || '';
             // Only log actual errors, not expected connection failures when sidebar is closed
             if (!errorMsg.includes("Could not establish connection") && !errorMsg.includes("Receiving end does not exist")) {
                  logger.warn('SidebarHandler:notify', 'Send failed', { action, error: errorMsg });
             }
             isSidebarReady = false; // Assume sidebar is not ready on any error
             if (retry) {
                 pendingSidebarNotifications.push({ action, data: data, timestamp: Date.now() }); // Queue original data structure
                 if (pendingSidebarNotifications.length > 100) pendingSidebarNotifications.shift(); // Limit queue size
                 if (!noisyActions.includes(action)) logger.log('SidebarHandler:notify', 'Queued notification', { action, queueLength: pendingSidebarNotifications.length });
             }
        } else { // Success
             if (!isSidebarReady) {
                  logger.log('SidebarHandler:notify', 'Communication successful, processing queue');
                  isSidebarReady = true;
                  processPendingNotifications(); // Process queue on first success
             }
             // Optional: log success for non-noisy actions
             // if (!noisyActions.includes(action)) logger.log('SidebarHandler:notify', 'Success', { action });
        }
    });
}

/**
 * Process queued sidebar notifications if the sidebar is marked as ready.
 */
export function processPendingNotifications() {
    if (pendingSidebarNotifications.length === 0 || !isSidebarReady) return;
    logger.log('SidebarHandler:processPending', `Processing ${pendingSidebarNotifications.length} queued notifications.`);
    const notificationsToProcess = [...pendingSidebarNotifications];
    pendingSidebarNotifications = []; // Clear queue before processing
    const now = Date.now();
    const MAX_AGE = 5 * 60 * 1000; // 5 minutes expiration for queued messages

    notificationsToProcess.forEach(n => {
        if (now - n.timestamp < MAX_AGE) {
             // Resend without queuing again on failure (retry=false)
             notifySidebar(n.action, n.data, false);
        } else {
             logger.log('SidebarHandler:processPending', 'Skipping stale notification', {action: n.action});
        }
    });
}


// --- Functions Called by Message Handler ---

/**
 * Handles the 'sidebar_ready' message from the sidebar UI script.
 * Marks the sidebar as ready and processes any queued notifications.
 * Called from message-handlers.js
 * @param {object} sender - Message sender details.
 * @param {function} sendResponse - Callback to acknowledge the message.
 */
export async function handleSidebarReady(sender, sendResponse) {
     // const tabId = sender.tab?.id; // tabId might not be relevant for global panel
     logger.log('SidebarHandler:handleSidebarReady', 'Ready message received from sidebar UI');

     isSidebarReady = true; // Mark sidebar as ready for direct notifications
     processPendingNotifications(); // Process any queued notifications immediately

     sendResponse({ success: true, message: "Sidebar readiness acknowledged." });
     // No need to return true, sendResponse is synchronous here.
}