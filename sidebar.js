// ext/sidebar.js (Global Side Panel - Orchestrator)
// REVISED: The sidebar's navigation logic has been made more robust to prevent UI flicker.
// The `updateSidebarContext` function is now less aggressive about navigating to the root view
// when it receives a transient null context, creating a smoother user experience when
// clicking between packet items.

import { logger, storage, packetUtils, applyThemeMode, CONFIG } from './utils.js';
import { domRefs, cacheDomReferences } from './sidebar-modules/dom-references.js';
import * as dialogHandler from './sidebar-modules/dialog-handler.js';
import * as rootView from './sidebar-modules/root-view.js';
import * as detailView from './sidebar-modules/detail-view.js';
import * as createView from './sidebar-modules/create-view.js';
import * as settingsView from './sidebar-modules/settings-view.js';

// --- High-Level State ---
let currentView = 'root';
let currentInstanceId = null;
let currentInstanceData = null;
let currentPacketUrl = null; // The canonical packet URL from the packet definition
let isNavigating = false;
let nextNavigationRequest = null;
const PENDING_VIEW_KEY = 'pendingSidebarView';
let isOpeningPacketItem = false; // --- THE FIX: Navigation lock flag ---


function resetSidebarState() {
    currentView = 'root';
    currentInstanceId = null;
    currentInstanceData = null;
    currentPacketUrl = null;
    isNavigating = false;
    nextNavigationRequest = null;
    isOpeningPacketItem = false;
    logger.log('Sidebar', 'Internal state has been reset.');
}

// --- Initialization ---

async function initialize() {
    // --- THE FIX: Call the reset function at the very beginning of initialization. ---
    resetSidebarState();
    
    await applyThemeMode();
    cacheDomReferences();

    // Inject dependencies into each module
    const dependencies = { navigateTo, showRootViewStatus, sendMessageToBackground, showSettingsStatus, showConfetti, openUrl };
    dialogHandler.init(dependencies);
    rootView.init(dependencies);
    detailView.init(dependencies);
    createView.init(dependencies);
    settingsView.init(dependencies);

    // Setup event listeners from each module
    dialogHandler.setupDialogListeners();
    rootView.setupRootViewListeners();
    createView.setupCreateViewListeners();
    settingsView.setupSettingsListeners();
    setupGlobalListeners();

    chrome.runtime.connect({ name: 'sidebar' });

    try {
        await sendMessageToBackground({ action: 'sidebar_ready' });
        const sessionData = await storage.getSession(PENDING_VIEW_KEY);
        const pendingViewData = sessionData?.[PENDING_VIEW_KEY];

        if (pendingViewData && pendingViewData.targetView) {
            navigateTo(pendingViewData.targetView, pendingViewData.instanceId);
            await storage.removeSession(PENDING_VIEW_KEY);
        } else {
            const response = await sendMessageToBackground({ action: 'get_current_tab_context' });
            if (response?.success && response.instanceId) {
                await updateSidebarContext(response);
            } else {
                navigateTo('root');
            }
        }
    } catch (error) {
        logger.error('Sidebar', 'Error during initialization or initial context fetch', error);
        navigateTo('root');
    }
}

function setupGlobalListeners() {
    chrome.runtime.onMessage.addListener(handleBackgroundMessage);
    domRefs.backBtn?.addEventListener('click', () => {
        if (currentView === 'create') {
            createView.handleDiscardDraftPacket();
        } else {
            navigateTo('root');
        }
    });
    domRefs.settingsBtn?.addEventListener('click', () => navigateTo('settings'));
}


// --- Navigation & View Management ---

export async function navigateTo(viewName, instanceId = null, data = null) {
    if (isNavigating && (currentView !== viewName || currentInstanceId !== instanceId)) {
        nextNavigationRequest = { viewName, instanceId, data };
        return;
    }
    isNavigating = true;

    if (currentView === 'settings' && viewName !== 'settings') {
        settingsView.triggerPendingSave();
    }
    
    // Do not hide the view container if we are just switching between detail views
    if (currentView !== 'packet-detail' || viewName !== 'packet-detail') {
        [domRefs.rootView, domRefs.createView, domRefs.packetDetailView, domRefs.settingsView].forEach(v => v?.classList.add('hidden'));
    }
    
    domRefs.backBtn?.classList.toggle('hidden', viewName === 'root' || viewName === 'create');
    domRefs.settingsBtn?.classList.toggle('hidden', viewName !== 'root');

    let newSidebarTitle = 'My Packets';

    try {
        switch(viewName) {
            case 'packet-detail':
                // --- THE FIX: Fetch instance and browser state together to avoid race conditions ---
                const [instanceData, browserState] = await Promise.all([
                    storage.getPacketInstance(instanceId),
                    storage.getPacketBrowserState(instanceId)
                ]);

                if (!instanceData) throw new Error(`Packet instance ${instanceId} not found.`);
                
                currentView = 'packet-detail';
                currentInstanceId = instanceData.instanceId;
                currentInstanceData = instanceData;
                newSidebarTitle = instanceData.topic || 'Packet Details';
                domRefs.packetDetailView.classList.remove('hidden');
                
                // --- THE FIX: Pass both the instance and its browser state to the renderer ---
                await detailView.displayPacketContent(instanceData, browserState, currentPacketUrl);
                break;
            case 'create':
                currentView = 'create';
                newSidebarTitle = data?.topic ? `Editing: ${data.topic}` : 'Packet Builder';
                domRefs.settingsBtn?.classList.add('hidden');
                domRefs.createView.classList.remove('hidden');
                await createView.prepareCreateView(data);
                break;
            case 'settings':
                currentView = 'settings';
                newSidebarTitle = 'Settings';
                domRefs.settingsView.classList.remove('hidden');
                await settingsView.prepareSettingsView();
                break;
            default: // root
                currentView = 'root';
                currentInstanceId = null;
                currentInstanceData = null;
                domRefs.rootView.classList.remove('hidden');
                await rootView.displayRootNavigation();
                break;
        }
        if (domRefs.sidebarTitle) domRefs.sidebarTitle.textContent = newSidebarTitle;
    } catch (error) {
        logger.error('Sidebar:navigateTo', `Error navigating to ${viewName}:`, error);
        showRootViewStatus(`Error loading view: ${error.message}`, 'error');
        navigateTo('root');
    } finally {
        isNavigating = false;
        if (nextNavigationRequest) {
            const { viewName: nextView, instanceId: nextInstance, data: nextData } = nextNavigationRequest;
            nextNavigationRequest = null;
            Promise.resolve().then(() => navigateTo(nextView, nextInstance, nextData));
        }
    }
}

// --- State & Context Updates ---

async function updateSidebarContext(contextData) {
    if (currentView === 'create' || isNavigating) return;

    const newInstanceId = contextData?.instanceId ?? null;
    const newPacketUrl = contextData?.packetUrl ?? null;
    let newInstanceData = contextData?.instance ?? null;

    // --- THE FIX: Check the navigation lock ---
    if (isOpeningPacketItem && newInstanceId === null) {
        logger.log('Sidebar:updateSidebarContext', 'Ignoring transient null context due to navigation lock.');
        return;
    }
    
    // Only navigate away from the detail view if we receive a definitive new context
    // that is different, or if the view is not the detail view.
    if (newInstanceId !== currentInstanceId) {
        // The instance ID has changed. Navigate to the new packet or the root.
        currentInstanceId = newInstanceId;
        currentInstanceData = newInstanceData;
        currentPacketUrl = newPacketUrl;
        if (currentInstanceId) {
            navigateTo('packet-detail', currentInstanceId);
        } else if (currentView !== 'root') {
            navigateTo('root');
        }
    } else if (currentView === 'packet-detail' && newInstanceId !== null) {
        // --- START OF THE FIX ---
        // If we receive an update for the current instance but the instance data is null,
        // it means the packet was likely deleted. We should navigate away gracefully.
        if (!newInstanceData) {
            logger.warn('Sidebar:updateSidebarContext', `Received null instance data for current instance ID ${newInstanceId}. Navigating to root.`);
            navigateTo('root');
            return; // Stop further processing
        }
        // --- END OF THE FIX ---

        // The instance is the same, but the active URL might have changed.
        // Just update the content without a full navigation.
        currentInstanceData = newInstanceData;
        currentPacketUrl = newPacketUrl;
        
        // --- THE FIX: Fetch the browser state along with the instance to ensure it's up-to-date ---
        const browserState = await storage.getPacketBrowserState(currentInstanceId);
        await detailView.displayPacketContent(currentInstanceData, browserState, currentPacketUrl);
    }
}

async function openUrl(url, instanceId) {
    if (!url || !instanceId) return;

    const instanceToOpen = currentInstanceData;
    if (!instanceToOpen || instanceToOpen.instanceId !== instanceId) {
        logger.error("Sidebar", "Mismatch or missing instance data for openUrl", { instanceId, currentInstanceData });
        return;
    }

    // --- THE FIX: Set the navigation lock ---
    isOpeningPacketItem = true;
    setTimeout(() => { isOpeningPacketItem = false; }, 1500); // Release lock after 1.5s

    await detailView.triggerImmediateSave();

    sendMessageToBackground({
        action: 'open_content',
        data: { instance: instanceToOpen, url: url }
    }).catch(err => {
        logger.error("Sidebar", `Error opening link: ${err.message}`);
        isOpeningPacketItem = false; // Release lock on error
    });
}


// --- Communication ---

export function sendMessageToBackground(message) {
    return new Promise((resolve, reject) => {
        if (!chrome?.runtime?.sendMessage) return reject(new Error('Chrome runtime unavailable.'));
        chrome.runtime.sendMessage(message, response => {
            const err = chrome.runtime.lastError;
            if (err) {
                if (!err.message?.includes("Could not establish connection")) {
                    reject(new Error(`Background error: ${err.message}`));
                } else {
                    resolve({ success: false, error: "Connection error."});
                }
            } else {
                resolve(response);
            }
        });
    });
}

async function handleBackgroundMessage(message) {
    const { action, data } = message;

    switch (action) {
        case 'draft_packet_created':
            if (data.draft) {
                // --- THE FIX: Hide the progress dialog before navigating ---
                dialogHandler.hideCreateSourceDialog();
                navigateTo('create', null, data.draft);
            }
            break;

        case 'packet_creation_failed':
            // --- THE FIX: Hide the progress dialog before showing the error ---
            dialogHandler.hideCreateSourceDialog();
            dialogHandler.hideImportDialog();
            rootView.removeInProgressStencil(data.imageId);
            showRootViewStatus(`Creation failed: ${data?.error || 'Unknown'}`, 'error');
            break;
        case 'playback_state_updated':
            if (currentView === 'packet-detail') {
                detailView.updatePlaybackUI(data);
            }
            break;
        case 'navigate_to_view':
            if (data?.viewName) {
                logger.log('Sidebar', `Received navigation request to view: ${data.viewName}`);
                navigateTo(data.viewName, data.instanceId);
            }
            break;
        case 'update_sidebar_context':
            await updateSidebarContext(data);
            break;
        case 'packet_creation_progress':
            rootView.addOrUpdateInProgressStencil(data);
            break;
        case 'packet_image_created':
            dialogHandler.hideImportDialog();
            rootView.removeInProgressStencil(data.image.id);
            if (currentView === 'root') {
                await rootView.displayRootNavigation();
            }
            showRootViewStatus(`New packet "${data.image.topic}" ready in Library.`, 'success');
            break;
        case 'packet_image_deleted':
            if (currentView === 'root') {
                rootView.removeImageRow(data.imageId);
            }
            break;
        case 'packet_creation_failed':
            dialogHandler.hideImportDialog();
            rootView.removeInProgressStencil(data.imageId);
            showRootViewStatus(`Creation failed: ${data?.error || 'Unknown'}`, 'error');
            break;
        case 'packet_instance_created':
            showRootViewStatus(`Started packet '${data.instance.topic}'.`, 'success');
            if (currentView !== 'create') {
                navigateTo('packet-detail', data.instance.instanceId);
            }
            break;
        case 'packet_instance_updated':
            if (currentView === 'root') {
                rootView.updateInstanceRowUI(data.instance);
            } else if (currentView === 'packet-detail' && currentInstanceId === data.instance.instanceId) {
                // When an instance is updated, we need its browser state too
                const browserState = await storage.getPacketBrowserState(data.instance.instanceId);
                await detailView.displayPacketContent(data.instance, browserState, currentPacketUrl);
            }
            break;
        case 'packet_instance_deleted':
            if (currentView === 'root') {
                rootView.removeInstanceRow(data.packetId);
            }

            if (data?.packetId === currentInstanceId) {
                currentInstanceId = null;
                currentInstanceData = null;
            }

            // Always clear the detail view's internal state to prevent zombie saves.
            detailView.clearCurrentDetailView();
            detailView.stopAudioIfPacketDeleted(data.packetId);
            
            // If the user somehow deleted the packet they were actively looking at,
            // navigate them safely back to the root view.
            if (data?.packetId === currentInstanceId && currentView === 'packet-detail') {
                navigateTo('root');
            }
            // --- END OF THE FIX ---
            break;
        case 'packet_deletion_complete':
            showRootViewStatus(data.message || 'Deletion complete.', data.errors?.length > 0 ? 'error' : 'success');
            if (currentView === 'root') await rootView.displayRootNavigation();
            break;
        case 'prompt_close_tab_group':
            dialogHandler.showCloseGroupDialog(data);
            break;
        case 'show_confetti':
            showConfetti(data.topic);
            break;
        case 'theme_preference_updated':
            await applyThemeMode();
            break;
    }
}

// --- Status Messaging ---

function showStatusMessage(element, message, type = 'info', autoClear = true) {
    if (!element) return;
    element.textContent = message;
    element.className = 'status-message';
    if (type === 'error') element.classList.add('error-message');
    if (type === 'success') element.classList.add('success-message');
    element.style.visibility = 'visible';
    element.style.opacity = '1';
    if (autoClear) {
        setTimeout(() => {
            if (element.textContent === message) clearStatusMessage(element);
        }, 4000);
    }
}

function clearStatusMessage(element) {
    if (element) {
        element.style.visibility = 'hidden';
        element.style.opacity = '0';
        setTimeout(() => {
            element.textContent = '';
            element.className = 'status-message';
        }, 200);
    }
}

function showRootViewStatus(message, type, autoClear) {
    showStatusMessage(domRefs.sidebarStatusMessage, message, type, autoClear);
}

function showSettingsStatus(message, type, autoClear) {
    showStatusMessage(domRefs.settingsStatusMessage, message, type, autoClear);
}

// --- Confetti Animation ---

async function showConfetti(topic) {
    const settings = await storage.getSettings();
    if (settings.confettiEnabled === false) {
        return; 
    }

    const colorName = packetUtils.getColorForTopic(topic);
    const colorMap = { grey: '#78909c', blue: '#42a5f5', red: '#ef5350', yellow: '#ffee58', green: '#66bb6a', pink: '#ec407a', purple: '#ab47bc', cyan: '#26c6da', orange: '#ffa726' };
    const color = colorMap[colorName] || '#78909c';

    const container = document.createElement('div');
    container.id = 'confetti-container';
    document.body.appendChild(container);

    const numPieces = 70;
    for (let i = 0; i < numPieces; i++) {
        const piece = document.createElement('div');
        piece.className = 'confetti-piece';
        piece.style.left = `${Math.random() * 100}%`;
        piece.style.backgroundColor = color;
        piece.style.width = `${Math.random() * 8 + 5}px`;
        piece.style.height = `${Math.random() * 12 + 8}px`;
        piece.style.opacity = Math.random() * 0.5 + 0.5;
        piece.style.animationDuration = `${(Math.random() * 3) + 3}s`;
        piece.style.animationDelay = `${Math.random() * 3}s`;
        piece.style.animationTimingFunction = `cubic-bezier(0.25, 0.1, 0.25, 1)`;
        container.appendChild(piece);
    }

    setTimeout(() => {
        container.remove();
    }, 6000);
}


// --- Entry Point ---
document.addEventListener('DOMContentLoaded', initialize);