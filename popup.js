// ext/popup.js - Entry point for the extension popup UI.

import { logger, storage, CONFIG, isSidePanelAvailable, applyThemeMode } from './utils.js';
// Import necessary functions from popup_actions.js
import { handleCreatePacket, handleOpenSidebar, sendMessageToBackground } from './popup_actions.js';

// --- DOM Refs ---
let createBtn;
let progressContainer, progressBar;
let progressTimeout = null;
let createPacketContainer, onboardingContainer, openSidebarBtnPopup;
let settingsComplete = false; // Flag to track settings status from initialization

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    logger.log('Popup', 'Popup DOM loaded & initializing...');
    await applyThemeMode(); // Apply theme

    // --- Cache DOM References ---
    createBtn = document.getElementById('create-btn');
    progressContainer = document.getElementById('creation-progress-container');
    progressBar = document.getElementById('creation-progress-bar');
    createPacketContainer = document.getElementById('create-packet-container');
    onboardingContainer = document.getElementById('onboarding-container');
    openSidebarBtnPopup = document.getElementById('open-sidebar-btn-popup');

    // --- Initial State Setup ---
    settingsComplete = false;
    try {
        const activeModelConfig = await storage.getActiveModelConfig();
        const storageEnabled = await storage.isCloudStorageEnabled();
        
        let modelConfigSufficient = false;
        if (activeModelConfig) {
            if (activeModelConfig.providerType === 'chrome-ai-gemini-nano') {
                modelConfigSufficient = true; 
            } else if (activeModelConfig.apiKey && activeModelConfig.apiEndpoint) {
                modelConfigSufficient = true;
            }
        }
        
        settingsComplete = modelConfigSufficient && storageEnabled;

        if (settingsComplete) {
            if (createPacketContainer) createPacketContainer.classList.remove('hidden');
            if (onboardingContainer) onboardingContainer.classList.add('hidden');
            if (createBtn) createBtn.disabled = false;
        } else {
            if (createPacketContainer) createPacketContainer.classList.add('hidden');
            if (onboardingContainer) onboardingContainer.classList.remove('hidden');
            if (createBtn) {
                createBtn.disabled = true;
                createBtn.title = 'Configure active LLM Model & Cloud Storage in Sidebar Settings.';
            }
            let specificMessage = 'Please configure an active LLM Model and Cloud Storage in Sidebar > Settings.';
            if (!modelConfigSufficient && !storageEnabled) {
                specificMessage = 'Please configure an active LLM Model and Cloud Storage in Settings.';
            } else if (!modelConfigSufficient) {
                specificMessage = 'Please select/configure an active LLM Model in Settings.';
            } else if (!storageEnabled) {
                specificMessage = 'Please configure Cloud Storage in Settings.';
            }
            if (onboardingContainer) onboardingContainer.querySelector('p').textContent = specificMessage;
            logger.warn('Popup', 'Settings incomplete, showing onboarding message.', {modelConfigSufficient, storageEnabled});
        }

    } catch (error) {
        logger.error('Popup', 'Error during settings check', error);
        if (createPacketContainer) createPacketContainer.classList.add('hidden');
        if (onboardingContainer) {
            onboardingContainer.classList.remove('hidden');
            onboardingContainer.querySelector('p').textContent = 'Error checking settings. Please try again or check Sidebar.';
        }
        if (createBtn) createBtn.disabled = true;
        settingsComplete = false;
    }

    // --- Event Listeners ---
    if (createBtn) { 
        createBtn.addEventListener('click', async () => {
            if (createBtn.disabled) return; 

            createBtn.disabled = true;

            storage.setSession({ [CONFIG.STORAGE_KEYS.PENDING_VIEW_KEY]: 'root' })
                .then(async () => {
                    await handleCreatePacket();
                })
                .catch(async err => {
                    logger.error('Popup', 'Failed to set pending view in session storage', err);
                    await handleCreatePacket();
                });

            setTimeout(() => {
                window.close();
            }, 150);
        });
    }

    if (openSidebarBtnPopup) {
        if (isSidePanelAvailable()) {
            openSidebarBtnPopup.disabled = false;
            openSidebarBtnPopup.addEventListener('click', async () => {
                 try {
                     // 1. Tell background to store the target view. This handles the case where the sidebar is closed.
                     await sendMessageToBackground({
                         action: 'prepare_sidebar_navigation',
                         data: { targetView: 'settings' }
                     });

                     // 2. Ensure the sidebar is open.
                     await handleOpenSidebar();

                     // 3. Send a direct message to navigate. This handles the case where the sidebar is already open.
                     await sendMessageToBackground({
                         action: 'navigate_to_view',
                         data: { viewName: 'settings' }
                     });

                     // 4. Close the popup.
                     window.close();
                 } catch (err) {
                      logger.error("Popup", "Failed to open or navigate sidebar for settings", err);
                 }
            });
        } else {
             openSidebarBtnPopup.disabled = true;
             openSidebarBtnPopup.textContent = 'Sidebar Unavailable';
             openSidebarBtnPopup.title = 'The Side Panel API is not available in your browser version.';
        }
    }

    updateProgressBar('idle');
    logger.log('Popup', 'Popup initialized.');
});

// --- Progress Bar Update Function ---
function updateProgressBar(status, progressPercent = null, step = null) {
    if (!progressContainer || !progressBar) return;
    clearTimeout(progressTimeout);
    progressTimeout = null;
    let widthPercent = 0;
    progressBar.className = ''; 
    progressBar.classList.add(status); 

    if (status === 'idle') {
        progressContainer.classList.add('hidden');
        widthPercent = 0;
    } else {
        progressContainer.classList.remove('hidden');
        if (status === 'inprogress') {
            switch (step) {
                case 'start': widthPercent = 5; break;
                case 'articles': widthPercent = 33; break;
                case 'generate_summary': widthPercent = 50; break; 
                case 'generate_quiz': widthPercent = 66; break;
                case 'local_save': case 'publish': case 'instantiate': widthPercent = 100; break;
                default: try { widthPercent = parseFloat(progressBar.style.width) || 5; } catch { widthPercent = 5; } break;
            }
        } else if (status === 'success' || status === 'error') {
            widthPercent = 100;
            progressTimeout = setTimeout(() => { updateProgressBar('idle'); }, 3000); 
        } else {
            status = 'idle'; progressBar.className = ''; progressBar.classList.add(status);
            progressContainer.classList.add('hidden'); widthPercent = 0;
        }
        progressBar.style.width = `${widthPercent}%`;
    }
}

// --- Background Message Listener ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
        case 'theme_preference_updated':
            applyThemeMode();
            break;
        case 'packet_creation_progress':
            break;
        case 'packet_creation_complete':
            break;
        case 'packet_creation_failed':
            break;
        default:
            break;
    }
    return false; 
});