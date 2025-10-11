// ext/sidebar-modules/dialog-handler.js
// Manages the logic for all modal dialogs in the sidebar (Import, Share, Confirm, etc.).

import { domRefs } from './dom-references.js';
import { logger } from '../utils.js';

// --- Module-specific State & Dependencies ---
let confirmDialogResolve = null;
let closeGroupConfirmListener = null;
let closeGroupCancelListener = null;
let closeGroupOverlayClickListener = null;
let inputPromptResolve = null;
let inputPromptConfirmListener = null;
let inputPromptCancelListener = null;
let inputPromptKeyListener = null;
let qrCodeInstance = null; // To hold the single QRCode instance

// --- START OF NEW CODE ---
let confirmSettingsResolve = null;
// --- END OF NEW CODE ---

let sendMessageToBackground;
let showRootViewStatus;
let navigateTo;


// --- Initialization ---
export function init(dependencies) {
    sendMessageToBackground = dependencies.sendMessageToBackground;
    showRootViewStatus = dependencies.showRootViewStatus;
    navigateTo = dependencies.navigateTo;
}

/**
 * Attaches all event listeners for the dialogs.
 */
export function setupDialogListeners() {
    // Share Dialog
    domRefs.closeShareDialogBtn?.addEventListener('click', hideShareDialog);
    domRefs.copyShareLinkBtn?.addEventListener('click', () => {
        if (domRefs.shareDialogUrlInput) {
            navigator.clipboard.writeText(domRefs.shareDialogUrlInput.value)
                .then(() => {
                    domRefs.copyShareLinkBtn.textContent = 'Copied!';
                    setTimeout(() => { domRefs.copyShareLinkBtn.textContent = 'Copy Link'; }, 1500);
                })
                .catch(err => {
                    logger.error('DialogHandler:copyLink', 'Failed to copy text: ', err);
                });
        }
    });
    domRefs.shareDialog?.addEventListener('click', (event) => {
        if (event.target === domRefs.shareDialog) hideShareDialog();
    });

    document.getElementById('toggle-qr-code-btn')?.addEventListener('click', () => {
        const qrCodeContainer = document.getElementById('share-dialog-qrcode');
        const toggleBtn = document.getElementById('toggle-qr-code-btn');
        const isVisible = qrCodeContainer.style.display === 'block';
        qrCodeContainer.style.display = isVisible ? 'none' : 'block';
        toggleBtn.textContent = isVisible ? 'Show QR Code' : 'Hide QR Code';
    });

    // Import Dialog
    domRefs.confirmImportDialogBtn?.addEventListener('click', handleImportPacket);
    domRefs.cancelImportDialogBtn?.addEventListener('click', hideImportDialog);
    domRefs.importDialog?.addEventListener('click', (event) => {
        if (event.target === domRefs.importDialog) hideImportDialog();
    });
    domRefs.importDialogUrlInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && domRefs.confirmImportDialogBtn && !domRefs.confirmImportDialogBtn.disabled) {
            handleImportPacket();
        }
    });

    // Generic Confirm Dialog
    domRefs.genericConfirmConfirmBtn?.addEventListener('click', () => hideConfirmDialog(true));
    domRefs.genericConfirmCancelBtn?.addEventListener('click', () => hideConfirmDialog(false));
    domRefs.genericConfirmDialog?.addEventListener('click', (event) => {
        if (event.target === domRefs.genericConfirmDialog) hideConfirmDialog(false);
    });

    // --- START OF NEW CODE ---
    // Confirm Settings Dialog
    const settingsDialog = document.getElementById('confirm-settings-dialog-overlay');
    if (settingsDialog) {
        settingsDialog.querySelector('.confirm-btn')?.addEventListener('click', () => hideConfirmSettingsDialog(true));
        settingsDialog.querySelector('.cancel-btn')?.addEventListener('click', () => hideConfirmSettingsDialog(false));
        settingsDialog.addEventListener('click', (e) => { 
            if (e.target === settingsDialog) hideConfirmSettingsDialog(false);
        });
    }
    // --- END OF NEW CODE ---
}


// --- Private Helper Functions ---

function showDialogStatus(element, message, type = 'info', autoClear = true) {
    if (!element) return;
    element.textContent = message;
    element.className = 'dialog-status-message'; // Reset classes
    if (type === 'error') element.classList.add('error-message');
    if (type === 'success') element.classList.add('success-message');
    element.style.visibility = 'visible';
    
    const existingTimeoutId = parseInt(element.dataset.clearTimeoutId, 10);
    if (!isNaN(existingTimeoutId)) clearTimeout(existingTimeoutId);

    if (autoClear) {
        const newTimeoutId = setTimeout(() => clearDialogStatus(element, message), 4000);
        element.dataset.clearTimeoutId = newTimeoutId.toString();
    }
}

function clearDialogStatus(element, ifMatchesText = null) {
    if (element && (!ifMatchesText || element.textContent === ifMatchesText)) {
        element.textContent = '';
        element.style.visibility = 'hidden';
        element.className = 'dialog-status-message';
        delete element.dataset.clearTimeoutId;
    }
}


// --- Dialog Implementations ---

export async function exportPacketAndShowDialog(imageId) {
    if (!imageId) return;
    showRootViewStatus(`Exporting...`, 'info', false);
    try {
        const response = await sendMessageToBackground({
            action: 'publish_image_for_sharing',
            data: { imageId: imageId }
        });
        if (response?.success && response.shareUrl) {
            showShareDialog(response.shareUrl);
            showRootViewStatus(response.message || 'Packet exported!', 'success');
        } else {
            throw new Error(response?.error || 'Failed to export packet.');
        }
    } catch (error) {
        showRootViewStatus(`Export failed: ${error.message}`, 'error');
    }
}

export function showShareDialog(url) {
    const dialog = domRefs.shareDialog;
    const qrCodeContainer = document.getElementById('share-dialog-qrcode');
    if (!dialog || !domRefs.shareDialogUrlInput || !domRefs.copyShareLinkBtn || !qrCodeContainer) return;
    domRefs.shareDialogUrlInput.value = url;
    domRefs.copyShareLinkBtn.textContent = 'Copy Link';
    
    if (typeof QRCode !== 'undefined') {
        if (qrCodeInstance === null) {
            qrCodeInstance = new QRCode(qrCodeContainer, {
                text: url,
                width: 256,
                height: 256,
                correctLevel: QRCode.CorrectLevel.L
            });
        } else {
            qrCodeInstance.makeCode(url);
        }
    } else {
        qrCodeContainer.innerHTML = '<p style="color:red; font-size: 0.9em;">QR Code library failed to load.</p>';
        console.error("QRCode library not loaded!");
    }
    
    qrCodeContainer.style.display = 'none';
    document.getElementById('toggle-qr-code-btn').textContent = 'Show QR Code';

    dialog.style.display = 'flex';
    
    requestAnimationFrame(() => {
        dialog.classList.add('visible');
        requestAnimationFrame(() => {
            domRefs.shareDialogUrlInput.select();
            try { domRefs.shareDialogUrlInput.focus(); } catch (e) {}
        });
    });
}

function hideShareDialog() {
    const dialog = domRefs.shareDialog;
    if (dialog) {
        dialog.classList.remove('visible');
        setTimeout(() => {
            if (dialog) dialog.style.display = 'none';
            if (qrCodeInstance) {
                qrCodeInstance.clear();
            }
        }, 300);
    }
}

export function showImportDialog() {
    const dialog = domRefs.importDialog;
    if (dialog) {
        domRefs.importDialogUrlInput.value = '';
        domRefs.importDialogUrlInput.disabled = false;
        domRefs.confirmImportDialogBtn.disabled = false;
        domRefs.cancelImportDialogBtn.disabled = false;
        clearDialogStatus(domRefs.importDialogStatusMessage);
        dialog.style.display = 'flex';
        
        requestAnimationFrame(() => {
            dialog.classList.add('visible');
            requestAnimationFrame(() => {
                domRefs.importDialogUrlInput.focus();
            });
        });
    }
}

export function hideImportDialog() {
    const dialog = domRefs.importDialog;
    if (dialog) {
        dialog.classList.remove('visible');
        setTimeout(() => { if (dialog) dialog.style.display = 'none'; }, 300);
    }
}

async function handleImportPacket() {
    const url = domRefs.importDialogUrlInput?.value?.trim();
    const urlInput = domRefs.importDialogUrlInput;
    const importBtn = domRefs.confirmImportDialogBtn;
    const cancelBtn = domRefs.cancelImportDialogBtn;
    
    clearDialogStatus(domRefs.importDialogStatusMessage);
    if (!url || !url.startsWith('http')) {
        showDialogStatus(domRefs.importDialogStatusMessage, 'Please enter a valid Packet Share URL.', 'error', false);
        urlInput?.focus();
        return;
    }

    showDialogStatus(domRefs.importDialogStatusMessage, 'Importing packet...', 'info', false);
    if (importBtn) importBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    if (urlInput) urlInput.disabled = true;

    try {
        const response = await sendMessageToBackground({ action: 'import_image_from_url', data: { url: url } });
        if (!(response && response.success)) {
            throw new Error(response?.error || 'Failed to start import.');
        }
    } catch (error) {
        showDialogStatus(domRefs.importDialogStatusMessage, `Import failed: ${error.message}`, 'error', false);
        if (importBtn) importBtn.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
        if (urlInput) urlInput.disabled = false;
    }
}

export function showCloseGroupDialog(data) {
    const { topic, tabGroupId, instanceId } = data;
    if (!domRefs.closeGroupDialog) return;
    
    removeCloseGroupDialogListeners();
    domRefs.closeGroupDialogMessage.textContent = `Packet '${topic || 'this packet'}' complete!`;
    
    closeGroupConfirmListener = () => handleConfirmCloseGroup(tabGroupId, instanceId);
    closeGroupCancelListener = hideCloseGroupDialog;
    closeGroupOverlayClickListener = (e) => { if (e.target === domRefs.closeGroupDialog) hideCloseGroupDialog(); };

    domRefs.confirmCloseGroupBtn.addEventListener('click', closeGroupConfirmListener);
    domRefs.cancelCloseGroupBtn.addEventListener('click', closeGroupCancelListener);
    domRefs.closeGroupDialog.addEventListener('click', closeGroupOverlayClickListener);
    
    domRefs.closeGroupDialog.style.display = 'flex';
    setTimeout(() => domRefs.closeGroupDialog.classList.add('visible'), 10);
}

function hideCloseGroupDialog() {
    const dialog = domRefs.closeGroupDialog;
    if (dialog) {
        dialog.classList.remove('visible');
        setTimeout(() => { if (dialog) dialog.style.display = 'none'; }, 300);
    }
    removeCloseGroupDialogListeners();
}

function removeCloseGroupDialogListeners() {
    if (closeGroupConfirmListener) domRefs.confirmCloseGroupBtn?.removeEventListener('click', closeGroupConfirmListener);
    if (closeGroupCancelListener) domRefs.cancelCloseGroupBtn?.removeEventListener('click', closeGroupCancelListener);
    if (closeGroupOverlayClickListener) domRefs.closeGroupDialog?.removeEventListener('click', closeGroupOverlayClickListener);
    closeGroupConfirmListener = closeGroupCancelListener = closeGroupOverlayClickListener = null;
}

async function handleConfirmCloseGroup(tabGroupId, instanceIdToClose) {
    hideCloseGroupDialog();

    if (typeof navigateTo === 'function') {
        navigateTo('root'); 
    }
    
    const playbackState = await sendMessageToBackground({ action: 'get_playback_state' });
    if (playbackState && playbackState.instanceId === instanceIdToClose) {
        sendMessageToBackground({
            action: 'request_playback_action',
            data: { intent: 'stop' }
        });
    }

    sendMessageToBackground({ action: 'remove_tab_groups', data: { groupIds: [tabGroupId] } })
        .catch(err => logger.error("DialogHandler", `Error sending close group message: ${err.message}`));
}

export function showConfirmDialog(message, confirmText = 'Confirm', cancelText = 'Cancel', isDangerAction = false) {
    return new Promise((resolve) => {
        confirmDialogResolve = resolve;
        if (domRefs.genericConfirmDialog) {
            domRefs.genericConfirmMessage.textContent = message;
            domRefs.genericConfirmConfirmBtn.textContent = confirmText;
            domRefs.genericConfirmCancelBtn.textContent = cancelText;
            domRefs.genericConfirmConfirmBtn.classList.toggle('danger', isDangerAction);
            domRefs.genericConfirmDialog.style.display = 'flex';
            setTimeout(() => domRefs.genericConfirmDialog.classList.add('visible'), 10);
        } else {
            resolve(false);
        }
    });
}

function hideConfirmDialog(confirmedResult = false) {
    const dialog = domRefs.genericConfirmDialog;
    if (dialog) {
        dialog.classList.remove('visible');
        setTimeout(() => { if (dialog) dialog.style.display = 'none'; }, 300);
    }
    if (confirmDialogResolve) confirmDialogResolve(confirmedResult);
    confirmDialogResolve = null;
}

export function showInputPromptDialog(options) {
    return new Promise((resolve) => {
        const { message, confirmText, defaultValuePromise, placeholder } = options;
        inputPromptResolve = resolve;
        const dialog = domRefs.inputPromptDialog;
        const statusEl = document.getElementById('input-prompt-status');
        if (!dialog || !statusEl) {
            logger.error("DialogHandler", "Input prompt dialog elements not found!");
            return resolve(null);
        }

        domRefs.inputPromptMessage.textContent = message;
        domRefs.confirmInputPromptBtn.textContent = confirmText;
        domRefs.inputPromptInput.placeholder = placeholder;
        domRefs.inputPromptInput.value = '';
        domRefs.confirmInputPromptBtn.disabled = true;
        showDialogStatus(statusEl, 'Generating suggestion...', 'info', false);
        
        defaultValuePromise.then(defaultValue => {
            domRefs.inputPromptInput.value = defaultValue;
            domRefs.confirmInputPromptBtn.disabled = false;
            clearDialogStatus(statusEl);
        }).catch(() => {
            domRefs.confirmInputPromptBtn.disabled = false;
            clearDialogStatus(statusEl);
        });
        
        inputPromptConfirmListener = () => hideInputPromptDialog(domRefs.inputPromptInput.value.trim());
        inputPromptCancelListener = () => hideInputPromptDialog(null);
        inputPromptKeyListener = (e) => {
            if (e.key === 'Enter' && !domRefs.confirmInputPromptBtn.disabled) {
                e.preventDefault();
                hideInputPromptDialog(domRefs.inputPromptInput.value.trim());
            }
        };

        domRefs.confirmInputPromptBtn.addEventListener('click', inputPromptConfirmListener);
        domRefs.cancelInputPromptBtn.addEventListener('click', inputPromptCancelListener);
        domRefs.inputPromptInput.addEventListener('keypress', inputPromptKeyListener);

        dialog.style.display = 'flex';
        
        requestAnimationFrame(() => {
            dialog.classList.add('visible');
            requestAnimationFrame(() => {
                domRefs.inputPromptInput.focus();
                domRefs.inputPromptInput.select();
            });
        });
    });
}

function hideInputPromptDialog(valueToResolve) {
    const dialog = domRefs.inputPromptDialog;
    if (dialog) {
        dialog.classList.remove('visible');
        setTimeout(() => { if (dialog) dialog.style.display = 'none'; }, 300);
    }

    if (inputPromptConfirmListener) domRefs.confirmInputPromptBtn?.removeEventListener('click', inputPromptConfirmListener);
    if (inputPromptCancelListener) domRefs.cancelInputPromptBtn?.removeEventListener('click', inputPromptCancelListener);
    if (inputPromptKeyListener) domRefs.inputPromptInput?.removeEventListener('keypress', inputPromptKeyListener);
    
    inputPromptConfirmListener = null;
    inputPromptCancelListener = null;
    inputPromptKeyListener = null;

    if (inputPromptResolve) {
        inputPromptResolve(valueToResolve);
        inputPromptResolve = null;
    }
}

// --- NEW DIALOG: Create Source ---
let createSourceDialogResolve = null;

export function showCreateSourceDialog() {
    return new Promise(async (resolve) => {
        createSourceDialogResolve = resolve;
        const dialog = document.getElementById('create-source-dialog');
        if (dialog) {
            const buttonDiv = document.getElementById('create-source-dialog-buttons');
            const progressDiv = document.getElementById('create-source-dialog-progress');
            if (buttonDiv) buttonDiv.classList.remove('hidden');
            if (progressDiv) progressDiv.classList.add('hidden');

            const createFromTabBtn = dialog.querySelector('#create-from-tab-btn');
            const { isPacketizable } = await sendMessageToBackground({ action: 'is_current_tab_packetizable' });
            createFromTabBtn.style.display = isPacketizable ? 'block' : 'none';

            dialog.querySelector('#create-from-blank-btn').onclick = () => {
                if (createSourceDialogResolve) createSourceDialogResolve('blank');
            };
            createFromTabBtn.onclick = () => {
                if (createSourceDialogResolve) createSourceDialogResolve('tab');
            };
            dialog.querySelector('#create-from-codebase-btn').onclick = () => {
                if (createSourceDialogResolve) createSourceDialogResolve('codebase');
            };

            dialog.querySelector('#cancel-create-source-btn').onclick = () => hideCreateSourceDialog('cancel');
            dialog.onclick = (e) => { 
                if (e.target === dialog) hideCreateSourceDialog('cancel');
            };
            
            dialog.style.display = 'flex';
            setTimeout(() => dialog.classList.add('visible'), 10);
        } else {
            resolve(null);
        }
    });
}


export function showCreateSourceDialogProgress(message) {
    const dialog = document.getElementById('create-source-dialog');
    if (dialog) {
        const buttonDiv = document.getElementById('create-source-dialog-buttons');
        const progressDiv = document.getElementById('create-source-dialog-progress');
        const progressMessage = document.getElementById('create-source-dialog-progress-message');

        if (buttonDiv) buttonDiv.classList.add('hidden');
        if (progressMessage) progressMessage.textContent = message || 'Processing...';
        if (progressDiv) progressDiv.classList.remove('hidden');
    }
}

export function hideCreateSourceDialog(reason) {
    const dialog = document.getElementById('create-source-dialog');
    if (dialog) {
        dialog.querySelector('#create-from-blank-btn').onclick = null;
        dialog.querySelector('#create-from-tab-btn').onclick = null;
        dialog.querySelector('#create-from-codebase-btn').onclick = null;
        dialog.querySelector('#cancel-create-source-btn').onclick = null;
        dialog.onclick = null;

        dialog.classList.remove('visible');
        setTimeout(() => { if (dialog) dialog.style.display = 'none'; }, 300);
    }

    if (reason === 'cancel' && createSourceDialogResolve) {
        createSourceDialogResolve(null);
    }
    createSourceDialogResolve = null;
}

// --- START OF NEW CODE ---
export function showConfirmSettingsDialog(options) {
    return new Promise((resolve) => {
        confirmSettingsResolve = resolve;
        const { proposedChanges } = options;
        const dialog = document.getElementById('confirm-settings-dialog-overlay');
        const contentContainer = document.getElementById('confirm-settings-dialog-content');
        
        if (!dialog || !contentContainer) {
            logger.error("DialogHandler", "Confirm Settings dialog elements not found!");
            return resolve(false);
        }

        contentContainer.innerHTML = ''; // Clear previous content

        proposedChanges.forEach(change => {
            const changeElement = document.createElement('div');
            changeElement.className = 'proposed-change';

            if (change.operation === 'add' && change.path === 'llmModels' && change.value) {
                const model = change.value;
                changeElement.innerHTML = `
                    <p class="change-description">Add a new LLM configuration:</p>
                    <div class="model-details">
                        <strong>Name:</strong> <span>${model.name}</span><br>
                        <strong>Provider:</strong> <span>${model.providerType}</span><br>
                        <strong>API Key:</strong> <span class="api-key-value">${model.apiKey.substring(0, 4)}...${model.apiKey.substring(model.apiKey.length - 4)}</span>
                    </div>
                `;
            }
            contentContainer.appendChild(changeElement);
        });

        dialog.style.display = 'flex';
        setTimeout(() => dialog.classList.add('visible'), 10);
    });
}

function hideConfirmSettingsDialog(confirmedResult = false) {
    const dialog = document.getElementById('confirm-settings-dialog-overlay');
    if (dialog) {
        dialog.classList.remove('visible');
        setTimeout(() => { if (dialog) dialog.style.display = 'none'; }, 300);
    }
    if (confirmSettingsResolve) {
        confirmSettingsResolve(confirmedResult);
    }
    confirmSettingsResolve = null;
}
// --- END OF NEW CODE ---