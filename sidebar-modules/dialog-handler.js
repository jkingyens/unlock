// ext/sidebar-modules/dialog-handler.js
// Manages the logic for all modal dialogs in the sidebar (Import, Share, Confirm, etc.).

import { domRefs } from './dom-references.js';
import { logger } from '../utils.js';

// --- Module-specific State & Dependencies ---
let confirmDialogResolve = null;
let closeGroupConfirmListener = null;
let closeGroupCancelListener = null;
let closeGroupOverlayClickListener = null;
let titlePromptResolve = null;
let titlePromptConfirmListener = null;
let titlePromptCancelListener = null;
let titlePromptKeyListener = null;

let sendMessageToBackground;
let showRootViewStatus;
// --- START OF THE FIX ---
let navigateTo;
// --- END OF THE FIX ---


// --- Initialization ---
export function init(dependencies) {
    sendMessageToBackground = dependencies.sendMessageToBackground;
    showRootViewStatus = dependencies.showRootViewStatus;
    // --- START OF THE FIX ---
    navigateTo = dependencies.navigateTo;
    // --- END OF THE FIX ---
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
    if (!dialog || !domRefs.shareDialogUrlInput || !domRefs.copyShareLinkBtn) return;
    domRefs.shareDialogUrlInput.value = url;
    domRefs.copyShareLinkBtn.textContent = 'Copy Link';
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
        setTimeout(() => { if (dialog) dialog.style.display = 'none'; }, 300);
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
    const { topic } = data;
    if (!domRefs.closeGroupDialog) return;
    
    removeCloseGroupDialogListeners();
    domRefs.closeGroupDialogMessage.textContent = `Packet '${topic || 'this packet'}' complete!`;
    
    closeGroupConfirmListener = () => handleConfirmCloseGroup(data.tabGroupId);
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

function handleConfirmCloseGroup(tabGroupId) {
    hideCloseGroupDialog();

    // --- START OF THE FIX ---
    // 1. Immediately reset the sidebar's internal state. This is the most
    //    critical step to prevent race conditions. The sidebar no longer
    //    "knows" about the packet it was just viewing.
    if (typeof navigateTo === 'function') {
        // This is a stand-in for the actual reset function which should be
        // called from the main sidebar module.
        // For now, we navigate, which implicitly handles part of the reset.
        navigateTo('root'); 
    }
    
    // 2. Stop any active media playback.
    sendMessageToBackground({
        action: 'request_playback_action',
        data: { intent: 'stop' }
    });

    // 3. Now, safely send the command to the background to close the tabs.
    //    Any context updates that arrive will be correctly handled because
    //    the sidebar's state has already been cleared.
    sendMessageToBackground({ action: 'remove_tab_groups', data: { groupIds: [tabGroupId] } })
        .catch(err => logger.error("DialogHandler", `Error sending close group message: ${err.message}`));
    // --- END OF THE FIX ---
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

export function showTitlePromptDialog(defaultValuePromise) {
    return new Promise((resolve) => {
        titlePromptResolve = resolve;
        const dialog = domRefs.titlePromptDialog;
        const statusEl = document.getElementById('title-prompt-status');
        if (!dialog || !statusEl) {
            logger.error("DialogHandler", "Title prompt dialog elements not found!");
            return resolve(null);
        }

        // Initially disable save and show generating message
        domRefs.titlePromptInput.value = '';
        domRefs.confirmTitlePromptBtn.disabled = true;
        showDialogStatus(statusEl, 'Generating suggested title...', 'info', false);
        
        defaultValuePromise.then(defaultValue => {
            domRefs.titlePromptInput.value = defaultValue;
            domRefs.confirmTitlePromptBtn.disabled = false;
            clearDialogStatus(statusEl);
        }).catch(() => {
            domRefs.confirmTitlePromptBtn.disabled = false;
            clearDialogStatus(statusEl);
        });
        
        titlePromptConfirmListener = () => hideTitlePromptDialog(domRefs.titlePromptInput.value.trim());
        titlePromptCancelListener = () => hideTitlePromptDialog(null);
        titlePromptKeyListener = (e) => {
            if (e.key === 'Enter' && !domRefs.confirmTitlePromptBtn.disabled) {
                e.preventDefault();
                hideTitlePromptDialog(domRefs.titlePromptInput.value.trim());
            }
        };

        domRefs.confirmTitlePromptBtn.addEventListener('click', titlePromptConfirmListener);
        domRefs.cancelTitlePromptBtn.addEventListener('click', titlePromptCancelListener);
        domRefs.titlePromptInput.addEventListener('keypress', titlePromptKeyListener);

        dialog.style.display = 'flex';
        
        requestAnimationFrame(() => {
            dialog.classList.add('visible');
            requestAnimationFrame(() => {
                domRefs.titlePromptInput.focus();
                domRefs.titlePromptInput.select();
            });
        });
    });
}

function hideTitlePromptDialog(valueToResolve) {
    const dialog = domRefs.titlePromptDialog;
    if (dialog) {
        dialog.classList.remove('visible');
        setTimeout(() => { if (dialog) dialog.style.display = 'none'; }, 300);
    }

    // Clean up listeners to prevent memory leaks
    if (titlePromptConfirmListener) domRefs.confirmTitlePromptBtn?.removeEventListener('click', titlePromptConfirmListener);
    if (titlePromptCancelListener) domRefs.cancelTitlePromptBtn?.removeEventListener('click', titlePromptCancelListener);
    if (titlePromptKeyListener) domRefs.titlePromptInput?.removeEventListener('keypress', titlePromptKeyListener);
    
    titlePromptConfirmListener = null;
    titlePromptCancelListener = null;
    titlePromptKeyListener = null;

    if (titlePromptResolve) {
        titlePromptResolve(valueToResolve);
        titlePromptResolve = null;
    }
}

// --- NEW DIALOG: Create Source ---
let createSourceDialogResolve = null;

export function showCreateSourceDialog() {
    return new Promise((resolve) => {
        createSourceDialogResolve = resolve;
        const dialog = document.getElementById('create-source-dialog');
        if (dialog) {
            // --- START OF THE FIX ---
            // Reset the dialog to its initial state before showing it.
            const buttonDiv = document.getElementById('create-source-dialog-buttons');
            const progressDiv = document.getElementById('create-source-dialog-progress');
            if (buttonDiv) buttonDiv.classList.remove('hidden');
            if (progressDiv) progressDiv.classList.add('hidden');
            // --- END OF THE FIX ---

            dialog.querySelector('#create-from-blank-btn').onclick = () => {
                if (createSourceDialogResolve) createSourceDialogResolve('blank');
            };
            dialog.querySelector('#create-from-tab-btn').onclick = () => {
                if (createSourceDialogResolve) createSourceDialogResolve('tab');
            };

            // Cancel and overlay clicks still hide the dialog immediately.
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
        // --- START OF THE FIX ---
        // Explicitly clear the onclick handlers to prevent stale closures.
        dialog.querySelector('#create-from-blank-btn').onclick = null;
        dialog.querySelector('#create-from-tab-btn').onclick = null;
        dialog.querySelector('#cancel-create-source-btn').onclick = null;
        dialog.onclick = null;
        // --- END OF THE FIX ---

        dialog.classList.remove('visible');
        setTimeout(() => { if (dialog) dialog.style.display = 'none'; }, 300);
    }

    if (reason === 'cancel' && createSourceDialogResolve) {
        createSourceDialogResolve(null);
    }
    createSourceDialogResolve = null;
}