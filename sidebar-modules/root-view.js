// ext/sidebar-modules/root-view.js
// Manages the root view of the sidebar, including the "Library", "Started",
// and "Completed" packet lists and their associated actions.

import { domRefs } from './dom-references.js';
import { logger, storage, packetUtils, isTabGroupsAvailable, shouldUseTabGroups } from '../utils.js';
import { showConfirmDialog, showImportDialog, exportPacketAndShowDialog, showCreateSourceDialog, showCreateSourceDialogProgress, hideCreateSourceDialog } from './dialog-handler.js';

// --- Module-specific State ---
let activeListTab = 'library';
let currentContextMenuCloseHandler = null;
let currentActionImageId = null; // To hold the ID for the dialog
let inProgressStencils = new Map(); // Stateful tracking for in-progress creations

// Functions to be imported from the new, lean sidebar.js
let navigateTo;
let showRootViewStatus;
let sendMessageToBackground;

// --- Constants ---
const packetColorMap = { grey: { accent: '#90a4ae', progress: '#78909c' }, blue: { accent: '#64b5f6', progress: '#42a5f5' }, red: { accent: '#e57373', progress: '#ef5350' }, yellow: { accent: '#fff176', progress: '#ffee58' }, green: { accent: '#81c784', progress: '#66bb6a' }, pink: { accent: '#f06292', progress: '#ec407a' }, purple: { accent: '#ba68c8', progress: '#ab47bc' }, cyan: { accent: '#4dd0e1', progress: '#26c6da' }, orange: { accent: '#ffb74d', progress: '#ffa726' } };
const defaultPacketColors = packetColorMap.grey;


// --- Initialization ---

/**
 * Injects dependencies from the main sidebar module.
 * @param {object} dependencies - The dependencies to inject.
 */
export function init(dependencies) {
    navigateTo = dependencies.navigateTo;
    showRootViewStatus = dependencies.showRootViewStatus;
    sendMessageToBackground = dependencies.sendMessageToBackground;
}

/**
 * Attaches event listeners specific to the root view.
 */
export function setupRootViewListeners() {
    domRefs.tabInbox?.addEventListener('click', () => switchListTab('library'));
    domRefs.tabInProgress?.addEventListener('click', () => switchListTab('in-progress'));
    domRefs.tabCompleted?.addEventListener('click', () => switchListTab('completed'));
    domRefs.sidebarDeleteBtn?.addEventListener('click', handleDeleteSelectedInstances);
    domRefs.createPacketSidebarBtn?.addEventListener('click', handleCreateButtonClick);
    domRefs.rootView?.addEventListener('change', (event) => {
        if (event.target.classList.contains('packet-checkbox')) {
            updateActionButtonsVisibility();
        }
    });
    domRefs.showImportDialogBtn?.addEventListener('click', showImportDialog);

    // Add listeners for the new Library Action Dialog
    const dialog = document.getElementById('library-action-dialog');
    if (dialog) {
        dialog.querySelector('#lib-action-start-btn')?.addEventListener('click', () => {
            if (currentActionImageId) handleStartPacket(currentActionImageId);
            hideLibraryActionDialog();
        });
        dialog.querySelector('#lib-action-edit-btn')?.addEventListener('click', () => {
            if (currentActionImageId) handleEditPacket(currentActionImageId);
            hideLibraryActionDialog();
        });
        dialog.querySelector('#lib-action-export-btn')?.addEventListener('click', () => {
            if (currentActionImageId) exportPacketAndShowDialog(currentActionImageId);
            hideLibraryActionDialog();
        });
        dialog.querySelector('#lib-action-delete-btn')?.addEventListener('click', () => {
            if (currentActionImageId) handleDeletePacketImage(currentActionImageId);
            hideLibraryActionDialog();
        });
        dialog.querySelector('#lib-action-cancel-btn')?.addEventListener('click', hideLibraryActionDialog);
        dialog.addEventListener('click', (e) => { if (e.target === dialog) hideLibraryActionDialog(); });
    }
}

async function handleCreateButtonClick() {
    try {
        const response = await sendMessageToBackground({ action: 'is_current_tab_packetizable' });

        if (response.success && response.isPacketizable) {
            const choice = await showCreateSourceDialog(); 
            
            if (choice === 'blank') {
                hideCreateSourceDialog();
                navigateTo('create');
            } else if (choice === 'tab') {
                showCreateSourceDialogProgress('Analyzing page...');
                sendMessageToBackground({ action: 'create_draft_from_tab' });
            }

        } else {
            navigateTo('create');
        }
    } catch (error) {
        logger.error("RootView", "Error in create button logic", error);
        showRootViewStatus(`Error: ${error.message}`, 'error');
        navigateTo('create');
    }
}

// --- View Rendering & Management ---

export async function displayRootNavigation() {
    const { inboxList, inProgressList, completedList } = domRefs;
    if (!inboxList || !inProgressList || !completedList) return;
    
    const loadingHTML = `<tr><td colspan="3" class="empty-state">Loading...</td></tr>`;
    inboxList.innerHTML = loadingHTML;
    inProgressList.innerHTML = loadingHTML;
    completedList.innerHTML = loadingHTML;

    try {
        const [imagesMap, instancesMap] = await Promise.all([
            storage.getPacketImages(),
            storage.getPacketInstances()
        ]);

        const images = Object.values(imagesMap);
        const instances = Object.values(instancesMap);

        const sortFn = (a, b) => {
            const dateA = new Date(a.created || a.instantiated || 0).getTime();
            const dateB = new Date(b.created || b.instantiated || 0).getTime();
            return dateB - dateA;
        };

        renderImageList(images.sort(sortFn));
        inProgressStencils.forEach(stencilData => {
            renderOrUpdateImageStencil(stencilData);
        });
        
        const instancesWithImages = instances.map(inst => ({ inst, img: imagesMap[inst.imageId] })).filter(item => item.img);

        const inProgressItems = [];
        const completedItems = [];

        for (const { inst, img } of instancesWithImages) {
            if (inst.status !== 'creating') {
                if (await packetUtils.isPacketInstanceCompleted(inst, img)) {
                    completedItems.push({ inst, img });
                } else {
                    inProgressItems.push({ inst, img });
                }
            }
        }
        
        renderInstanceList(inProgressItems.sort((a,b) => sortFn(a.inst, b.inst)), domRefs.inProgressList, "No packets Started.");
        renderInstanceList(completedItems.sort((a,b) => sortFn(a.inst, b.inst)), domRefs.completedList, "No completed packets yet.");

        updateActionButtonsVisibility();
    } catch (error) {
        logger.error('RootView', 'Error loading data in root view', error);
        const errorHTML = `<tr><td colspan="3" class="empty-state">Error loading.</td></tr>`;
        inboxList.innerHTML = errorHTML;
        inProgressList.innerHTML = errorHTML;
        completedList.innerHTML = errorHTML;
    }
}

function renderImageList(images) {
    const listElement = domRefs.inboxList;
    listElement.innerHTML = '';
    if (images.length === 0) {
        checkAndRenderEmptyState(listElement, "Library is empty. Create a packet!");
    } else {
        const frag = document.createDocumentFragment();
        images.forEach(img => {
            const row = createImageRow(img);
            frag.appendChild(row);
        });
        listElement.appendChild(frag);
    }
}

function renderInstanceList(items, listElement, emptyMessage) {
    listElement.innerHTML = '';
    if (items.length === 0) {
        checkAndRenderEmptyState(listElement, emptyMessage);
    } else {
        const frag = document.createDocumentFragment();
        items.forEach(({ inst, img }) => {
            const row = createInstanceRow(inst, img);
            row.dataset.created = inst.created || inst.instantiated || new Date(0).toISOString();
            frag.appendChild(row);
        });
        listElement.appendChild(frag);
    }
}

function createImageRow(image) {
    const row = document.createElement('tr');
    row.dataset.imageId = image.id;
    row.style.cursor = 'pointer';
    const nameCell = document.createElement('td');
    nameCell.textContent = image.topic;
    row.appendChild(nameCell);
    row.addEventListener('click', () => {
        showLibraryActionDialog(image.id, image.topic);
    });
    return row;
}

function createInstanceRow(instance, image) {
    const row = document.createElement('tr');
    row.dataset.instanceId = instance.instanceId;

    const isStencil = instance.status === 'creating';
    let progressPercentage = 0, progressBarTitle = '';
    
    if (!isStencil) {
        const progressData = packetUtils.calculateInstanceProgress(instance, image);
        progressPercentage = progressData.progressPercentage;
        progressBarTitle = `${progressData.visitedCount}/${progressData.totalCount} - ${progressPercentage}% Complete`;
    }

    const colorName = packetUtils.getColorForTopic(instance.topic);
    const colorHex = (packetColorMap[colorName] || defaultPacketColors).progress;

    const checkboxCell = document.createElement('td');
    checkboxCell.className = 'checkbox-cell';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'packet-checkbox';
    checkbox.dataset.instanceId = instance.instanceId;
    checkbox.addEventListener('click', e => e.stopPropagation());
    checkboxCell.appendChild(checkbox);

    const nameCell = document.createElement('td');
    nameCell.textContent = instance.topic;

    const progressCell = document.createElement('td');
    progressCell.innerHTML = `
        <div class="progress-bar-container" title="${progressBarTitle}">
            <div class="progress-bar" style="width: ${progressPercentage}%; background-color: ${colorHex};"></div>
        </div>`;
    
    row.append(checkboxCell, nameCell, progressCell);

    if (isStencil) {
        row.classList.add('stencil-packet');
        row.title = `Packet "${instance.topic}" is being created...`;
    } else {
        setupInstanceContextMenu(row, instance);
        row.addEventListener('click', (e) => {
            if (e.target !== checkbox && e.target !== checkboxCell) {
                navigateTo('packet-detail', instance.instanceId);
            }
        });
        if (progressPercentage >= 100) {
            row.style.opacity = '0.8';
            row.title = "Packet completed!";
        } else {
            row.title = "Click to view packet details";
        }
    }
    return row;
}

export async function updateInstanceRowUI(instance) {
    const image = await storage.getPacketImage(instance.imageId);
    if (!image) {
        logger.warn('RootView:updateInstanceRowUI', 'Could not find image for instance, removing row.', { instanceId: instance.instanceId });
        removeInstanceRow(instance.instanceId);
        return;
    }
    
    const isCompleted = await packetUtils.isPacketInstanceCompleted(instance, image);
    const targetList = isCompleted ? domRefs.completedList : domRefs.inProgressList;

    let sourceList = null;
    if (domRefs.inProgressList.querySelector(`tr[data-instance-id="${instance.instanceId}"]`)) {
        sourceList = domRefs.inProgressList;
    } else if (domRefs.completedList.querySelector(`tr[data-instance-id="${instance.instanceId}"]`)) {
        sourceList = domRefs.completedList;
    }

    if (!targetList) return;

    const existingRow = sourceList?.querySelector(`tr[data-instance-id="${instance.instanceId}"]`);
    const newRow = createInstanceRow(instance, image);
    newRow.dataset.created = instance.created || instance.instantiated || new Date(0).toISOString();
    
    if (existingRow) {
        if (sourceList === targetList) {
            existingRow.replaceWith(newRow);
        } else {
            existingRow.remove();
            insertRowSorted(newRow, targetList);
            checkAndRenderEmptyState(sourceList, sourceList === domRefs.inProgressList ? "No packets Started." : "No completed packets yet.");
        }
    } else {
        insertRowSorted(newRow, targetList);
    }
    
    checkAndRenderEmptyState(targetList, isCompleted ? "No completed packets yet." : "No packets Started.");
    updateActionButtonsVisibility();
}

export function removeInstanceRow(instanceId) {
    const rowInProgress = domRefs.inProgressList?.querySelector(`tr[data-instance-id="${instanceId}"]`);
    const rowCompleted = domRefs.completedList?.querySelector(`tr[data-instance-id="${instanceId}"]`);

    if (rowInProgress) {
        const list = rowInProgress.parentElement;
        rowInProgress.remove();
        checkAndRenderEmptyState(list, "No packets Started.");
    }
    if (rowCompleted) {
        const list = rowCompleted.parentElement;
        rowCompleted.remove();
        checkAndRenderEmptyState(list, "No completed packets yet.");
    }
    updateActionButtonsVisibility();
}

export function removeImageRow(imageId) {
    const row = domRefs.inboxList?.querySelector(`tr[data-image-id="${imageId}"]`);
    if (row) {
        const list = row.parentElement;
        row.remove();
        checkAndRenderEmptyState(list, "Library is empty. Create a packet!");
    }
}

function switchListTab(tabName) {
    if (!['library', 'in-progress', 'completed'].includes(tabName)) return;
    activeListTab = tabName;

    domRefs.tabInbox?.classList.toggle('active', tabName === 'library');
    domRefs.tabInProgress?.classList.toggle('active', tabName === 'in-progress');
    domRefs.tabCompleted?.classList.toggle('active', tabName === 'completed');
    
    domRefs.contentInbox?.classList.toggle('active', tabName === 'library');
    domRefs.tabContentInProgress?.classList.toggle('active', tabName === 'in-progress');
    domRefs.tabContentCompleted?.classList.toggle('active', tabName === 'completed');

    updateActionButtonsVisibility();
    showRootViewStatus('', 'info', false);
}

async function handleStartPacket(imageId) {
    if (!imageId) return;

    showRootViewStatus('Checking for existing packet...', 'info', false);

    try {
        const image = await storage.getPacketImage(imageId);
        if (!image) {
            throw new Error("Packet not found in the library.");
        }

        const needsPublishing = image.sourceContent.some(item =>
            item.type === 'generated' || item.type === 'media' ||
            (item.type === 'alternative' && item.alternatives.some(alt => alt.type === 'generated' || alt.type === 'media'))
        );

        if (needsPublishing) {
            const isCloudConfigured = await storage.isCloudStorageEnabled();
            if (!isCloudConfigured) {
                const goToSettings = await showConfirmDialog(
                    "This packet contains content that needs to be published. Please configure Cloud Storage in Settings to continue.",
                    "Go to Settings",
                    "Cancel"
                );
                if (goToSettings) {
                    navigateTo('settings');
                }
                return;
            }
        }

        const allInstances = await storage.getPacketInstances();
        const instancesForImage = Object.values(allInstances).filter(inst => inst.imageId === imageId);

        let incompleteInstance = null;
        for (const inst of instancesForImage) {
            if (!(await packetUtils.isPacketInstanceCompleted(inst, image))) {
                incompleteInstance = inst;
                break;
            }
        }

        if (incompleteInstance) {
            showRootViewStatus('Navigating to your in-progress packet.', 'success');
            navigateTo('packet-detail', incompleteInstance.instanceId);
        } else {
            showRootViewStatus(`Starting new packet...`, 'info', false);
            await sendMessageToBackground({
                action: 'instantiate_packet',
                data: { imageId }
            });
        }
    } catch (err) {
        showRootViewStatus(`Error: ${err.message}`, 'error');
        logger.error('RootView:handleStartPacket', 'Error during start packet logic', err);
    }
}
async function handleEditPacket(imageId) {
    try {
        const image = await storage.getPacketImage(imageId);
        if (image) {
            navigateTo('create', null, image);
        } else {
            throw new Error('Could not find packet to edit.');
        }
    } catch (error) {
        showRootViewStatus(error.message, 'error');
    }
}

async function handleDeletePacketImage(imageId) {
    const image = await storage.getPacketImage(imageId);
    const topic = image?.topic || 'this packet';

    const confirmed = await showConfirmDialog(
        `Delete "${topic}" from your Library permanently?`,
        'Delete',
        'Cancel',
        true
    );

    if (confirmed) {
        await sendMessageToBackground({ action: 'delete_packet_image', data: { imageId } });
        showRootViewStatus(`Packet "${topic}" deleted.`, 'success');
    }
}


async function showLibraryActionDialog(imageId, topic) {
    currentActionImageId = imageId;
    const dialog = document.getElementById('library-action-dialog');
    if (dialog) {
        dialog.querySelector('#library-action-title').textContent = topic;

        const exportBtn = dialog.querySelector('#lib-action-export-btn');
        if (exportBtn) {
            const cloudStorageEnabled = await storage.isCloudStorageEnabled();
            exportBtn.disabled = !cloudStorageEnabled;
            exportBtn.title = cloudStorageEnabled
                ? 'Export this packet as a shareable link'
                : 'Cloud Storage must be configured in Settings to export.';
        }

        dialog.style.display = 'flex';
        setTimeout(() => dialog.classList.add('visible'), 10);
    }
}

function hideLibraryActionDialog() {
    currentActionImageId = null;
    const dialog = document.getElementById('library-action-dialog');
    if (dialog) {
        dialog.classList.remove('visible');
        setTimeout(() => { dialog.style.display = 'none'; }, 300);
    }
}


async function handleDeleteSelectedInstances() {
    const { selectedIds } = getSelectedInstanceIdsFromActiveList();
    if (selectedIds.length === 0) return;

    const confirmed = await showConfirmDialog(`Delete ${selectedIds.length} packet(s)? This cannot be undone.`, 'Delete', 'Cancel', true);
    if (!confirmed) return;

    showRootViewStatus(`Deleting ${selectedIds.length}...`, 'info', false);
    try {
        await sendMessageToBackground({ action: 'delete_packets', data: { packetIds: selectedIds } });
    } catch (error) {
        showRootViewStatus(`Delete Error: ${error.message}`, 'error');
    }
}

function setupInstanceContextMenu(row, instance) {
    row.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        removeContextMenus();
        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.style.top = `${e.clientY + 2}px`;
        menu.style.left = `${e.clientX + 2}px`;

        addMenuItem(menu, 'View Details', () => navigateTo('packet-detail', instance.instanceId));
        
        if (await shouldUseTabGroups()) {
            const browserState = await storage.getPacketBrowserState(instance.instanceId);
            addMenuItem(menu, 'Reorder Tabs', () => {
                showRootViewStatus('Requesting reorder...', 'info');
                sendMessageToBackground({ action: 'reorder_packet_tabs', data: { packetId: instance.instanceId } });
            }, '', !browserState?.tabGroupId || !instance.contents || instance.contents.length <= 1);
        }
        
        addDivider(menu);

        addMenuItem(menu, 'Delete Packet', async () => {
            const confirmed = await showConfirmDialog(`Delete packet "${instance.topic}"? This cannot be undone.`, 'Delete', 'Cancel', true);
            if (confirmed) {
                sendMessageToBackground({action:'delete_packets', data:{packetIds:[instance.instanceId]}});
            }
        }, 'delete-action');

        document.body.appendChild(menu);
        addContextMenuListeners(menu);
    });
}

function addMenuItem(menu, text, action, className = '', disabled = false, tooltip = '') {
    const item = document.createElement('div');
    item.className = `context-menu-item ${className}`;
    item.textContent = text;
    item.classList.toggle('disabled', disabled);
    if (tooltip) item.title = tooltip;
    if (!disabled && action) {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            action();
            removeContextMenus();
        });
    }
    menu.appendChild(item);
}

function addDivider(menu) {
    const divider = document.createElement('div');
    divider.className = 'context-menu-divider';
    menu.appendChild(divider);
}

function addContextMenuListeners(menuElement) {
    const handler = (event) => {
        if (!menuElement.contains(event.target)) removeContextMenus();
    };
    currentContextMenuCloseHandler = handler;
    setTimeout(() => {
        document.addEventListener('click', handler, { capture: true, once: true });
        document.addEventListener('contextmenu', handler, { capture: true, once: true });
    }, 0);
}

function removeContextMenus() {
    document.querySelectorAll('.context-menu').forEach(m => m.remove());
    if (currentContextMenuCloseHandler) {
        document.removeEventListener('click', currentContextMenuCloseHandler, { capture: true });
        document.removeEventListener('contextmenu', currentContextMenuCloseHandler, { capture: true });
        currentContextMenuCloseHandler = null;
    }
}

function getSelectedInstanceIdsFromActiveList() {
    const listElement = activeListTab === 'in-progress' ? domRefs.inProgressList : domRefs.completedList;
    if (!listElement) return { selectedIds: [] };
    const checkboxes = listElement.querySelectorAll('.packet-checkbox:checked:not(:disabled)');
    return { selectedIds: Array.from(checkboxes).map(cb => cb.dataset.instanceId).filter(Boolean) };
}

async function updateActionButtonsVisibility() {
    if (!domRefs.sidebarDeleteBtn) return;
    const { selectedIds } = getSelectedInstanceIdsFromActiveList();
    const anySelected = selectedIds.length > 0;
    
    domRefs.sidebarDeleteBtn.style.display = (activeListTab !== 'library' && anySelected) ? 'inline-block' : 'none';
    domRefs.showImportDialogBtn.style.display = (activeListTab === 'library' || !anySelected) ? 'inline-block' : 'none';
}

function checkAndRenderEmptyState(listElement, emptyMessage) {
    if (!listElement) return;
    const hasRows = listElement.querySelector('tr[data-instance-id], tr[data-image-id]');
    const emptyStateRow = listElement.querySelector('tr > td.empty-state');
    if (!hasRows && !emptyStateRow) {
        const colSpan = listElement.parentElement.querySelectorAll('thead th').length || 1;
        listElement.innerHTML = `<tr><td colspan="${colSpan}" class="empty-state">${emptyMessage}</td></tr>`;
    } else if (hasRows && emptyStateRow) {
        emptyStateRow.parentElement.remove();
    }
}

function insertRowSorted(row, listElement) {
    const rows = Array.from(listElement.querySelectorAll('tr[data-created]'));
    let inserted = false;
    for (const r of rows) {
        if (new Date(row.dataset.created).getTime() > new Date(r.dataset.created).getTime()) {
            listElement.insertBefore(row, r);
            inserted = true;
            break;
        }
    }
    if (!inserted) listElement.appendChild(row);
}

export function renderOrUpdateImageStencil(data) {
    const { imageId, topic, progressPercent, text } = data;
    const listElement = domRefs.inboxList;
    if (!listElement) return;

    if (activeListTab !== 'library') {
        switchListTab('library');
    }
    
    const emptyStateRow = listElement.querySelector('tr > td.empty-state');
    if (emptyStateRow) emptyStateRow.parentElement.remove();

    let row = listElement.querySelector(`tr[data-image-id="${imageId}"].stencil-packet`);

    if (!row) {
        row = document.createElement('tr');
        row.dataset.imageId = imageId;
        row.classList.add('stencil-packet');
        row.innerHTML = `<td colspan="1"></td>`;

        const contentCell = row.querySelector('td');
        contentCell.style.display = 'flex';
        contentCell.style.alignItems = 'center';
        contentCell.style.gap = '8px';

        contentCell.innerHTML = `
            <span class="stencil-title" style="flex-grow: 1;">${topic || 'Creating...'}</span>
            <span class="creation-stage-text" style="flex-shrink: 0;"></span>
            <div class="progress-bar-container" title="Creating..." style="width: 100px; flex-shrink: 0;">
                <div class="progress-bar" style="width: 5%;"></div>
            </div>
        `;
        
        listElement.prepend(row);
    }

    const titleElement = row.querySelector('.stencil-title');
    const progressTextElement = row.querySelector('.creation-stage-text');
    const progressBarElement = row.querySelector('.progress-bar');
    const progressBarContainer = row.querySelector('.progress-bar-container');

    if (titleElement && topic) titleElement.textContent = topic;
    if (progressTextElement) progressTextElement.textContent = `(${text})`;
    if (progressBarElement) progressBarElement.style.width = `${progressPercent || 5}%`;
    if (progressBarContainer) progressBarContainer.title = `${text} - ${progressPercent || 5}%`;
}

export function removeImageStencil(imageId) {
    const listElement = domRefs.inboxList;
    if (!listElement) return;

    const row = listElement.querySelector(`tr[data-image-id="${imageId}"].stencil-packet`);
    if (row) {
        row.remove();
        checkAndRenderEmptyState(listElement, "Library is empty. Create a packet!");
    }
}

export function addOrUpdateInProgressStencil(data) {
    if (!data || !data.imageId) return;
    inProgressStencils.set(data.imageId, data);
    if (domRefs.rootView && !domRefs.rootView.classList.contains('hidden')) {
        renderOrUpdateImageStencil(data);
    }
}

export function removeInProgressStencil(imageId) {
    if (inProgressStencils.has(imageId)) {
        inProgressStencils.delete(imageId);
        if (domRefs.rootView && !domRefs.rootView.classList.contains('hidden')) {
            removeImageStencil(imageId);
        }
    }
}