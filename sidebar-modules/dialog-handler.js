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
let showRootViewStatus; // Add this

// --- Initialization ---
export function init(dependencies) {
    sendMessageToBackground = dependencies.sendMessageToBackground;
    showRootViewStatus = dependencies.showRootViewStatus; // Store this dependency
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
    sendMessageToBackground({ action: 'remove_tab_groups', data: { groupIds: [tabGroupId] } })
        .catch(err => logger.error("DialogHandler", `Error sending close group message: ${err.message}`));
    hideCloseGroupDialog();
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

export function showTitlePromptDialog() {
    return new Promise((resolve) => {
        titlePromptResolve = resolve;
        const dialog = domRefs.titlePromptDialog;
        if (!dialog) {
            logger.error("DialogHandler", "Title prompt dialog element not found!");
            return resolve(null); // Resolve with null if dialog doesn't exist
        }

        // Clear previous input and add listeners
        domRefs.titlePromptInput.value = '';
        
        titlePromptConfirmListener = () => hideTitlePromptDialog(domRefs.titlePromptInput.value.trim());
        titlePromptCancelListener = () => hideTitlePromptDialog(null);
        titlePromptKeyListener = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                hideTitlePromptDialog(domRefs.titlePromptInput.value.trim());
            }
        };

        domRefs.confirmTitlePromptBtn.addEventListener('click', titlePromptConfirmListener);
        domRefs.cancelTitlePromptBtn.addEventListener('click', titlePromptCancelListener);
        domRefs.titlePromptInput.addEventListener('keypress', titlePromptKeyListener);

        // Show dialog
        dialog.style.display = 'flex';
        
        // Use requestAnimationFrame to ensure focus happens after the dialog is visible and ready.
        requestAnimationFrame(() => {
            dialog.classList.add('visible');
            // A second requestAnimationFrame can sometimes help ensure the focus call
            // happens *after* the CSS transition has started.
            requestAnimationFrame(() => {
                domRefs.titlePromptInput.focus();
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