// ext/sidebar.js (Global Side Panel - Orchestrator)
// REVISED: The packet_instance_deleted message handler is now more robust,
// ensuring it correctly clears internal state and navigates to the root view
// if the currently active packet is the one being deleted.
// REVISED: The sidebar will now remain on the packet detail view if that packet's
// media is playing, even when the user navigates to a tab outside the packet.

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
let isOpeningPacketItem = false;
let activeMediaInstanceId = null; // NEW: Tracks the ID of the packet with active media

function resetSidebarState() {
    currentView = 'root';
    currentInstanceId = null;
    currentInstanceData = null;
    currentPacketUrl = null;
    isNavigating = false;
    nextNavigationRequest = null;
    isOpeningPacketItem = false;
    // Note: activeMediaInstanceId is NOT reset here intentionally
    logger.log('Sidebar', 'Internal state has been reset.');
}

// --- Initialization ---

async function initialize() {
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

    try {
        await sendMessageToBackground({ action: 'sidebar_ready' });
        const sessionData = await storage.getSession(PENDING_VIEW_KEY);
        const pendingViewData = sessionData?.[PENDING_VIEW_KEY];

        if (pendingViewData && pendingViewData.targetView) {
            navigateTo(pendingViewData.targetView, pendingViewData.instanceId);
            await storage.removeSession(PENDING_VIEW_KEY);
        } else {
            const response = await sendMessageToBackground({ action: 'get_initial_sidebar_context' });
            if (response?.success) {
                await updateSidebarContext(response);
                if (!response.instanceId) {
                    navigateTo('root');
                }
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
            resetSidebarState(); // Explicitly reset state before navigating
            navigateTo('root');
        }
    });
    domRefs.settingsBtn?.addEventListener('click', () => navigateTo('settings'));

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            sendMessageToBackground({ action: 'sidebar_opened' });
        } else {
            sendMessageToBackground({ action: 'sidebar_closed' });
        }
    });
}


// --- Navigation & View Management ---

export async function navigateTo(viewName, instanceId = null, data = null) {
    // --- START OF FIX: Gracefully handle messaging errors for tab groups ---
    // If we are navigating away from a detail view, tell the background to collapse the group.
    if (currentView === 'packet-detail' && currentInstanceId && (viewName !== 'packet-detail' || currentInstanceId !== instanceId)) {
        sendMessageToBackground({
            action: 'collapse_tab_group_for_instance',
            data: { instanceId: currentInstanceId }
        }).catch(e => logger.warn('Sidebar', 'Failed to send collapse message (service worker may be waking up).', e.message));
    }
    // --- END OF FIX ---

    if (viewName === 'root') {
        resetSidebarState();
    }

    if (isNavigating && (currentView !== viewName || currentInstanceId !== instanceId)) {
        nextNavigationRequest = { viewName, instanceId, data };
        return;
    }
    isNavigating = true;

    if (currentView === 'settings' && viewName !== 'settings') {
        settingsView.triggerPendingSave();
    }

    if (currentView !== 'packet-detail' || viewName !== 'packet-detail') {
        [domRefs.rootView, domRefs.createView, domRefs.packetDetailView, domRefs.settingsView].forEach(v => v?.classList.add('hidden'));
    }

    domRefs.backBtn?.classList.toggle('hidden', viewName === 'root' || viewName === 'create');
    domRefs.settingsBtn?.classList.toggle('hidden', viewName !== 'root');

    let newSidebarTitle = 'My Packets';

    try {
        switch(viewName) {
            case 'packet-detail':
                const instanceData = await storage.getPacketInstance(instanceId);

                if (!instanceData) throw new Error(`Packet instance ${instanceId} not found.`);

                const browserState = await storage.getPacketBrowserState(instanceId);

                currentView = 'packet-detail';
                currentInstanceId = instanceData.instanceId;
                currentInstanceData = instanceData;
                newSidebarTitle = instanceData.title || 'Packet Details';
                domRefs.packetDetailView.classList.remove('hidden');

                await detailView.displayPacketContent(instanceData, browserState, currentPacketUrl);
                
                // --- START OF FIX: Gracefully handle messaging errors for tab groups ---
                // If we are navigating to a detail view, tell the background to expand the group.
                sendMessageToBackground({
                    action: 'expand_tab_group_for_instance',
                    data: { instanceId: currentInstanceId }
                }).catch(e => logger.warn('Sidebar', 'Failed to send expand message (service worker may be waking up).', e.message));
                // --- END OF FIX ---
                break;
            case 'create':
                currentView = 'create';
                newSidebarTitle = data?.title ? `Editing: ${data.title}` : 'Packet Builder';
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
                currentView = 'root'; // State is already reset, just update the view name
                domRefs.rootView.classList.remove('hidden');
                await rootView.displayRootNavigation();
                break;
        }
        if (domRefs.sidebarTitle) domRefs.sidebarTitle.textContent = newSidebarTitle;
    } catch (error) {
        logger.error('Sidebar:navigateTo', `Error navigating to ${viewName}:`, error);
        showRootViewStatus(`Error loading view: ${error.message}`, 'error');
        navigateTo('root'); // Fallback to root
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

    if (newInstanceId === null && currentView === 'packet-detail' && currentInstanceId === activeMediaInstanceId) {
        logger.log('Sidebar:updateSidebarContext', 'Ignoring context change to null because active media packet is being viewed.');
        return;
    }

    if (isOpeningPacketItem && newInstanceId === null) {
        logger.log('Sidebar:updateSidebarContext', 'Ignoring transient null context due to navigation lock.');
        return;
    }

    if (newInstanceId !== currentInstanceId) {
        currentInstanceId = newInstanceId;
        currentInstanceData = newInstanceData;
        currentPacketUrl = newPacketUrl;
        if (currentInstanceId) {
            navigateTo('packet-detail', currentInstanceId);
        } else if (currentView !== 'root') {
            navigateTo('root');
        }
    } else if (currentView === 'packet-detail' && newInstanceId !== null) {
        if (!newInstanceData) {
            logger.warn('Sidebar:updateSidebarContext', `Received null instance data for current instance ID ${newInstanceId}. Navigating to root.`);
            navigateTo('root');
            return;
        }

        currentInstanceData = newInstanceData;
        currentPacketUrl = newPacketUrl;

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

    isOpeningPacketItem = true;
    setTimeout(() => { isOpeningPacketItem = false; }, 1500);

    sendMessageToBackground({
        action: 'open_content',
        data: { instance: instanceToOpen, url: url }
    }).catch(err => {
        logger.error("Sidebar", `Error opening link: ${err.message}`);
        isOpeningPacketItem = false;
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
        case 'deactivate_all_interactive_cards':
            document.querySelectorAll('.card.listening-for-input').forEach(card => {
                card.classList.remove('listening-for-input');
            });
            break;
        case 'draft_packet_created':
            if (data.draft) {
                dialogHandler.hideCreateSourceDialog();
                navigateTo('create', null, data.draft);
            }
            break;
        case 'packet_creation_failed':
            dialogHandler.hideCreateSourceDialog();
            dialogHandler.hideImportDialog();
            rootView.removeInstanceRow(data.instanceId);
            rootView.removeImageRow(data.imageId);
            showRootViewStatus(`Creation failed: ${data?.error || 'Unknown'}`, 'error');
            break;
        case 'packet_instantiation_progress':
            if (currentView === 'root') {
                rootView.renderOrUpdateInstanceStencil(data);
            }
            break;
        case 'packet_creation_progress':
            if (currentView === 'root') {
                 rootView.renderOrUpdateImageStencil(data);
            }
            break;
        case 'playback_state_updated':
            if (data.state === 'playing') {
                activeMediaInstanceId = data.instanceId;
            } else if (activeMediaInstanceId === data.instanceId) {
                activeMediaInstanceId = null;
            }

            if (currentView === 'packet-detail' && currentInstanceId === data.instanceId) {
                currentInstanceData = data.instance;
                detailView.updatePlaybackUI(data, currentInstanceData);
                detailView.updateCardVisibility(currentInstanceData);
                if (data.lastTrippedMoment?.url) {
                    const cardToAnimate = domRefs.packetDetailView.querySelector(`.card[data-url="${data.lastTrippedMoment.url}"]`);
                    if (cardToAnimate && !cardToAnimate.classList.contains('link-mentioned')) {
                        cardToAnimate.classList.add('link-mentioned');
                        setTimeout(() => {
                            if (cardToAnimate) {
                                cardToAnimate.classList.remove('link-mentioned');
                            }
                        }, 3000);
                    }
                }
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
        case 'packet_image_created':
            dialogHandler.hideImportDialog();
            rootView.removeInProgressStencil(data.image.id);
            if (currentView === 'root') {
                await rootView.displayRootNavigation();
            }
            showRootViewStatus(`New packet "${data.image.title}" ready in Library.`, 'success');
            break;
        case 'packet_image_deleted':
            if (currentView === 'root') {
                rootView.removeImageRow(data.imageId);
            }
            break;
        case 'packet_instance_created':
            showRootViewStatus(`Started packet '${data.instance.title}'.`, 'success');
            if (currentView === 'root') {
                rootView.updateInstanceRowUI(data.instance);
            } else {
                navigateTo('packet-detail', data.instance.instanceId);
            }
            break;
        case 'packet_instance_updated':
            if (currentView === 'root') {
                rootView.updateInstanceRowUI(data.instance);
            } else if (currentView === 'packet-detail' && currentInstanceId === data.instance.instanceId) {
                storage.getPacketBrowserState(data.instance.instanceId).then(browserState => {
                    detailView.displayPacketContent(data.instance, browserState, currentPacketUrl);
                });
            }
            break;
        case 'packet_instance_deleted':
            const wasViewingDeletedPacket = data?.packetId === currentInstanceId;
            if (currentView === 'root') {
                rootView.removeInstanceRow(data.packetId);
            }
            if (wasViewingDeletedPacket) {
                resetSidebarState();
                detailView.stopAudioIfPacketDeleted(data.packetId);
                navigateTo('root');
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
            showConfetti(data.title);
            break;
        case 'theme_preference_updated':
            await applyThemeMode();
            break;
        case 'media_cache_populated':
            if (currentView === 'packet-detail' && currentInstanceId === data.instanceId) {
                detailView.redrawSingleWaveform(data.lrl);
            }
            break;
        case 'html_cache_populated':
            if (currentView === 'packet-detail' && currentInstanceId === data.instanceId) {
                detailView.updateSingleCardToCached(data.lrl);
            }
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

async function showConfetti(title) {
    const settings = await storage.getSettings();
    if (settings.confettiEnabled === false) {
        return;
    }

    const colorName = packetUtils.getColorForTopic(title);
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