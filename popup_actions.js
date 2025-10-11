// ext/popup_actions.js - Action handlers for the popup (Global Side Panel Mode)

import { logger, storage, isSidePanelAvailable } from './utils.js';

// --- Helper: sendMessageToBackground ---
function sendMessageToBackground(message) {
     return new Promise((resolve, reject) => {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage(message, function(response) {
                if (chrome.runtime.lastError) {
                    const errorMsg = chrome.runtime.lastError.message || 'Unknown error';
                    if (!errorMsg.includes("Receiving end does not exist") && !errorMsg.includes("Could not establish connection")) {
                         logger.error('PopupActions', 'sendMessage Error:', chrome.runtime.lastError);
                         reject(new Error('Error communicating with background: ' + errorMsg));
                    } else {
                         logger.warn('PopupActions', 'sendMessage failed, background likely inactive.', message.action);
                         resolve({ success: false, error: 'Background service inactive or disconnected.' });
                    }
                } else {
                    resolve(response);
                }
            });
        } else {
            reject(new Error('Chrome runtime is not available.'));
        }
    });
}

// --- Helper: getCurrentTabs ---
function getCurrentTabs() {
    return new Promise((resolve, reject) => {
        if (typeof chrome !== 'undefined' && chrome.windows && chrome.tabs) {
            chrome.windows.getCurrent({ populate: false }, (currentWindow) => {
                if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
                if (!currentWindow) return reject(new Error("No current window."));
                chrome.tabs.query({ active: true, windowId: currentWindow.id }, (tabs) => {
                    if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                    else resolve(tabs || []);
               });
            });
        } else {
            reject(new Error("Chrome API not available"));
        }
    });
}

// --- Action Handlers ---

async function handleCreatePacket() {
    const statusMessage = document.getElementById('status-message'); // This might not exist in your current popup, which is fine
    const createBtn = document.getElementById('create-btn');

    try {
        await handleOpenSidebar();
        // The sender tab ID will be automatically available in the background script
        sendMessageToBackground({
            action: 'initiate_packet_creation_from_tab'
        });

    } catch (error) {
        logger.error('PopupActions', 'Error during packet creation initiation or sidebar opening', error);
        if (statusMessage) {
            statusMessage.textContent = 'Error: ' + error.message;
        }
    }
}

async function handleOpenSidebar() {
    const statusMessage = document.getElementById('status-message');
    if (!isSidePanelAvailable()) {
        logger.warn('PopupActions:handleOpenSidebar', 'Side Panel API not available.');
        if (statusMessage) {
            statusMessage.textContent = "Sidebar not supported by this browser.";
            statusMessage.className = 'status-message error-message';
            statusMessage.style.visibility = 'visible';
            statusMessage.style.display = 'block';
        }
        return;
    }

    try {
        const currentWindow = await new Promise((resolve, reject) => {
             if (!chrome?.windows?.getCurrent) return reject(new Error("chrome.windows API not available"));
             chrome.windows.getCurrent({}, (window) => {
                 if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
                 else resolve(window);
             });
        });

        if (!currentWindow || typeof currentWindow.id !== 'number') {
             throw new Error("Could not get current window ID.");
        }
        const windowId = currentWindow.id;

        logger.log('PopupActions:handleOpenSidebar', 'Attempting to open side panel globally for window:', windowId);
        await chrome.sidePanel.open({ windowId });
        logger.log('PopupActions:handleOpenSidebar', 'Global side panel open call successful.');

    } catch (error) {
        logger.error('PopupActions', 'Error opening global sidebar', error);
        if (statusMessage) {
            statusMessage.textContent = "Error opening sidebar: " + error.message;
            statusMessage.className = 'status-message error-message';
            statusMessage.style.visibility = 'visible';
            statusMessage.style.display = 'block';
        }
    }
}

export {
    handleCreatePacket,
    handleOpenSidebar,
    getCurrentTabs, 
    sendMessageToBackground 
};