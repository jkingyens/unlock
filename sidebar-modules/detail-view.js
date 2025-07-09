// ext/sidebar-modules/detail-view.js
// Manages the packet detail view, including rendering content cards and progress.

import { domRefs } from './dom-references.js';
import { logger, storage, packetUtils, indexedDbStorage } from '../utils.js';
import { calculateInstanceProgress } from './root-view.js'; // We can reuse this from the root view module

// --- Module-specific State & Dependencies ---
let isDisplayingPacketContent = false;
let queuedDisplayRequest = null;
let activeAudioElement = null;

// Functions to be imported from the new, lean sidebar.js
let sendMessageToBackground;

/**
 * Injects dependencies from the main sidebar module.
 * @param {object} dependencies - The dependencies to inject.
 */
export function init(dependencies) {
    sendMessageToBackground = dependencies.sendMessageToBackground;
}

// --- Main Rendering Function ---

/**
 * Renders the entire detail view for a given packet instance.
 * @param {object} instance - The PacketInstance data to display.
 * @param {string} currentPacketUrl - The canonical URL of the currently active content, if any.
 */
export async function displayPacketContent(instance, currentPacketUrl) {
    const uniqueCallId = Date.now();
    if (isDisplayingPacketContent) {
        queuedDisplayRequest = { instance, currentPacketUrl };
        logger.warn(`DetailView[${uniqueCallId}]`, 'Display already Started. Queuing request for instance:', instance?.instanceId);
        return;
    }
    isDisplayingPacketContent = true;

    const container = domRefs.packetDetailView;
    if (!instance || !instance.instanceId || !container) {
        if (container) container.innerHTML = '<div class="empty-state">Packet data unavailable.</div>';
        logger.warn(`DetailView[${uniqueCallId}]`, 'Cannot display packet content: Missing instance or container.');
        isDisplayingPacketContent = false;
        processQueuedDisplayRequest();
        return;
    }

    try {
        const isAlreadyRendered = container.querySelector(`#detail-cards-container[data-instance-id="${instance.instanceId}"]`);

        if (isAlreadyRendered) {
            // --- Non-destructive update path ---
            logger.log(`DetailView[${uniqueCallId}]`, 'Updating existing detail view non-destructively.');
            
            let mediaProgress = {};
            if (activeAudioElement && !activeAudioElement.paused) {
                const pageId = activeAudioElement.dataset.pageId;
                if (pageId && !isNaN(activeAudioElement.duration)) {
                    mediaProgress[pageId] = activeAudioElement.currentTime / activeAudioElement.duration;
                }
            }

            const { progressPercentage } = calculateInstanceProgress(instance, mediaProgress);
            const progressBar = container.querySelector('#detail-progress-container .progress-bar');
            if (progressBar) {
                progressBar.style.width = `${progressPercentage}%`;
            }
            const progressBarContainer = container.querySelector('#detail-progress-container .progress-bar-container');
            if(progressBarContainer) {
                progressBarContainer.title = `${progressPercentage}% Complete`;
            }

            // Update visited status on cards
            const visitedUrlsSet = new Set(instance.visitedUrls || []);
            const visitedGeneratedIds = new Set(instance.visitedGeneratedPageIds || []);
            container.querySelectorAll('.card').forEach(card => {
                const isVisited = (card.dataset.pageId && visitedGeneratedIds.has(card.dataset.pageId)) ||
                                  (card.dataset.url && visitedUrlsSet.has(card.dataset.url));
                card.classList.toggle('visited', isVisited);
            });
            
            updateActiveCardHighlight(currentPacketUrl);

        } else {
            // --- Full render path (for initial load) ---
            logger.log(`DetailView[${uniqueCallId}]`, 'Performing full render of detail view.');
            const colorName = packetUtils.getColorForTopic(instance.topic);
            const colors = { grey: { accent: '#90a4ae', progress: '#78909c' }, blue: { accent: '#64b5f6', progress: '#42a5f5' }, red: { accent: '#e57373', progress: '#ef5350' }, yellow: { accent: '#fff176', progress: '#ffee58' }, green: { accent: '#81c784', progress: '#66bb6a' }, pink: { accent: '#f06292', progress: '#ec407a' }, purple: { accent: '#ba68c8', progress: '#ab47bc' }, cyan: { accent: '#4dd0e1', progress: '#26c6da' }, orange: { accent: '#ffb74d', progress: '#ffa726' } }[colorName] || { accent: '#90a4ae', progress: '#78909c' };
            
            container.style.setProperty('--packet-color-accent', colors.accent);
            container.style.setProperty('--packet-color-progress-fill', colors.progress);
            
            const fragment = document.createDocumentFragment();
            fragment.appendChild(createProgressSection(instance));
            fragment.appendChild(await createActionButtons(instance));
            const cardsWrapper = createCardsSection(instance);
            cardsWrapper.dataset.instanceId = instance.instanceId; // Tag the container for future updates
            fragment.appendChild(cardsWrapper);

            container.innerHTML = ''; // Clear previous content
            container.appendChild(fragment);

            updateActiveCardHighlight(currentPacketUrl);
        }
    } catch (error) {
        logger.error(`DetailView[${uniqueCallId}]`, 'Error during detail view rendering', { instanceId: instance?.instanceId, error });
        container.innerHTML = '<div class="empty-state">Error displaying packet details.</div>';
    } finally {
        isDisplayingPacketContent = false;
        processQueuedDisplayRequest();
    }
}

function processQueuedDisplayRequest() {
    if (queuedDisplayRequest) {
        const { instance, currentPacketUrl } = queuedDisplayRequest;
        queuedDisplayRequest = null;
        // Use Promise.resolve().then() to avoid deep recursion
        Promise.resolve().then(() => displayPacketContent(instance, currentPacketUrl));
    }
}


// --- UI Element Creation ---

function createProgressSection(instance) {
    const { progressPercentage } = calculateInstanceProgress(instance);
    const progressWrapper = document.createElement('div');
    progressWrapper.id = 'detail-progress-container';
    progressWrapper.innerHTML = `<div class="progress-bar-container" title="${progressPercentage}% Complete"><div class="progress-bar" style="width: ${progressPercentage}%"></div></div>`;
    domRefs.detailProgressContainer = progressWrapper;
    return progressWrapper;
}

async function createActionButtons(instance) {
    const actionButtonContainer = document.createElement('div');
    actionButtonContainer.id = 'detail-action-button-container';
    
    const isCompleted = packetUtils.isPacketInstanceCompleted(instance);
    let browserState = instance.instanceId ? await storage.getPacketBrowserState(instance.instanceId) : null;
    const tabGroupId = browserState?.tabGroupId;
    let groupExists = false;

    if (tabGroupId && chrome.tabGroups?.get) {
        try {
            await chrome.tabGroups.get(tabGroupId);
            groupExists = true;
        } catch (e) { /* group is gone */ }
    }

    if (isCompleted && groupExists) {
        const closeGroupBtn = document.createElement('button');
        closeGroupBtn.id = 'detail-close-group-btn';
        closeGroupBtn.textContent = 'Close Tab Group';
        closeGroupBtn.addEventListener('click', () => handleCloseTabGroup(tabGroupId));
        actionButtonContainer.appendChild(closeGroupBtn);
    }
    
    domRefs.detailActionButtonContainer = actionButtonContainer;
    return actionButtonContainer;
}

function createCardsSection(instance) {
    const cardsWrapper = document.createElement('div');
    cardsWrapper.id = 'detail-cards-container';
    const visitedUrlsSet = new Set(instance.visitedUrls || []);
    const visitedGeneratedIds = new Set(instance.visitedGeneratedPageIds || []);

    if (instance.contents && instance.contents.length > 0) {
        instance.contents.forEach(item => {
            const card = createContentCard(item, visitedUrlsSet, visitedGeneratedIds, instance);
            if (card) cardsWrapper.appendChild(card);
        });
    } else {
        cardsWrapper.innerHTML = '<div class="empty-state">This packet has no content items.</div>';
    }
    
    domRefs.detailCardsContainer = cardsWrapper;
    return cardsWrapper;
}

function createContentCard(contentItem, visitedUrlsSet, visitedGeneratedIds, instance) {
    if (!contentItem || !contentItem.type) return null;

    const card = document.createElement('div');
    card.className = 'card';
    let { url: urlToOpen, title = 'Untitled', relevance = '', type } = contentItem;
    let displayUrl = urlToOpen || '(URL missing)', iconHTML = '?', isClickable = false, isVisited = false;

    if (contentItem.url) card.dataset.url = contentItem.url;
    if (contentItem.pageId) card.dataset.pageId = contentItem.pageId;

    if (type === 'external') {
        iconHTML = '🔗';
        if (urlToOpen) {
            isClickable = true;
            isVisited = visitedUrlsSet.has(urlToOpen);
        }
    } else if (type === 'generated') {
        iconHTML = '📄';
        if (urlToOpen && contentItem.published) {
            isClickable = true;
            isVisited = visitedGeneratedIds.has(contentItem.pageId);
            displayUrl = title; // For generated pages, show title instead of long S3 key
        } else {
            card.style.opacity = '0.7';
            displayUrl = contentItem.published ? '(Error: URL missing)' : '(Not Published)';
        }
    } else if (type === 'media') {
        iconHTML = '▶️';
        if (contentItem.published) {
            isClickable = true;
            isVisited = visitedGeneratedIds.has(contentItem.pageId);
            displayUrl = title;
        } else {
            card.style.opacity = '0.7';
            displayUrl = '(Not Published)';
        }
    }


    card.innerHTML = `<div class="card-icon">${iconHTML}</div><div class="card-text"><div class="card-title">${title}</div><div class="card-url">${displayUrl}</div>${relevance ? `<div class="card-relevance">${relevance}</div>` : ''}</div>`;
    
    if (isClickable) {
        card.classList.add('clickable');
        if (type === 'media') {
            const playerButton = document.createElement('button');
            playerButton.className = 'media-player-button';
            playerButton.textContent = '▶️';
            playerButton.onclick = (e) => {
                e.stopPropagation();
            };
            card.addEventListener('click', () => playMediaInCard(card, contentItem, instance));
            card.appendChild(playerButton);
        } else {
            card.addEventListener('click', () => openUrl(urlToOpen, instance.instanceId));
        }
    }
    if (isVisited) card.classList.add('visited');
    
    return card;
}

// --- UI Updates ---

export function updateActiveCardHighlight(packetUrlToHighlight) {
    const cardsContainer = domRefs.detailCardsContainer;
    if (!cardsContainer) return;

    let activeCardElement = null;
    cardsContainer.querySelectorAll('.card').forEach(card => {
        card.classList.remove('active');
        if (packetUrlToHighlight && card.dataset.url === packetUrlToHighlight) {
            card.classList.add('active');
            activeCardElement = card;
        }
    });
    
    if (activeCardElement) {
        activeCardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

// --- Action Handlers ---

function openUrl(url, instanceId) {
    if (!url || !instanceId) return;
    sendMessageToBackground({
        action: 'open_content',
        data: { packetId: instanceId, url: url, clickedUrl: url }
    }).catch(err => logger.error("DetailView", `Error opening link: ${err.message}`));
}

function handleCloseTabGroup(tabGroupId) {
    sendMessageToBackground({
        action: 'remove_tab_groups',
        data: { groupIds: [tabGroupId] }
    }).catch(err => logger.error("DetailView", `Error closing group: ${err.message}`));
}

async function playMediaInCard(card, contentItem, instance) {
    if (activeAudioElement && !activeAudioElement.paused && activeAudioElement.dataset.pageId === contentItem.pageId) {
        activeAudioElement.pause();
        return;
    }
    
    // If clicking on a different audio card, pause the old one
    if (activeAudioElement && activeAudioElement.dataset.pageId !== contentItem.pageId) {
        activeAudioElement.pause();
    }

    const playerButton = card.querySelector('.media-player-button');
    if (!playerButton) return;

    // Use existing audio element if it's for the same media, otherwise create new
    if (!activeAudioElement || activeAudioElement.dataset.pageId !== contentItem.pageId) {
        const audio = new Audio();
        audio.dataset.pageId = contentItem.pageId;
        activeAudioElement = audio;
        
        const cachedAudio = await indexedDbStorage.getGeneratedContent(instance.instanceId, contentItem.pageId);
        if (cachedAudio) {
            const blob = new Blob([cachedAudio[0].content], { type: contentItem.mimeType });
            audio.src = URL.createObjectURL(blob);
        } else {
            const response = await sendMessageToBackground({
                action: 'get_presigned_url',
                data: { s3Key: contentItem.url, instanceId: instance.instanceId }
            });
            if (response.success) {
                audio.src = response.url;
            } else {
                logger.error("DetailView", "Failed to get presigned URL for media", response.error);
                return;
            }
        }
    }
    
    const audio = activeAudioElement;
    const sessionKey = `audio_progress_${instance.instanceId}_${contentItem.pageId}`;
    
    audio.onplay = () => {
        playerButton.textContent = '⏸️';
    };

    audio.onpause = async () => {
        playerButton.textContent = '▶️';
        await storage.setSession({ [sessionKey]: audio.currentTime });

        // Perform a final progress calculation on pause to "set" the state
        const freshInstance = await storage.getPacketInstance(instance.instanceId);
        if (!freshInstance) return;

        if (!audio.duration || isNaN(audio.duration)) return;

        const { progressPercentage } = calculateInstanceProgress(freshInstance, { [contentItem.pageId]: audio.currentTime / audio.duration });
        const progressBar = document.querySelector('#detail-progress-container .progress-bar');
        if (progressBar) {
            progressBar.style.width = `${progressPercentage}%`;
        }
    };

    audio.ontimeupdate = async () => {
        if (!audio.duration || isNaN(audio.duration)) return;
        
        const freshInstance = await storage.getPacketInstance(instance.instanceId);
        if (!freshInstance) return;

        const percentage = (audio.currentTime / audio.duration) * 100;
        playerButton.style.setProperty('--p', percentage);
        const { progressPercentage } = calculateInstanceProgress(freshInstance, { [contentItem.pageId]: percentage / 100 });
        const progressBar = document.querySelector('#detail-progress-container .progress-bar');
        if (progressBar) {
            progressBar.style.width = `${progressPercentage}%`;
        }
    };

    audio.onended = async () => {
        playerButton.textContent = '▶️';
        playerButton.style.setProperty('--p', 100);
        storage.removeSession(sessionKey);
        await sendMessageToBackground({
            action: 'media_playback_complete',
            data: {
                instanceId: instance.instanceId,
                pageId: contentItem.pageId
            }
        });
    };
    
    audio.onloadedmetadata = async () => {
        const sessionData = await storage.getSession(sessionKey);
        const savedTime = sessionData[sessionKey];
        if (savedTime && isFinite(savedTime)) {
            audio.currentTime = savedTime;
        }
        audio.play();
    };

    // If audio is already loaded, check session and play. Otherwise, onloadedmetadata will handle it.
    if (audio.readyState >= 1) { // HAVE_METADATA
         const sessionData = await storage.getSession(sessionKey);
         const savedTime = sessionData[sessionKey];
         if (savedTime && isFinite(savedTime)) {
             audio.currentTime = savedTime;
         }
         audio.play();
    }
}