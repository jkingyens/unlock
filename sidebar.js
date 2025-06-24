// ext/sidebar.js (Global Side Panel - Orchestrator)
// This file initializes the sidebar, manages high-level state and navigation,
// and delegates tasks to the various view-specific modules.

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
let currentPacketUrl = null; // The canonical packet URL/S3 key
let isNavigating = false;
let nextNavigationRequest = null;
const PENDING_VIEW_KEY = 'pendingSidebarView';


// --- Initialization ---

async function initialize() {
    await applyThemeMode();
    cacheDomReferences();

    // Inject dependencies into each module
    const dependencies = { navigateTo, showRootViewStatus, sendMessageToBackground, showSettingsStatus, showConfetti };
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
        const pendingView = sessionData?.[PENDING_VIEW_KEY];

        if (pendingView) {
            navigateTo(pendingView);
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

    [domRefs.rootView, domRefs.createView, domRefs.packetDetailView, domRefs.settingsView].forEach(v => v?.classList.add('hidden'));
    
    domRefs.backBtn?.classList.toggle('hidden', viewName === 'root' || viewName === 'create');
    domRefs.settingsBtn?.classList.toggle('hidden', viewName !== 'root');

    let newSidebarTitle = 'My Packets';

    try {
        switch(viewName) {
            case 'packet-detail':
                const instanceData = await storage.getPacketInstance(instanceId);
                if (!instanceData) throw new Error(`Packet instance ${instanceId} not found.`);
                currentView = 'packet-detail';
                currentInstanceId = instanceData.instanceId;
                currentInstanceData = instanceData;
                newSidebarTitle = instanceData.topic || 'Packet Details';
                domRefs.packetDetailView.classList.remove('hidden');
                await detailView.displayPacketContent(instanceData, currentPacketUrl);
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
    if (currentView === 'create') return; // Ignore context updates while creating a packet

    const newInstanceId = contextData?.instanceId ?? null;
    const newPacketUrl = contextData?.packetUrl ?? null;
    const newInstanceData = contextData?.instance ?? null;

    if (currentView === 'packet-detail' && newInstanceId === currentInstanceId) {
        currentInstanceData = newInstanceData;
        currentPacketUrl = newPacketUrl;
        await detailView.displayPacketContent(currentInstanceData, currentPacketUrl);
    }
    else if (newInstanceId !== currentInstanceId) {
        currentInstanceId = newInstanceId;
        currentInstanceData = newInstanceData;
        currentPacketUrl = newPacketUrl;
        if (currentInstanceId) {
            navigateTo('packet-detail', currentInstanceId);
        } else if (currentView !== 'root') {
            navigateTo('root');
        }
    }
    else if (currentView === 'packet-detail' && newInstanceId === null) {
        navigateTo('root');
    }
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
        case 'update_sidebar_context':
            await updateSidebarContext(data);
            break;
        case 'packet_creation_progress':
            // The root view module is now stateful and will handle this unconditionally.
            rootView.addOrUpdateInProgressStencil(data);
            break;
        case 'packet_image_created':
            dialogHandler.hideImportDialog();
            // Always tell the root view to remove the stencil from its state.
            rootView.removeInProgressStencil(data.image.id);
            if (currentView === 'root') {
                // Refresh the view from storage to show the final packet.
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
            // Always tell the root view to remove the stencil from its state.
            rootView.removeInProgressStencil(data.imageId);
            showRootViewStatus(`Creation failed: ${data?.error || 'Unknown'}`, 'error');
            break;
        case 'packet_instance_created':
            showRootViewStatus(`Started packet '${data.instance.topic}'.`, 'success');
            // If the user is not in the create view, navigate to the new packet.
            if (currentView !== 'create') {
                navigateTo('packet-detail', data.instance.instanceId);
            }
            break;
        case 'packet_instance_updated':
            if (currentView === 'root') {
                rootView.updateInstanceRowUI(data.instance);
            } else if (currentView === 'packet-detail' && currentInstanceId === data.instance.instanceId) {
                currentInstanceData = data.instance;
                await detailView.displayPacketContent(data.instance, currentPacketUrl);
            }
            break;
        case 'packet_instance_deleted':
            if (currentView === 'root') {
                rootView.removeInstanceRow(data.packetId);
            }
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
        return; // Exit if confetti is disabled
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