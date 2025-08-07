// ext/sidebar-modules/detail-view.js
// Manages the packet detail view, including rendering content cards and progress.
// REVISED: The card click handler now immediately adds an 'opening' class to prevent
// rapid clicks from creating duplicate tabs, fixing a critical race condition.

import { domRefs } from './dom-references.js';
import { logger, storage, packetUtils, indexedDbStorage } from '../utils.js';

// --- Module-specific State & Dependencies ---
let isDisplayingPacketContent = false;
let queuedDisplayRequest = null;
const audioDataCache = new Map();
let currentDetailInstance = null;
let saveStateDebounceTimer = null; // Timer for debounced state saving
let currentPlayingPageId = null; // Track which media item is active in this view
let sendMessageToBackground;
// --- START OF THE FIX ---
let navigateTo;
// --- END OF THE FIX ---
let openUrl;


/**
 * Injects dependencies from the main sidebar module.
 * @param {object} dependencies - The dependencies to inject.
 */
export function init(dependencies) {
    sendMessageToBackground = dependencies.sendMessageToBackground;
    // --- START OF THE FIX ---
    navigateTo = dependencies.navigateTo;
    // --- END OF THE FIX ---
    openUrl = dependencies.openUrl;
}


/**
 * Clears the internal state of the detail view.
 * This is called when the currently viewed packet is deleted.
 */
export function clearCurrentDetailView() {
    logger.log("DetailView", "Clearing internal state for deleted packet.");
    currentDetailInstance = null;
    currentPlayingPageId = null;
    clearTimeout(saveStateDebounceTimer);
    saveStateDebounceTimer = null;
}

// --- UI update handler called from sidebar.js ---
export function updatePlaybackUI(state) {
    if (!currentDetailInstance || !domRefs.packetDetailView) return;

    currentPlayingPageId = state.isPlaying ? state.pageId : null;

    // Update play/pause icon on all media cards
    const allMediaCards = domRefs.packetDetailView.querySelectorAll('.card.media');
    allMediaCards.forEach(card => {
        const cardPageId = card.dataset.pageId;
        const isPlayingThisCard = state.isPlaying && state.pageId === cardPageId;
        card.classList.toggle('playing', isPlayingThisCard);
    });

    // Reveal mentioned cards
    if (state.mentionedMediaLinks && state.mentionedMediaLinks.length > 0) {
        const mentionedUrlsSet = new Set(state.mentionedMediaLinks);
        const cards = domRefs.packetDetailView.querySelectorAll('.card[data-url]');

        cards.forEach(card => {
            const url = card.dataset.url;
            const wasHidden = card.classList.contains('hidden-by-rule');

            if (mentionedUrlsSet.has(url)) {
                card.classList.remove('hidden-by-rule');
                if (wasHidden) {
                    const handleTransitionEnd = () => {
                        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        card.removeEventListener('transitionend', handleTransitionEnd);
                    };
                    card.addEventListener('transitionend', handleTransitionEnd, { once: true });

                    // Highlight the newly revealed card
                    card.classList.add('link-mentioned');
                    setTimeout(() => card.classList.remove('link-mentioned'), 2000);
                }
            }
        });
    }

    // Update waveform for the active track
    if (state.pageId) {
        redrawAllVisibleWaveforms(state);
    }
}


// --- Debounced Save Function ---
function requestDebouncedStateSave() {
    clearTimeout(saveStateDebounceTimer);
    saveStateDebounceTimer = setTimeout(async () => {
        if (currentDetailInstance) {
            logger.log("DetailView:Debounce", "Saving packet instance state after delay.", { id: currentDetailInstance.instanceId });
            await storage.savePacketInstance(currentDetailInstance);
        }
    }, 1500); // 1.5 second delay
}

export async function triggerImmediateSave() {
    clearTimeout(saveStateDebounceTimer);
    if (currentDetailInstance) {
        logger.log("DetailView:ImmediateSave", "Persisting state immediately due to navigation or pause.", { id: currentDetailInstance.instanceId });
        await storage.savePacketInstance(currentDetailInstance);
    }
}


// --- Waveform Generation and Drawing ---
async function drawWaveform(canvas, audioSamples, options) {
    const { accentColor, playedColor, currentTime } = options;
    const dpr = window.devicePixelRatio || 1;
    const canvasWidth = canvas.clientWidth;
    const canvasHeight = canvas.clientHeight;

    canvas.width = canvasWidth * dpr;
    canvas.height = canvasHeight * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    if (!audioSamples || audioSamples.length === 0) return;

    const barWidth = 2;
    const barGap = 1;
    const numBars = Math.floor(canvasWidth / (barWidth + barGap));
    const samplesPerBar = Math.floor(audioSamples.length / numBars);
    
    const timePerPixel = options.audioDuration / canvasWidth;


    for (let i = 0; i < numBars; i++) {
        const barStartTime = i * (samplesPerBar / options.audioSampleRate);
        const isPlayed = barStartTime < currentTime;

        ctx.fillStyle = isPlayed ? playedColor : accentColor;

        const start = i * samplesPerBar;
        let max = 0;
        for (let j = 0; j < samplesPerBar; j++) {
            const sample = Math.abs(audioSamples[start + j]);
            if (sample > max) {
                max = sample;
            }
        }
        const barHeight = Math.max(1, max * canvasHeight * 1.8);
        const y = (canvasHeight - barHeight) / 2;
        ctx.fillRect(i * (barWidth + barGap), y, barWidth, barHeight);
    }
    return timePerPixel;
}

function drawLinkMarkers(markerContainer, options) {
    const { timestamps, audioDuration, visitedUrlsSet } = options;
    markerContainer.innerHTML = ''; // Clear existing markers

    if (!options.linkMarkersEnabled || !timestamps || timestamps.length === 0) {
        return;
    }

    const containerWidth = markerContainer.clientWidth;

    timestamps.forEach(ts => {
        const marker = document.createElement('div');
        marker.className = 'waveform-link-marker';
        
        const percentage = (ts.startTime / audioDuration) * 100;
        marker.style.left = `${percentage}%`;

        if (visitedUrlsSet && visitedUrlsSet.has(ts.url)) {
            marker.classList.add('visited');
        }

        markerContainer.appendChild(marker);
    });
}


// --- Function to redraw waveforms on state update ---
async function redrawAllVisibleWaveforms(playbackState = {}) {
    if (!currentDetailInstance || !domRefs.packetDetailView) return;

    const mediaCards = domRefs.packetDetailView.querySelectorAll('.card.media');
    if (mediaCards.length === 0) return;

    const settings = await storage.getSettings();
    const colorOptions = {
        accentColor: getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-accent').trim(),
        playedColor: getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-progress-fill').trim(),
        linkMarkersEnabled: settings.waveformLinkMarkersEnabled,
        visitedUrlsSet: new Set(currentDetailInstance.visitedUrls || [])
    };

    for (const card of mediaCards) {
        const pageId = card.dataset.pageId;
        const canvas = card.querySelector('.waveform-canvas');
        const markerContainer = card.querySelector('.waveform-marker-container');
        const contentItem = currentDetailInstance.contents.find(item => item.pageId === pageId);
        const audioCacheKey = `${currentDetailInstance.imageId}::${pageId}`;
        
        const cachedAudioData = audioDataCache.get(audioCacheKey);
        if (!cachedAudioData) continue;
        const { samples: audioSamples, sampleRate, duration: cachedDuration } = cachedAudioData;

        if (canvas && contentItem && audioSamples) {
            const isTheActiveTrack = playbackState.pageId === pageId;
            const currentTime = isTheActiveTrack ? (playbackState.currentTime || 0) : (contentItem.currentTime || 0);
            const audioDuration = isTheActiveTrack && playbackState.duration > 0 ? playbackState.duration : cachedDuration;
            
            drawWaveform(canvas, audioSamples, {
                ...colorOptions,
                currentTime,
                audioDuration,
                audioSampleRate: sampleRate
            });

            drawLinkMarkers(markerContainer, {
                ...colorOptions,
                timestamps: contentItem.timestamps || [],
                audioDuration
            });
        }
    }
}


// --- Main Rendering Function ---
export async function displayPacketContent(instance, browserState, canonicalPacketUrl) {
    logger.log('DetailView:displayPacketContent', 'CRITICAL LOG: Received instance for display.', {
        instanceId: instance?.instanceId,
        mentionedMediaLinks: instance?.mentionedMediaLinks,
        mentionedLinksLength: instance?.mentionedMediaLinks?.length || 0,
        sourceUrl: canonicalPacketUrl
    });

    const uniqueCallId = Date.now();
    if (isDisplayingPacketContent) {
        queuedDisplayRequest = { instance, browserState, canonicalPacketUrl };
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

    const currentState = await sendMessageToBackground({ action: 'get_playback_state' });
    
    currentDetailInstance = instance;
    if (!Array.isArray(currentDetailInstance.mentionedMediaLinks)) {
        currentDetailInstance.mentionedMediaLinks = [];
    }


    try {
        const isAlreadyRendered = container.querySelector(`#detail-cards-container[data-instance-id="${instance.instanceId}"]`);

        const { progressPercentage } = packetUtils.calculateInstanceProgress(instance);

        if (isAlreadyRendered) {
            // If already rendered, just update the dynamic parts like visited status and active highlight.
            const visitedUrlsSet = new Set(instance.visitedUrls || []);
            const visitedGeneratedIds = new Set(instance.visitedGeneratedPageIds || []);
            const mentionedLinks = new Set(instance.mentionedMediaLinks || []);

            container.querySelectorAll('.card').forEach(card => {
                const isVisited = (card.dataset.pageId && visitedGeneratedIds.has(card.dataset.pageId)) ||
                                  (card.dataset.url && visitedUrlsSet.has(card.dataset.url));
                card.classList.toggle('visited', isVisited);
                const url = card.dataset.url;
                if (url && !isVisited && !card.classList.contains('media')) {
                    const isMentioned = mentionedLinks.has(url);
                    if (isMentioned) {
                        card.classList.remove('hidden-by-rule');
                    }
                }
            });
            updateActiveCardHighlight(canonicalPacketUrl);
            
            const progressBar = domRefs.detailProgressContainer?.querySelector('.progress-bar');
            if (progressBar) progressBar.style.width = `${progressPercentage}%`;
            const progressBarContainer = domRefs.detailProgressContainer?.querySelector('.progress-bar-container');
            if (progressBarContainer) progressBarContainer.title = `${progressPercentage}% Complete`;
            
            const oldActionButtonContainer = document.getElementById('detail-action-button-container');
            const newActionButtonContainer = await createActionButtons(instance, browserState);
            if (oldActionButtonContainer) {
                oldActionButtonContainer.replaceWith(newActionButtonContainer);
            }
            
            await redrawAllVisibleWaveforms(currentState);

        } else {
            // Full re-render if the view is for a new packet.
            const colorName = packetUtils.getColorForTopic(instance.topic);
            const colors = { grey: { accent: '#90a4ae', progress: '#546e7a', link: '#FFFFFF' }, blue: { accent: '#64b5f6', progress: '#1976d2', link: '#FFFFFF' }, red: { accent: '#e57373', progress: '#d32f2f', link: '#FFFFFF' }, yellow: { accent: '#fff176', progress: '#fbc02d', link: '#000000' }, green: { accent: '#81c784', progress: '#388e3c', link: '#FFFFFF' }, pink: { accent: '#f06292', progress: '#c2185b', link: '#FFFFFF' }, purple: { accent: '#ba68c8', progress: '#7b1fa2', link: '#FFFFFF' }, cyan: { accent: '#4dd0e1', progress: '#0097a7', link: '#FFFFFF' }, orange: { accent: '#ffb74d', progress: '#f57c00', link: '#FFFFFF' } }[colorName] || { accent: '#90a4ae', progress: '#546e7a', link: '#FFFFFF' };

            container.style.setProperty('--packet-color-accent', colors.accent);
            container.style.setProperty('--packet-color-progress-fill', colors.progress);
            container.style.setProperty('--packet-color-link-marker', colors.link);

            const fragment = document.createDocumentFragment();
            fragment.appendChild(createProgressSection(instance));
            fragment.appendChild(await createActionButtons(instance, browserState));
            const cardsWrapper = await createCardsSection(instance);
            cardsWrapper.dataset.instanceId = instance.instanceId;
            fragment.appendChild(cardsWrapper);

            container.innerHTML = '';
            container.appendChild(fragment);
            updatePlaybackUI(currentState);
            
            const mediaCards = container.querySelectorAll('.card.media');
            for (const mediaCard of mediaCards) {
                const pageId = mediaCard.dataset.pageId;
                const contentItem = instance.contents.find(item => item.pageId === pageId);
                const canvas = mediaCard.querySelector('.waveform-canvas');

                if (contentItem && canvas) {
                    const audioContent = await indexedDbStorage.getGeneratedContent(instance.imageId, contentItem.pageId);
                    if (audioContent && audioContent[0]?.content) {
                        try {
                            const audioData = audioContent[0].content;
                            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                            const decodedData = await audioContext.decodeAudioData(audioData.slice(0)); // Use slice(0) to create a copy
                            const samples = decodedData.getChannelData(0);
                            
                            audioDataCache.set(`${instance.imageId}::${contentItem.pageId}`, {
                                samples: samples,
                                sampleRate: decodedData.sampleRate,
                                duration: decodedData.duration
                            });
                            
                            redrawAllVisibleWaveforms(currentState);

                        } catch (err) {
                            logger.error("DetailView", "Failed to draw initial waveform post-render", err);
                        }
                    }
                }
            }
            updateActiveCardHighlight(canonicalPacketUrl);
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
        const { instance, browserState, canonicalPacketUrl } = queuedDisplayRequest;
        queuedDisplayRequest = null;
        Promise.resolve().then(() => displayPacketContent(instance, browserState, canonicalPacketUrl));
    }
}

// --- UI Element Creation ---

function createProgressSection(instance) {
    const { progressPercentage } = packetUtils.calculateInstanceProgress(instance);
    const progressWrapper = document.createElement('div');
    progressWrapper.id = 'detail-progress-container';
    progressWrapper.innerHTML = `<div class="progress-bar-container" title="${progressPercentage}% Complete"><div class="progress-bar" style="width: ${progressPercentage}%"></div></div>`;
    domRefs.detailProgressContainer = progressWrapper;
    return progressWrapper;
}

async function createActionButtons(instance, browserState) {
    const actionButtonContainer = document.createElement('div');
    actionButtonContainer.id = 'detail-action-button-container';

    const isCompleted = packetUtils.isPacketInstanceCompleted(instance);
    const tabGroupId = browserState?.tabGroupId;
    let groupHasTabs = false;

    if (tabGroupId && chrome.tabs) {
        try {
            const tabsInGroup = await chrome.tabs.query({ groupId: tabGroupId });
            if (tabsInGroup.length > 0) {
                groupHasTabs = true;
            }
        } catch (e) { /* Group might be gone, which is fine. */ }
    }

    // Only show the button if the packet is complete AND its tab group still has open tabs.
    if (isCompleted && groupHasTabs) {
        const closeGroupBtn = document.createElement('button');
        closeGroupBtn.id = 'detail-close-group-btn';
        closeGroupBtn.textContent = 'Close Tab Group';
        closeGroupBtn.addEventListener('click', () => handleCloseTabGroup(tabGroupId));
        actionButtonContainer.appendChild(closeGroupBtn);
    }

    domRefs.detailActionButtonContainer = actionButtonContainer;
    return actionButtonContainer;
}

async function createCardsSection(instance) {
    const cardsWrapper = document.createElement('div');
    cardsWrapper.id = 'detail-cards-container';
    const visitedUrlsSet = new Set(instance.visitedUrls || []);
    const visitedGeneratedIds = new Set(instance.visitedGeneratedPageIds || []);
    const mentionedLinks = new Set(instance.mentionedMediaLinks || []);

    if (instance.contents && instance.contents.length > 0) {
        const cardPromises = instance.contents.map(item =>
            createContentCard(item, visitedUrlsSet, visitedGeneratedIds, instance, mentionedLinks)
        );

        const cards = await Promise.all(cardPromises);
        cards.forEach(card => {
            if (card) {
                cardsWrapper.appendChild(card);
            }
        });
    } else {
        cardsWrapper.innerHTML = '<div class="empty-state">This packet has no content items.</div>';
    }

    domRefs.detailCardsContainer = cardsWrapper;
    return cardsWrapper;
}

async function createContentCard(contentItem, visitedUrlsSet, visitedGeneratedIds, instance, mentionedLinks) {
    if (!contentItem || !contentItem.type) return null;

    if (contentItem.type === 'alternative') {
        const settings = await storage.getSettings();
        const preferAudio = settings.preferAudio && contentItem.alternatives.some(a => a.type === 'media');

        const chosenItem = preferAudio
            ? contentItem.alternatives.find(a => a.type === 'media')
            : contentItem.alternatives.find(a => a.type === 'generated');

        return chosenItem ? createContentCard(chosenItem, visitedUrlsSet, visitedGeneratedIds, instance, mentionedLinks) : null;
    }


    const card = document.createElement('div');
    card.className = 'card';
    let { url: urlToOpen, title = 'Untitled', relevance = '', type } = contentItem;
    let displayUrl = urlToOpen || '(URL missing)', iconHTML = '?', isClickable = false;

    // Use the canonical URL for the data-url attribute.
    if (contentItem.url) card.dataset.url = contentItem.url;
    if (contentItem.pageId) card.dataset.pageId = contentItem.pageId;

    if (type === 'external') {
        iconHTML = '🔗';
        if (urlToOpen) {
            isClickable = true;
            try { displayUrl = new URL(urlToOpen).hostname.replace(/^www\./, ''); } catch (e) { displayUrl = urlToOpen; }
        }
        card.innerHTML = `<div class="card-icon">${iconHTML}</div><div class="card-text"><div class="card-title">${title}</div><div class="card-url">${displayUrl}</div>${relevance ? `<div class="card-relevance">${relevance}</div>` : ''}</div>`;
    } else if (type === 'generated') {
        iconHTML = '📄';
        if (urlToOpen && contentItem.published) {
            isClickable = true;
            displayUrl = title;
        } else {
            card.style.opacity = '0.7';
            displayUrl = contentItem.published ? '(Error: URL missing)' : '(Not Published)';
        }
        card.innerHTML = `<div class="card-icon">${iconHTML}</div><div class="card-text"><div class="card-title">${title}</div><div class="card-url">${displayUrl}</div>${relevance ? `<div class="card-relevance">${relevance}</div>` : ''}</div>`;
    } else if (type === 'media') {
        card.classList.add('media');
        if (contentItem.published) isClickable = true;
        else card.style.opacity = '0.7';
        
        card.innerHTML = `
            <div class="media-waveform-container">
                 <canvas class="waveform-canvas"></canvas>
                 <div class="waveform-marker-container"></div>
            </div>`;
    }

    let isVisited = false;
    if (visitedGeneratedIds.has(contentItem.pageId)) {
        isVisited = true;
    } else if (contentItem.url && visitedUrlsSet.has(contentItem.url)) {
        isVisited = true;
    } else if (contentItem.type === 'media' && Array.isArray(contentItem.timestamps) && contentItem.timestamps.length > 0) {
        const allLinksMentioned = contentItem.timestamps.every(ts => mentionedLinks.has(ts.url));
        if (allLinksMentioned) {
            isVisited = true;
        }
    }

    const isSummaryPage = contentItem.relevance === 'A summary of the packet contents.';
    const isMentioned = contentItem.url && mentionedLinks.has(contentItem.url);
    
    const hasMedia = instance.contents.some(item => item.type === 'media');

    const isVisible = type === 'media' || isSummaryPage || isVisited || isMentioned || ((type === 'external' || type === 'generated') && !hasMedia);

    if (!isVisible) {
        card.classList.add('hidden-by-rule');
    }
    if (isVisited) {
        card.classList.add('visited');
    }

    if (isClickable) {
        card.classList.add('clickable');
        if (type === 'media') {
            playMediaInCard(card, contentItem, instance);
        } else {
            // --- START OF THE FIX ---
            card.addEventListener('click', (e) => {
                // Prevent rapid clicks from opening multiple tabs
                if (card.classList.contains('opening')) {
                    return;
                }
                card.classList.add('opening');
                // Re-enable the card after 2 seconds to prevent it getting stuck.
                setTimeout(() => card.classList.remove('opening'), 2000);

                if (typeof openUrl === 'function') {
                    openUrl(urlToOpen, instance.instanceId);
                }
            });
            // --- END OF THE FIX ---
        }
    }

    return card;
}

// --- UI Updates ---

export function updateActiveCardHighlight(canonicalPacketUrl) {
    const cardsContainer = domRefs.detailCardsContainer;
    if (!cardsContainer) return;

    let activeCardElement = null;
    cardsContainer.querySelectorAll('.card').forEach(card => {
        const isActive = (canonicalPacketUrl && card.dataset.url === canonicalPacketUrl);
        card.classList.toggle('active', isActive);
        if (isActive) {
            activeCardElement = card;
        }
    });

    if (activeCardElement) {
        activeCardElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

// --- Action Handlers ---

function handleCloseTabGroup(tabGroupId) {
    sendMessageToBackground({
        action: 'remove_tab_groups',
        data: { groupIds: [tabGroupId] }
    }).catch(err => {
        logger.error("DetailView", `Error sending close group message: ${err.message}`);
    });

    // --- START OF THE FIX ---
    // Explicitly navigate the sidebar UI to the root view immediately.
    if (typeof navigateTo === 'function') {
        navigateTo('root');
    }
    // --- END OF THE FIX ---
}
export async function stopAndClearActiveAudio() {
    sendMessageToBackground({
        action: 'request_playback_action',
        data: { intent: 'stop' }
    });
    await triggerImmediateSave();
}

export function stopAudioIfPacketDeleted(deletedPacketId) {
    if (currentDetailInstance && currentDetailInstance.instanceId === deletedPacketId) {
         const playingCards = document.querySelectorAll('.card.media.playing');
         playingCards.forEach(card => card.classList.remove('playing'));
    }
}

async function playMediaInCard(card, contentItem, instance) {
    card.addEventListener('click', () => {
        const isThisCardPlaying = currentPlayingPageId === contentItem.pageId;

        if (isThisCardPlaying) {
            sendMessageToBackground({
                action: 'request_playback_action',
                data: { intent: 'toggle' }
            });
        } else {
            sendMessageToBackground({
                action: 'request_playback_action',
                data: {
                    intent: 'play',
                    instanceId: instance.instanceId,
                    pageId: contentItem.pageId
                }
            });
        }
    });
}