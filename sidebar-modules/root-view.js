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
let inProgressImageStencils = new Map(); // For image creation
let inProgressInstanceStencils = new Map(); // **FIX**: Single source of truth for instance stencils

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
    console.log('[rv_debug] displayRootNavigation START');
    const { inboxList, inProgressList, completedList } = domRefs;
    if (!inboxList || !inProgressList || !completedList) return;
    
    inboxList.innerHTML = '';
    inProgressList.innerHTML = '';
    completedList.innerHTML = '';


    try {
        const [imagesMap, instancesMap] = await Promise.all([
            storage.getPacketImages(),
            storage.getPacketInstances()
        ]);

        const images = Object.values(imagesMap);
        const instances = Object.values(instancesMap);
        
        console.log(`[rv_debug] displayRootNavigation: Found ${instances.length} instances in storage. Stencil count: ${inProgressInstanceStencils.size}`);

        const sortFn = (a, b) => {
            const dateA = new Date(a.created || a.instantiated || 0).getTime();
            const dateB = new Date(b.created || b.instantiated || 0).getTime();
            return dateB - dateA;
        };
        
        const inProgressItems = [];
        const completedItems = [];

        for (const inst of instances) {
            if (inProgressInstanceStencils.has(inst.instanceId)) {
                console.log(`[rv_debug] displayRootNavigation: Skipping render for instance ${inst.instanceId} because a stencil already exists.`);
                continue;
            }

            if (await packetUtils.isPacketInstanceCompleted(inst)) {
                completedItems.push(inst);
            } else {
                inProgressItems.push(inst);
            }
        }
        
        renderImageList(images.sort(sortFn));
        renderInstanceList(inProgressItems.sort(sortFn), domRefs.inProgressList, "No packets Started.");
        renderInstanceList(completedItems.sort(sortFn), domRefs.completedList, "No completed packets yet.");
        
        console.log('[rv_debug] displayRootNavigation: Re-rendering all stencils.');
        inProgressImageStencils.forEach(renderOrUpdateImageStencil);
        inProgressInstanceStencils.forEach(renderOrUpdateInstanceStencil);

        updateActionButtonsVisibility();
    } catch (error) {
        logger.error('RootView', 'Error loading data in root view', error);
        const errorHTML = `<tr><td colspan="3" class="empty-state">Error loading.</td></tr>`;
        inboxList.innerHTML = errorHTML;
        inProgressList.innerHTML = errorHTML;
        completedList.innerHTML = errorHTML;
    }
    console.log('[rv_debug] displayRootNavigation END');
}

function renderImageList(images) {
    const listElement = domRefs.inboxList;
    const frag = document.createDocumentFragment();
    images.forEach(img => {
        const row = createImageRow(img);
        frag.appendChild(row);
    });
    listElement.appendChild(frag);
    checkAndRenderEmptyState(listElement, "Library is empty. Create a packet!");
}

function renderInstanceList(instances, listElement, emptyMessage) {
    const frag = document.createDocumentFragment();
    instances.forEach(inst => {
        const row = createInstanceRow(inst);
        row.dataset.created = inst.created || inst.instantiated || new Date(0).toISOString();
        frag.appendChild(row);
    });
    listElement.appendChild(frag);
    checkAndRenderEmptyState(listElement, emptyMessage);
}

function createImageRow(image) {
    const row = document.createElement('tr');
    row.dataset.imageId = image.id;
    row.style.cursor = 'pointer';
    const nameCell = document.createElement('td');
    nameCell.textContent = image.title;
    row.appendChild(nameCell);
    row.addEventListener('click', () => {
        showLibraryActionDialog(image.id, image.title);
    });
    return row;
}

function createInstanceRow(instance) {
    const row = document.createElement('tr');
    row.dataset.instanceId = instance.instanceId;

    const { progressPercentage, visitedCount, totalCount } = packetUtils.calculateInstanceProgress(instance);

    const colorName = packetUtils.getColorForTopic(instance.title);
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
    nameCell.textContent = instance.title;

    const progressCell = document.createElement('td');
    progressCell.innerHTML = `
        <div class="progress-bar-container" title="${visitedCount}/${totalCount} - ${progressPercentage}% Complete">
            <div class="progress-bar" style="width: ${progressPercentage}%; background-color: ${colorHex};"></div>
        </div>`;
    
    row.append(checkboxCell, nameCell, progressCell);

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
    
    return row;
}

export function updateInstanceRowUI(instance) {
    const instanceId = instance.instanceId;
    inProgressInstanceStencils.delete(instanceId);

    const listElement = domRefs.inProgressList;
    if (!listElement) {
        return;
    }

    const existingRow = listElement.querySelector(`tr[data-instance-id="${instanceId}"]`);
    const newInstanceRow = createInstanceRow(instance);

    if (existingRow) {
        existingRow.replaceWith(newInstanceRow);
    } else {
        const emptyStateRow = listElement.querySelector('tr > td.empty-state');
        if (emptyStateRow) {
            emptyStateRow.parentElement.remove();
        }
        listElement.appendChild(newInstanceRow);
    }
}

export function removeInstanceRow(instanceId) {
    inProgressInstanceStencils.delete(instanceId);
    const row = domRefs.rootView.querySelector(`tr[data-instance-id="${instanceId}"]`);
    if (row) {
        const list = row.parentElement;
        row.remove();
        if (list === domRefs.inProgressList) checkAndRenderEmptyState(list, "No packets Started.");
        if (list === domRefs.completedList) checkAndRenderEmptyState(list, "No completed packets yet.");
    }
    updateActionButtonsVisibility();
}

export function removeImageRow(imageId) {
    inProgressImageStencils.delete(imageId);
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
    console.log(`[rv_debug] handleStartPacket: User clicked start for imageId: ${imageId}`);
    if (!imageId) return;
    try {
        const image = await storage.getPacketImage(imageId);
        if (!image) throw new Error("Packet not found in library.");
        
        const tempInstanceId = `inst_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        console.log(`[rv_debug] handleStartPacket: Generated temporary instanceId: ${tempInstanceId}`);
        
        inProgressInstanceStencils.set(tempInstanceId, { imageId: imageId, instanceId: tempInstanceId, title: image.title });
        console.log(`[rv_debug] handleStartPacket: Added stencil to map. Current stencil count: ${inProgressInstanceStencils.size}`);
        
        renderOrUpdateInstanceStencil({
            instanceId: tempInstanceId,
            title: image.title,
            progressPercent: 5,
            text: "Preparing..."
        });
        switchListTab('in-progress');
        
        await sendMessageToBackground({
            action: 'instantiate_packet',
            data: { imageId, instanceId: tempInstanceId }
        });
        console.log(`[rv_debug] handleStartPacket: Sent 'instantiate_packet' message to background for ${tempInstanceId}`);
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
    const title = image?.title || 'this packet';

    const confirmed = await showConfirmDialog(
        `Delete "${title}" from your Library permanently?`,
        'Delete',
        'Cancel',
        true
    );

    if (confirmed) {
        await sendMessageToBackground({ action: 'delete_packet_image', data: { imageId } });
        showRootViewStatus(`Packet "${title}" deleted.`, 'success');
    }
}


async function showLibraryActionDialog(imageId, title) {
    currentActionImageId = imageId;
    const dialog = document.getElementById('library-action-dialog');
    if (dialog) {
        dialog.querySelector('#library-action-title').textContent = title;

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
            const confirmed = await showConfirmDialog(`Delete packet "${instance.title}"? This cannot be undone.`, 'Delete', 'Cancel', true);
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
    const hasStencils = listElement.querySelector('tr.stencil-packet');
    const emptyStateRow = listElement.querySelector('tr > td.empty-state');

    if (!hasRows && !hasStencils && !emptyStateRow) {
        const colSpan = listElement.closest('table').querySelectorAll('thead th').length || 1;
        listElement.innerHTML = `<tr><td colspan="${colSpan}" class="empty-state">${emptyMessage}</td></tr>`;
    } else if ((hasRows || hasStencils) && emptyStateRow) {
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
    const { imageId, title, progressPercent, text } = data;
    const listElement = domRefs.inboxList;
    if (!listElement) return;
    inProgressImageStencils.set(imageId, data);

    let row = listElement.querySelector(`tr[data-image-id="${imageId}"].stencil-packet`);

    if (!row) {
        const emptyStateRow = listElement.querySelector('tr > td.empty-state');
        if (emptyStateRow) emptyStateRow.parentElement.remove();
        
        row = document.createElement('tr');
        row.dataset.imageId = imageId;
        row.classList.add('stencil-packet');
        row.innerHTML = `<td colspan="1"></td>`;

        const contentCell = row.querySelector('td');
        contentCell.style.display = 'flex';
        contentCell.style.alignItems = 'center';
        contentCell.style.gap = '8px';

        contentCell.innerHTML = `
            <span class="stencil-title" style="flex-grow: 1;">${title || 'Creating...'}</span>
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

    if (titleElement && title) titleElement.textContent = title;
    if (progressTextElement) progressTextElement.textContent = `(${text})`;
    if (progressBarElement) progressBarElement.style.width = `${progressPercent || 5}%`;
    if (progressBarContainer) progressBarContainer.title = `${text} - ${progressPercent || 5}%`;
}

export function renderOrUpdateInstanceStencil(data) {
    const listElement = domRefs.inProgressList;
    if (!listElement) return;

    const { instanceId, title, progressPercent, text } = data;
    let row = listElement.querySelector(`tr[data-instance-id="${instanceId}"]`);

    if (!row) {
        const emptyStateRow = listElement.querySelector('tr > td.empty-state');
        if (emptyStateRow) emptyStateRow.parentElement.remove();
        
        row = document.createElement('tr');
        row.dataset.instanceId = instanceId;
        row.classList.add('stencil-packet');
        const colorName = packetUtils.getColorForTopic(title);
        const colorHex = (packetColorMap[colorName] || defaultPacketColors).progress;

        row.innerHTML = `
            <td class="checkbox-cell">
                <input type="checkbox" class="packet-checkbox" disabled>
            </td>
            <td>
                <span class="stencil-title">${title}</span>
                <span class="creation-stage-text"></span>
            </td>
            <td>
                <div class="progress-bar-container">
                    <div class="progress-bar" style="background-color: ${colorHex};"></div>
                </div>
            </td>
        `;
        listElement.prepend(row);
    }
    
    const progressTextElement = row.querySelector('.creation-stage-text');
    const progressBarElement = row.querySelector('.progress-bar');
    const progressBarContainer = row.querySelector('.progress-bar-container');

    if (progressTextElement) progressTextElement.textContent = `(${text})`;
    if (progressBarElement) progressBarElement.style.width = `${progressPercent}%`;
    if (progressBarContainer) progressBarContainer.title = `${text} - ${progressPercent}%`;
}


export function addOrUpdateInProgressStencil(data) {
    // This function is now only for IMAGE stencils, which show in the Library.
    if (!data || !data.imageId) return;
    inProgressImageStencils.set(data.imageId, data);
    if (domRefs.rootView && !domRefs.rootView.classList.contains('hidden')) {
        renderOrUpdateImageStencil(data);
    }
}


export function removeInProgressStencil(imageId) {
    if (inProgressImageStencils.has(imageId)) {
        inProgressImageStencils.delete(imageId);
        const row = domRefs.inboxList?.querySelector(`tr[data-image-id="${imageId}"].stencil-packet`);
        if (row) {
            row.remove();
            checkAndRenderEmptyState(domRefs.inboxList, "Library is empty. Create a packet!");
        }
    }
}