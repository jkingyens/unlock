// ext/sidebar-modules/create-view.js
// Manages the "Create New Packet" view, allowing users to build a packet
// by adding the current page or generating new pages from prompts.

import { domRefs } from './dom-references.js';
import { logger, storage, base64Decode, shouldUseTabGroups, indexedDbStorage } from '../utils.js';
import { showConfirmDialog, showTitlePromptDialog } from './dialog-handler.js';

// --- Module-specific State & Dependencies ---
let draftPacket = null;
let isEditing = false; // Flag to know if we are in edit mode
let draggedItemIndex = null; // To track the item being dragged
let initialDraftState = null; // To track if changes have been made
let draftTabGroupId = null; // To hold the ID of the builder's tab group
let isTabGroupSyncing = false; // To prevent concurrent sync operations
let draftActiveAudio = null; // To manage playback for the draft view

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
 * Triggers an immediate save if one is scheduled.
 */
export function triggerPendingSave() {
    if (settingsSaveTimeout) {
        clearTimeout(settingsSaveTimeout);
        settingsSaveTimeout = null;
        gatherAndSaveSettings();
        logger.log('SettingsView', 'Pending settings save triggered immediately by navigation.');
    }
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
    
    const dropZone = document.getElementById('drop-zone');
    if (dropZone) {
        dropZone.addEventListener('dragenter', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
        dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); });
        dropZone.addEventListener('drop', handleFileDrop);
    }
    
    domRefs.addCurrentTabBtn?.addEventListener('click', handleAddCurrentPageToDraft);
    domRefs.createNewPageBtn?.addEventListener('click', showMakePageDialog);
}

/**
 * Prepares the create view for display by resetting or loading a draft.
 * @param {object | null} imageToEdit - The PacketImage to load for editing.
 */
export async function prepareCreateView(imageToEdit = null) {
    if (draftActiveAudio) {
        draftActiveAudio.pause();
        draftActiveAudio = null;
    }

    if (imageToEdit) {
        isEditing = true;
        draftPacket = JSON.parse(JSON.stringify(imageToEdit));
        domRefs.createViewSaveBtn.textContent = 'Save Changes';
    } else {
        isEditing = false;
        // FIX: Assign a temporary ID to new drafts so media can be saved to IndexedDB immediately.
        const draftId = `draft_${Date.now()}`;
        draftPacket = { id: draftId, topic: '', sourceContent: [] };
        domRefs.createViewSaveBtn.textContent = 'Save';
    }
    
    await storage.setSession({ 'draftPacketForPreview': draftPacket });
    
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
            .flatMap(item => {
                if (item.type === 'alternative') {
                    return item.alternatives.map(alt => getUrlForItem(alt));
                }
                return getUrlForItem(item);
            })
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
    await storage.removeSession('draftPacketForPreview');
    // Also clean up any temporary draft media from IndexedDB
    if (draftPacket && draftPacket.id.startsWith('draft_')) {
        await indexedDbStorage.deleteGeneratedContentForImage(draftPacket.id);
    }
}

// --- UI Rendering ---

function renderDraftContentList() {
    const listEl = domRefs.createViewContentList;
    if (!listEl) return;

    listEl.querySelectorAll('.card, .alternative-group-card').forEach(card => card.remove());

    const listFragment = document.createDocumentFragment();

    if (draftPacket?.sourceContent?.length > 0) {
        draftPacket.sourceContent.forEach((item, index) => {
            let card;
            if (item.type === 'alternative') {
                card = createAlternativeGroupCard(item, index);
            } else {
                card = createDraftContentCard(item, index);
                const removeBtn = document.createElement('button');
                removeBtn.className = 'delete-draft-item-btn';
                removeBtn.innerHTML = '&times;';
                removeBtn.title = 'Remove item';
                removeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    draftPacket.sourceContent.splice(index, 1);
                    renderDraftContentList();
                    storage.setSession({ 'draftPacketForPreview': draftPacket });
                    syncDraftGroup();
                });
                card.appendChild(removeBtn);
            }
            
            if (card) {
                listFragment.appendChild(card);
            }
        });
    }

    listEl.prepend(listFragment);
}

function createAlternativeGroupCard(groupItem, groupIndex) {
    const groupCard = document.createElement('div');
    groupCard.className = 'alternative-group-card';
    groupCard.dataset.index = groupIndex;

    const mediaItem = groupItem.alternatives.find(alt => alt.type === 'media');
    const htmlItem = groupItem.alternatives.find(alt => alt.type === 'generated');

    if (htmlItem) {
        const innerCard = createDraftContentCard(htmlItem, -1);
        groupCard.appendChild(innerCard);
    }
    if (mediaItem) {
        const innerCard = createDraftContentCard(mediaItem, -1);
        groupCard.appendChild(innerCard);
    }

    if (mediaItem && htmlItem) {
        const hasTimestamps = mediaItem.timestamps && mediaItem.timestamps.length > 0;
        const timestampButton = document.createElement('button');
        timestampButton.textContent = hasTimestamps ? 'Recalculate Timestamps' : 'Add Timestamps';
        timestampButton.className = 'sidebar-action-button';
        timestampButton.style.marginTop = '8px';
        timestampButton.addEventListener('click', (e) => {
            e.stopPropagation();
            handleGenerateTimestamps(groupItem, timestampButton);
        });
        groupCard.appendChild(timestampButton);

        if (hasTimestamps) {
            const timestampInfo = document.createElement('p');
            timestampInfo.textContent = `Timestamps exist for ${mediaItem.timestamps.length} links.`;
            timestampInfo.style.fontSize = '0.85em';
            timestampInfo.style.color = 'var(--status-success-color)';
            timestampInfo.style.margin = '4px 0 0';
            groupCard.appendChild(timestampInfo);
        }
    }

    // --- NEW: Add "Auto-improve Audio" button ---
    if (mediaItem) {
        const improveAudioButton = document.createElement('button');
        improveAudioButton.textContent = 'Auto-improve Audio';
        improveAudioButton.className = 'sidebar-action-button';
        improveAudioButton.style.marginTop = '8px';
        improveAudioButton.addEventListener('click', (e) => {
            e.stopPropagation();
            handleImproveAudio(mediaItem, improveAudioButton);
        });
        groupCard.appendChild(improveAudioButton);
    }
    // --- END NEW SECTION ---

    return groupCard;
}


function createDraftContentCard(contentItem, index) {
    const card = document.createElement('div');
    card.className = 'card clickable';
    if (index !== -1) {
        card.setAttribute('draggable', 'true');
        card.dataset.index = index;
    }
    
    const { title = 'Untitled', type } = contentItem;
    let iconHTML = '?';
    let displayUrl = '';
    const itemUrl = getUrlForItem(contentItem, index);

    if (type === 'external') { iconHTML = '🔗'; try { displayUrl = new URL(itemUrl).hostname.replace(/^www\./, ''); } catch (e) { displayUrl = itemUrl ? itemUrl.substring(0, 40) + '...' : 'Invalid URL'; }
    } else if (type === 'generated') { iconHTML = '📄'; displayUrl = "Preview (Generated)";
    } else if (type === 'media') { 
        iconHTML = '▶️';
        displayUrl = "Audio Preview";
        card.classList.add('media');
        card.dataset.pageId = contentItem.pageId;
    }

    card.title = `Click to open or focus tab: ${title}`;
    card.addEventListener('click', async (e) => {
        if (e.target.classList.contains('delete-draft-item-btn') || e.target.classList.contains('drag-handle')) return;
        
        if (contentItem.type === 'media') {
            toggleDraftAudioPlayback(contentItem, card);
        } else if (itemUrl) {
            if (await shouldUseTabGroups()) {
                sendMessageToBackground({ action: 'focus_or_create_draft_tab', data: { url: itemUrl } });
            } else {
                chrome.tabs.create({ url: itemUrl });
            }
        }
    });

    card.innerHTML = `
        <div class="drag-handle" title="Drag to reorder">☰</div>
        <div class="card-icon">${iconHTML}</div>
        <div class="card-text">
            <div class="card-title">${title}</div>
            <div class="card-url">${displayUrl}</div>
        </div>`;
    return card;
}

function isDraftDirty() {
    if (!draftPacket) return false;
    const currentDraftState = JSON.stringify(draftPacket.sourceContent);
    return currentDraftState !== initialDraftState;
}

// --- Audio Playback Handler ---

async function toggleDraftAudioPlayback(item, card) {
    const iconElement = card.querySelector('.card-icon');

    if (draftActiveAudio && draftActiveAudio.dataset.pageId === item.pageId && !draftActiveAudio.paused) {
        draftActiveAudio.pause();
        return;
    }

    if (draftActiveAudio) {
        draftActiveAudio.pause();
        const oldCard = document.querySelector(`.card.media[data-page-id="${draftActiveAudio.dataset.pageId}"]`);
        if (oldCard) {
            oldCard.querySelector('.card-icon').textContent = '▶️';
        }
    }

    try {
        const audioContent = await indexedDbStorage.getGeneratedContent(draftPacket.id, item.pageId);
        if (!audioContent || audioContent.length === 0) {
            throw new Error(`Audio content not found in IndexedDB for pageId: ${item.pageId}`);
        }
        
        const audioData = audioContent[0].content; // This is an ArrayBuffer
        const blob = new Blob([audioData], { type: item.mimeType });
        const audioUrl = URL.createObjectURL(blob);

        const audio = new Audio(audioUrl);
        audio.dataset.pageId = item.pageId;
        
        audio.onplay = () => { if (iconElement) iconElement.textContent = '⏸️'; };
        audio.onpause = () => { if (iconElement) iconElement.textContent = '▶️'; };
        audio.onended = () => { if (iconElement) iconElement.textContent = '▶️'; draftActiveAudio = null; };

        audio.play();
        draftActiveAudio = audio;

    } catch (error) {
        logger.error("CreateView:toggleDraftAudio", "Failed to load and play audio from IndexedDB", error);
        showRootViewStatus("Could not play audio preview.", "error");
    }
}

// --- Action Handlers ---

// --- NEW: Handler for the "Auto-improve Audio" button ---
async function handleImproveAudio(mediaItem, button) {
    button.disabled = true;
    button.textContent = 'Improving...';

    try {
        const response = await sendMessageToBackground({
            action: 'improve_draft_audio',
            data: {
                draftId: draftPacket.id,
                mediaPageId: mediaItem.pageId
            }
        });

        if (response.success) {
            showRootViewStatus("Audio improved successfully!", "success");
        } else {
            throw new Error(response.error || "Failed to improve audio.");
        }
    } catch (error) {
        showRootViewStatus(`Error: ${error.message}`, "error");
    } finally {
        button.disabled = false;
        button.textContent = 'Auto-improve Audio';
    }
}

async function handleGenerateTimestamps(groupItem, button) {
    const mediaItem = groupItem.alternatives.find(alt => alt.type === 'media');
    const htmlItem = groupItem.alternatives.find(alt => alt.type === 'generated');

    if (!mediaItem || !htmlItem) {
        showRootViewStatus("Error: Missing audio or summary content.", "error");
        return;
    }

    button.disabled = true;
    button.textContent = 'Generating...';

    try {
        const response = await sendMessageToBackground({
            action: 'generate_timestamps_for_packet_items',
            data: {
                draftId: draftPacket.id,
                htmlPageId: htmlItem.pageId,
                mediaPageId: mediaItem.pageId,
                htmlContentB64: htmlItem.contentB64,
                originalTitle: mediaItem.title // <-- ADD THIS LINE
            }
        });

        if (response.success && response.updatedMediaItem) {
            // Find the original media item in the draftPacket and update it
            const groupIndex = draftPacket.sourceContent.findIndex(item => item === groupItem);
            if (groupIndex !== -1) {
                const mediaIndex = draftPacket.sourceContent[groupIndex].alternatives.findIndex(alt => alt.pageId === mediaItem.pageId);
                if (mediaIndex !== -1) {
                    draftPacket.sourceContent[groupIndex].alternatives[mediaIndex] = response.updatedMediaItem;
                    await storage.setSession({ 'draftPacketForPreview': draftPacket });
                    renderDraftContentList(); // Re-render to show the updated state
                    showRootViewStatus("Timestamps added successfully!", "success");
                }
            }
        } else {
            throw new Error(response.error || "Failed to generate timestamps.");
        }
    } catch (error) {
        showRootViewStatus(`Error: ${error.message}`, "error");
        button.disabled = false;
        button.textContent = 'Add Timestamps';
    }
}


export async function handleDiscardDraftPacket() {
    if (isDraftDirty()) {
        const confirmed = await showConfirmDialog( 'You have unsaved changes. Are you sure you want to discard them?', 'Discard Changes', 'Cancel', true );
        if (!confirmed) return;
    }
    if (draftActiveAudio) draftActiveAudio.pause();
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
    
    if (draftActiveAudio) draftActiveAudio.pause();
    
    let packetToSave = { ...draftPacket };

    if (packetToSave.id.startsWith('draft_')) {
        const originalDraftId = packetToSave.id;
        
        // --- START OF THE FIX ---
        // 1. Prompt for the title FIRST, before making any permanent changes.
        const topic = await showTitlePromptDialog(packetToSave.topic || '');

        if (!topic) {
            // If the user cancels, do nothing. The draft remains untouched and valid.
            showRootViewStatus("Save cancelled.", "info");
            return; 
        }

        // 2. Only after confirming the title, generate the new ID and update the packet.
        packetToSave.topic = topic;
        packetToSave.id = `img_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        packetToSave.created = new Date().toISOString();
        
        // 3. Now, perform the database transfer with the original and new IDs.
        await indexedDbStorage.transferDraftContent(originalDraftId, packetToSave.id);
        // --- END OF THE FIX ---
    }
    
    // Cleanup and final save operation remain the same.
    await cleanupDraftGroup();

    try {
        const response = await sendMessageToBackground({ action: 'save_packet_image', data: { image: packetToSave } });
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
    const btn = document.getElementById('add-current-tab-btn');
    if (btn) btn.disabled = true;
    showRootViewStatus('Fetching page details...', 'info', false);

    try {
        const tabInfo = await sendMessageToBackground({ action: 'get_current_tab_context' });
        if (!tabInfo?.success || !tabInfo.currentUrl) { throw new Error("Could not get current tab info."); }
        
        const { currentUrl, title } = tabInfo;
        if (currentUrl.startsWith('chrome://') || currentUrl.startsWith('chrome-extension://')) { throw new Error("Cannot add special browser pages to a packet."); }
        if (draftPacket.sourceContent.some(item => item.url === currentUrl)) {
            if (await shouldUseTabGroups()) { sendMessageToBackground({ action: 'focus_or_create_draft_tab', data: { url: currentUrl } }); }
            throw new Error("This page is already in the draft.");
        }
        
        draftPacket.sourceContent.push({ type: 'external', url: currentUrl, title: title, relevance: '' });
        
        renderDraftContentList();
        await storage.setSession({ 'draftPacketForPreview': draftPacket });
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
            data: { prompt: prompt, topic: draftPacket?.topic || 'Custom Packet', context: draftPacket?.sourceContent || [] }
        });

        if (response?.success && response.newItem) {
            draftPacket.sourceContent.push(response.newItem);
            renderDraftContentList();
            hideMakePageDialog();
            
            await storage.setSession({ 'draftPacketForPreview': draftPacket });
            await syncDraftGroup();
            
            const previewUrl = getUrlForItem(response.newItem, draftPacket.sourceContent.length - 1);
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
    const targetCard = e.target.closest('.card[draggable="true"], .alternative-group-card');
    if (targetCard) {
        draggedItemIndex = parseInt(targetCard.dataset.index, 10);
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => { targetCard.classList.add('dragging'); }, 0);
    }
}

function handleDragOver(e) {
    e.preventDefault();
    const dropZone = e.target.closest('.card[draggable="true"], .alternative-group-card');
    if (dropZone && !dropZone.classList.contains('dragging')) {
        document.querySelectorAll('.drag-over-indicator').forEach(el => el.classList.remove('drag-over-indicator'));
        dropZone.classList.add('drag-over-indicator');
    }
}

function handleDragLeave(e) {
    e.target.closest('.card, .alternative-group-card')?.classList.remove('drag-over-indicator');
}

async function handleDrop(e) {
    e.preventDefault();
    const dropTarget = e.target.closest('.card[draggable="true"], .alternative-group-card');
    
    if (dropTarget && draggedItemIndex !== null) {
        const droppedOnIndex = parseInt(dropTarget.dataset.index, 10);
        if (draggedItemIndex !== droppedOnIndex) {
            const [draggedItem] = draftPacket.sourceContent.splice(draggedItemIndex, 1);
            draftPacket.sourceContent.splice(droppedOnIndex, 0, draggedItem);
            renderDraftContentList();
            await storage.setSession({ 'draftPacketForPreview': draftPacket });
            await syncDraftGroup();
        }
    }
    dropTarget?.classList.remove('drag-over-indicator');
}

function handleDragEnd(e) {
    document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
    draggedItemIndex = null;
}

function handleFileDrop(e) {
    e.preventDefault();
    const dropZone = document.getElementById('drop-zone');
    dropZone.classList.remove('drag-over');

    if (e.dataTransfer.files) {
        for (const file of e.dataTransfer.files) {
            const reader = new FileReader();
            reader.onload = async (event) => {
                const newMediaItem = {
                    type: 'media',
                    pageId: `media_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                    title: file.name,
                    mimeType: file.type,
                };
                
                // Save the ArrayBuffer to IndexedDB immediately using the draft ID
                const audioBuffer = event.target.result;
                await indexedDbStorage.saveGeneratedContent(draftPacket.id, newMediaItem.pageId, [{
                    name: 'audio.mp3', // Generic name, doesn't really matter here
                    content: audioBuffer,
                    contentType: newMediaItem.mimeType
                }]);

                draftPacket.sourceContent.push(newMediaItem);
                renderDraftContentList();
                await storage.setSession({ 'draftPacketForPreview': draftPacket });
            };
            // Read as an ArrayBuffer to store in IndexedDB
            reader.readAsArrayBuffer(file);
        }
    }
}