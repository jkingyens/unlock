// ext/sidebar-modules/create-view.js
// Manages the "Create New Packet" view, allowing users to build a packet
// by adding the current page or generating new pages from prompts.

import { domRefs } from './dom-references.js';
import { logger, storage, base64Decode, shouldUseTabGroups } from '../utils.js';
import { showConfirmDialog, showTitlePromptDialog } from './dialog-handler.js';

// --- Module-specific State & Dependencies ---
let draftPacket = null;
let isEditing = false; // Flag to know if we are in edit mode
let draggedItemIndex = null; // To track the item being dragged
let initialDraftState = null; // To track if changes have been made
let draftTabGroupId = null; // To hold the ID of the builder's tab group
let isTabGroupSyncing = false; // To prevent concurrent sync operations

// Functions to be imported from the new, lean sidebar.js
let navigateTo;
let showRootViewStatus;
let sendMessageToBackground;
let showConfetti;

// --- Initialization ---

/**
 * Injects dependencies from the main sidebar module.
 * @param {object} dependencies - The dependencies to inject.
 */
export function init(dependencies) {
    navigateTo = dependencies.navigateTo;
    showRootViewStatus = dependencies.showRootViewStatus;
    sendMessageToBackground = dependencies.sendMessageToBackground;
    showConfetti = dependencies.showConfetti;
}

/**
 * Attaches event listeners specific to the create view.
 */
export function setupCreateViewListeners() {
    domRefs.createViewDiscardBtn?.addEventListener('click', handleDiscardDraftPacket);
    domRefs.createViewSaveBtn?.addEventListener('click', handleSaveDraftPacket);
    
    // Listeners for the "Generate New Page" dialog
    domRefs.cancelMakePageBtn?.addEventListener('click', hideMakePageDialog);
    domRefs.confirmMakePageBtn?.addEventListener('click', handleConfirmMakePage);
    domRefs.makePageDialog?.addEventListener('click', (e) => {
        if (e.target === domRefs.makePageDialog) {
            hideMakePageDialog();
        }
    });

    const listEl = domRefs.createViewContentList;
    if (listEl) {
        listEl.addEventListener('dragstart', handleDragStart);
        listEl.addEventListener('dragover', handleDragOver);
        listEl.addEventListener('dragleave', handleDragLeave);
        listEl.addEventListener('drop', handleDrop);
        listEl.addEventListener('dragend', handleDragEnd);
    }
    
    // Add a listener to serve content to the preview page
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'get_draft_item_for_preview' && sender.tab) {
            const pageId = message.data.pageId;
            const item = draftPacket?.sourceContent?.find(i => i.pageId === pageId);
            if (item?.type === 'generated' && item.contentB64) {
                const htmlContent = base64Decode(item.contentB64);
                // Send the HTML content and title back to the specific preview tab
                chrome.tabs.sendMessage(sender.tab.id, {
                    action: 'draft_item_content_response',
                    data: { 
                        pageId: pageId, 
                        htmlContent,
                        title: item.title || 'Preview'
                    }
                });
            }
        }
    });
}

/**
 * Prepares the create view for display by resetting or loading a draft.
 * @param {object | null} imageToEdit - The PacketImage to load for editing.
 */
export async function prepareCreateView(imageToEdit = null) {
    if (imageToEdit) {
        isEditing = true;
        draftPacket = JSON.parse(JSON.stringify(imageToEdit));
        domRefs.createViewSaveBtn.textContent = 'Save Changes';
    } else {
        isEditing = false;
        draftPacket = { topic: '', sourceContent: [] };
        domRefs.createViewSaveBtn.textContent = 'Save';
    }
    initialDraftState = JSON.stringify(draftPacket.sourceContent);
    renderDraftContentList();
    syncDraftGroup();
}


// --- Helper for URL generation ---
function getUrlForItem(item, index) {
    if (item.type === 'external') {
        return item.url;
    }
    if (item.type === 'generated' && item.pageId) {
        return chrome.runtime.getURL(`preview.html?pageId=${item.pageId}`);
    }
    return null;
}

// --- Tab Group Management for Drafts ---

async function syncDraftGroup() {
    if (!(await shouldUseTabGroups()) || isTabGroupSyncing) {
        return;
    }
    isTabGroupSyncing = true;
    try {
        const desiredUrls = draftPacket.sourceContent
            .map((item, index) => getUrlForItem(item, index))
            .filter(Boolean);

        const response = await sendMessageToBackground({
            action: 'sync_draft_group',
            data: { desiredUrls }
        });
        if (response.success) {
            draftTabGroupId = response.groupId;
        }
    } catch (error) {
        logger.error('CreateView', 'Error syncing draft group', error);
    } finally {
        isTabGroupSyncing = false;
    }
}

async function cleanupDraftGroup() {
    if (draftTabGroupId !== null && (await shouldUseTabGroups())) {
        await sendMessageToBackground({ action: 'cleanup_draft_group' });
        draftTabGroupId = null;
    }
}

// --- UI Rendering ---

function renderDraftContentList() {
    const listEl = domRefs.createViewContentList;
    if (!listEl) return;
    listEl.innerHTML = '';

    const listFragment = document.createDocumentFragment();

    if (draftPacket?.sourceContent?.length > 0) {
        draftPacket.sourceContent.forEach((item, index) => {
            const card = createDraftContentCard(item, index);
            if (card) {
                const removeBtn = document.createElement('button');
                removeBtn.className = 'delete-draft-item-btn';
                removeBtn.innerHTML = '&times;';
                removeBtn.title = 'Remove item';
                removeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    draftPacket.sourceContent.splice(index, 1);
                    renderDraftContentList();
                    syncDraftGroup();
                });
                card.appendChild(removeBtn);
                listFragment.appendChild(card);
            }
        });
    }

    const placeholder = document.createElement('div');
    placeholder.className = 'placeholder-card';
    const addPageBtn = document.createElement('button');
    addPageBtn.className = 'sidebar-action-button';
    addPageBtn.textContent = 'Add Current Tab';
    addPageBtn.addEventListener('click', handleAddCurrentPageToDraft);
    const makePageBtn = document.createElement('button');
    makePageBtn.className = 'sidebar-action-button';
    makePageBtn.textContent = 'Create New Page';
    makePageBtn.addEventListener('click', showMakePageDialog);
    storage.getActiveModelConfig().then(activeModelConfig => {
        const llmReady = activeModelConfig && (activeModelConfig.providerType === 'chrome-ai-gemini-nano' || activeModelConfig.apiKey);
        makePageBtn.disabled = !llmReady;
        makePageBtn.title = llmReady ? "Generate a new page from a prompt" : "An active LLM must be configured in Settings.";
    });
    placeholder.innerHTML = `<p>Add a new page to your packet:</p>`;
    const placeholderActions = document.createElement('div');
    placeholderActions.className = 'placeholder-card-actions';
    placeholderActions.append(addPageBtn, makePageBtn);
    placeholder.appendChild(placeholderActions);
    listFragment.appendChild(placeholder);
    listEl.appendChild(listFragment);
}

function createDraftContentCard(contentItem, index) {
    const card = document.createElement('div');
    card.className = 'card clickable';
    card.setAttribute('draggable', 'true');
    card.dataset.index = index;

    const { title = 'Untitled', type } = contentItem;
    let iconHTML = '?';
    let displayUrl = '';
    const itemUrl = getUrlForItem(contentItem, index);

    if (type === 'external') {
        iconHTML = '🔗';
        try {
            displayUrl = new URL(itemUrl).hostname.replace(/^www\./, '');
        } catch (e) {
            displayUrl = itemUrl ? itemUrl.substring(0, 40) + '...' : 'Invalid URL';
        }
    } else if (type === 'generated') {
        iconHTML = '📄';
        displayUrl = "Preview (Generated)";
    }

    card.title = `Click to open or focus tab: ${title}`;
    card.addEventListener('click', async (e) => {
        if (e.target.classList.contains('delete-draft-item-btn') || e.target.classList.contains('drag-handle')) return;
        if (itemUrl) {
            if (await shouldUseTabGroups()) {
                sendMessageToBackground({ action: 'focus_or_create_draft_tab', data: { url: itemUrl } });
            } else {
                chrome.tabs.create({ url: itemUrl });
            }
        }
    });

    card.innerHTML = `
        <div class="drag-handle" title="Drag to reorder">⠿</div>
        <div class="card-icon">${iconHTML}</div>
        <div class="card-text">
            <div class="card-title">${title}</div>
            <div class="card-url">${displayUrl}</div>
        </div>`;
    return card;
}

/**
 * Checks if the current draft has been modified.
 * @returns {boolean}
 */
function isDraftDirty() {
    if (!draftPacket) return false;
    const currentDraftState = JSON.stringify(draftPacket.sourceContent);
    return currentDraftState !== initialDraftState;
}

// --- Action Handlers ---

export async function handleDiscardDraftPacket() {
    if (isDraftDirty()) {
        const confirmed = await showConfirmDialog(
            'You have unsaved changes. Are you sure you want to discard them?',
            'Discard Changes',
            'Cancel',
            true
        );
        if (!confirmed) return;
    }
    await cleanupDraftGroup();
    draftPacket = null;
    isEditing = false;
    initialDraftState = null;
    navigateTo('root');
}

async function handleSaveDraftPacket() {
    if (!draftPacket || !draftPacket.sourceContent || !draftPacket.sourceContent.length === 0) {
        showRootViewStatus("Please add at least one page to the packet.", "error");
        return;
    }
    
    await cleanupDraftGroup();

    let packetToSave = { ...draftPacket };

    if (!isEditing) {
        const topic = await showTitlePromptDialog();
        if (!topic) return;
        packetToSave.topic = topic;
        packetToSave.id = `img_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        packetToSave.created = new Date().toISOString();
    }

    try {
        const response = await sendMessageToBackground({
            action: 'save_packet_image',
            data: { image: packetToSave }
        });
        if (response && response.success) {
            showRootViewStatus(`Packet "${packetToSave.topic}" saved.`, 'success');
            draftPacket = null;
            isEditing = false;
            initialDraftState = null;
            navigateTo('root');
        } else {
            throw new Error(response?.error || "Failed to save the packet.");
        }
    } catch (error) {
        logger.error("CreateView", "Error saving packet", error);
        showRootViewStatus(`Error saving: ${error.message}`, 'error');
    }
}

async function handleAddCurrentPageToDraft() {
    const btn = document.getElementById('create-view-add-page-btn');
    if (btn) btn.disabled = true;
    showRootViewStatus('Fetching page details...', 'info', false);

    try {
        const tabInfo = await sendMessageToBackground({ action: 'get_current_tab_context' });
        if (!tabInfo?.success || !tabInfo.currentUrl) {
            throw new Error("Could not get current tab info.");
        }
        
        const { currentUrl, title } = tabInfo;
        if (currentUrl.startsWith('chrome://') || currentUrl.startsWith('chrome-extension://')) {
            throw new Error("Cannot add special browser pages to a packet.");
        }
        if (draftPacket.sourceContent.some(item => item.url === currentUrl)) {
            if (await shouldUseTabGroups()) {
                sendMessageToBackground({ action: 'focus_or_create_draft_tab', data: { url: currentUrl } });
            }
            throw new Error("This page is already in the draft.");
        }
        
        draftPacket.sourceContent.push({
            type: 'external',
            url: currentUrl,
            title: title,
            relevance: ''
        });
        
        renderDraftContentList();
        await syncDraftGroup();
        showRootViewStatus('Page added to draft.', 'success');

    } catch (error) {
        showRootViewStatus(`${error.message}`, "error");
    } finally {
        if (btn) btn.disabled = false;
    }
}

// --- "Generate New Page" Dialog Logic ---

function showMakePageDialog() {
    const dialog = domRefs.makePageDialog;
    if (dialog) {
        domRefs.makePagePromptInput.value = '';
        dialog.style.display = 'flex';
        setTimeout(() => dialog.classList.add('visible'), 10);
        domRefs.makePagePromptInput.focus();
    }
}

function hideMakePageDialog() {
    const dialog = domRefs.makePageDialog;
    if (dialog) {
        dialog.classList.remove('visible');
        setTimeout(() => { if (dialog) dialog.style.display = 'none'; }, 300);
    }
}

async function handleConfirmMakePage() {
    const prompt = domRefs.makePagePromptInput?.value?.trim();
    if (!prompt) return;

    const btn = domRefs.confirmMakePageBtn;
    const progressContainer = domRefs.makePageProgressContainer;
    const originalText = btn.textContent;

    btn.disabled = true;
    btn.textContent = 'Creating...';
    progressContainer.classList.remove('hidden');

    try {
        const response = await sendMessageToBackground({
            action: 'generate_custom_page',
            data: {
                prompt: prompt,
                topic: draftPacket?.topic || 'Custom Packet',
                context: draftPacket?.sourceContent || []
            }
        });

        if (response?.success && response.newItem) {
            const newContentItem = response.newItem;
            draftPacket.sourceContent.push(newContentItem);
            renderDraftContentList();
            hideMakePageDialog();
            
            await syncDraftGroup();
            const previewUrl = getUrlForItem(newContentItem, draftPacket.sourceContent.length - 1);
            if (previewUrl && (await shouldUseTabGroups())) {
                await sendMessageToBackground({ action: 'focus_or_create_draft_tab', data: { url: previewUrl } });
            }
        } else {
            throw new Error(response.error || 'Failed to generate page.');
        }
    } catch (error) {
        logger.error("CreateView", "handleConfirmMakePage failed", error);
        showRootViewStatus(error.message, "error");
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
        progressContainer.classList.add('hidden');
    }
}

// --- Drag and Drop Handlers ---

function handleDragStart(e) {
    const targetCard = e.target.closest('.card[draggable="true"]');
    if (targetCard) {
        draggedItemIndex = parseInt(targetCard.dataset.index, 10);
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => {
            targetCard.classList.add('dragging');
        }, 0);
    }
}

function handleDragOver(e) {
    e.preventDefault();
    const targetCard = e.target.closest('.card[draggable="true"]');
    if (targetCard && !targetCard.classList.contains('dragging')) {
        document.querySelectorAll('.drag-over-indicator').forEach(el => el.classList.remove('drag-over-indicator'));
        targetCard.classList.add('drag-over-indicator');
    }
}

function handleDragLeave(e) {
    const targetCard = e.target.closest('.card[draggable="true"]');
    if (targetCard) {
        targetCard.classList.remove('drag-over-indicator');
    }
}

async function handleDrop(e) {
    e.preventDefault();
    const dropTargetCard = e.target.closest('.card[draggable="true"]');
    
    if (dropTargetCard && draggedItemIndex !== null) {
        const droppedOnIndex = parseInt(dropTargetCard.dataset.index, 10);

        if (draggedItemIndex !== droppedOnIndex) {
            const [draggedItem] = draftPacket.sourceContent.splice(draggedItemIndex, 1);
            draftPacket.sourceContent.splice(droppedOnIndex, 0, draggedItem);
            renderDraftContentList();
            await syncDraftGroup();
        }
    }
    dropTargetCard?.classList.remove('drag-over-indicator');
}

function handleDragEnd(e) {
    document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
    draggedItemIndex = null;
}