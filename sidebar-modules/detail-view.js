// ext/sidebar-modules/detail-view.js
// Manages the packet detail view, including rendering content cards and progress.
// REVISED: The card click handler now immediately adds an 'opening' class to prevent
// rapid clicks from creating duplicate tabs, fixing a critical race condition.

import { domRefs } from './dom-references.js';
import { logger, storage, packetUtils, indexedDbStorage, sanitizeForFileName } from '../utils.js';

// --- Module-specific State & Dependencies ---
let isDisplayingPacketContent = false;
let queuedDisplayRequest = null;
const audioDataCache = new Map();
let saveStateDebounceTimer = null; // Timer for debounced state saving
let currentPlayingUrl = null; // Track which media item is active in this view
let sendMessageToBackground;
let navigateTo;
let openUrl;


/**
 * Injects dependencies from the main sidebar module.
 * @param {object} dependencies - The dependencies to inject.
 */
export function init(dependencies) {
    sendMessageToBackground = dependencies.sendMessageToBackground;
    navigateTo = dependencies.navigateTo;
    openUrl = dependencies.openUrl;
}


/**
 * Clears the internal state of the detail view.
 * This is called when the currently viewed packet is deleted.
 */
export function clearCurrentDetailView() {
    logger.log("DetailView", "Clearing internal state for deleted packet.");
    currentPlayingUrl = null;
    clearTimeout(saveStateDebounceTimer);
    saveStateDebounceTimer = null;
}

// --- UI update handler called from sidebar.js ---
export function updatePlaybackUI(state, instance) {
    if (!instance || !domRefs.packetDetailView) return;

    currentPlayingUrl = state.isPlaying ? state.url : null;

    // Update play/pause icon on all media cards
    const allMediaCards = domRefs.packetDetailView.querySelectorAll('.card.media');
    allMediaCards.forEach(card => {
        const cardUrl = card.dataset.url;
        const isPlayingThisCard = state.isPlaying && state.url === cardUrl;
        card.classList.toggle('playing', isPlayingThisCard);
    });

    // Update waveform for the active track
    if (state.url) {
        redrawAllVisibleWaveforms(state, instance);
    }
}


// --- Debounced Save Function ---
function requestDebouncedStateSave(instance) {
    clearTimeout(saveStateDebounceTimer);
    saveStateDebounceTimer = setTimeout(async () => {
        if (instance) {
            logger.log("DetailView:Debounce", "Saving packet instance state after delay.", { id: instance.instanceId });
            await storage.savePacketInstance(instance);
        }
    }, 1500); // 1.5 second delay
}

// --- START OF FIX: Waveform Performance Optimization ---

/**
 * Calculates the bar heights for a waveform from audio samples.
 * This is the expensive operation that should only be run once per audio track.
 * @param {Float32Array} audioSamples - The raw audio sample data.
 * @param {number} canvasWidth - The width of the canvas to calculate for.
 * @returns {number[]} An array of bar heights normalized from 0 to 1.
 */
function calculateWaveformBars(audioSamples, canvasWidth) {
    const barWidth = 2;
    const barGap = 1;
    const numBars = Math.floor(canvasWidth / (barWidth + barGap));
    const samplesPerBar = Math.floor(audioSamples.length / numBars);
    const barHeights = [];

    for (let i = 0; i < numBars; i++) {
        const start = i * samplesPerBar;
        let max = 0;
        for (let j = 0; j < samplesPerBar; j++) {
            const sample = Math.abs(audioSamples[start + j]);
            if (sample > max) {
                max = sample;
            }
        }
        barHeights.push(max);
    }
    return barHeights;
}


/**
 * Draws a waveform on a canvas using pre-calculated bar heights.
 * This is the cheap operation that runs on every time update.
 * @param {HTMLCanvasElement} canvas - The canvas element to draw on.
 * @param {object} options - Drawing options.
 */
function drawWaveform(canvas, options) {
    const { barHeights, accentColor, playedColor, currentTime, audioDuration } = options;
    const dpr = window.devicePixelRatio || 1;
    const canvasWidth = canvas.clientWidth;
    const canvasHeight = canvas.clientHeight;

    canvas.width = canvasWidth * dpr;
    canvas.height = canvasHeight * dpr;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    if (!barHeights || barHeights.length === 0) return;

    const barWidth = 2;
    const barGap = 1;
    const numBars = barHeights.length;
    const timePerBar = audioDuration / numBars;

    for (let i = 0; i < numBars; i++) {
        const barStartTime = i * timePerBar;
        const isPlayed = barStartTime < currentTime;
        ctx.fillStyle = isPlayed ? playedColor : accentColor;

        const barHeight = Math.max(1, barHeights[i] * canvasHeight * 1.8);
        const y = (canvasHeight - barHeight) / 2;
        ctx.fillRect(i * (barWidth + barGap), y, barWidth, barHeight);
    }
}
// --- END OF FIX ---


function drawLinkMarkers(markerContainer, options) {
    const { moments, audioDuration, visitedUrlsSet, linkMarkersEnabled } = options;
    markerContainer.innerHTML = ''; // Clear existing markers

    if (!moments || moments.length === 0) {
        return;
    }

    moments.forEach(moment => {
        if (!linkMarkersEnabled || moment.type !== 'mediaTimestamp') {
            return;
        }
        const marker = document.createElement('div');
        marker.className = 'waveform-link-marker';
        
        const percentage = (moment.timestamp / audioDuration) * 100;
        marker.style.left = `${percentage}%`;

        // This part needs adaptation if we want to show 'visited' markers
        // based on the moments system. For now, it's simplified.
        markerContainer.appendChild(marker);
    });
}


// --- Function to redraw waveforms on state update ---
async function redrawAllVisibleWaveforms(playbackState = {}, instance) {
    if (!instance || !domRefs.packetDetailView) return;

    const mediaCards = domRefs.packetDetailView.querySelectorAll('.card.media');
    if (mediaCards.length === 0) return;
    
    const settings = await storage.getSettings();
    const colorOptions = {
        accentColor: getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-accent').trim(),
        playedColor: getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-progress-fill').trim(),
        linkMarkersEnabled: settings.waveformLinkMarkersEnabled,
        visitedUrlsSet: new Set(instance.visitedUrls || []),
    };

    for (const card of mediaCards) {
        const url = card.dataset.url;
        const lrl = card.dataset.lrl;
        const canvas = card.querySelector('.waveform-canvas');
        const markerContainer = card.querySelector('.waveform-marker-container');
        const contentItem = instance.contents.find(item => item.url === url);
        const audioCacheKey = `${instance.instanceId}::${url}`;
        
        const cachedAudioData = audioDataCache.get(audioCacheKey);
        if (!cachedAudioData || !cachedAudioData.barHeights) continue; // Check for barHeights
        
        const { barHeights, duration: cachedDuration } = cachedAudioData;

        if (canvas && contentItem && barHeights) {
            const isTheActiveTrack = playbackState.url === url;
            const currentTime = isTheActiveTrack ? (playbackState.currentTime || 0) : (contentItem.currentTime || 0);
            const audioDuration = isTheActiveTrack && playbackState.duration > 0 ? playbackState.duration : cachedDuration;
            
            drawWaveform(canvas, {
                ...colorOptions,
                barHeights,
                currentTime,
                audioDuration,
            });

            const relevantMoments = (instance.moments || []).filter(m => m.sourceUrl === lrl);
            
            drawLinkMarkers(markerContainer, {
                ...colorOptions,
                moments: relevantMoments,
                audioDuration
            });
        }
    }
}

export async function redrawSingleWaveform(lrl) {
    const card = domRefs.packetDetailView.querySelector(`.card.media[data-lrl="${lrl}"]`);
    if (!card) return;

    const canvas = card.querySelector('.waveform-canvas');
    const instanceId = card.closest('#detail-cards-container').dataset.instanceId;

    if (!canvas || !instanceId) return;

    const waveformContainer = card.querySelector('.media-waveform-container');
    if (waveformContainer) {
        waveformContainer.classList.remove('loading', 'needs-download');
        const downloadIcon = waveformContainer.querySelector('.download-icon');
        if (downloadIcon) downloadIcon.remove();
    }

    try {
        const indexedDbKey = sanitizeForFileName(lrl);
        const audioContent = await indexedDbStorage.getGeneratedContent(instanceId, indexedDbKey);
        
        if (audioContent && audioContent[0]?.content) {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const audioData = audioContent[0].content;
            const decodedData = await audioContext.decodeAudioData(audioData.slice(0));

            const barHeights = calculateWaveformBars(decodedData.getChannelData(0), canvas.clientWidth);
            audioDataCache.set(`${instanceId}::${card.dataset.url}`, {
                barHeights: barHeights,
                duration: decodedData.duration
            });

            const currentState = await sendMessageToBackground({ action: 'get_playback_state' });
            const instance = await storage.getPacketInstance(instanceId);
            await redrawAllVisibleWaveforms(currentState, instance);
        }
    } catch (err) {
        logger.error("DetailView:redrawSingleWaveform", "Failed to draw newly cached waveform", err);
    }
}

export function updateSingleCardToCached(lrl) {
    const card = domRefs.packetDetailView.querySelector(`.card[data-lrl="${lrl}"]`);
    if (card) {
        const cardIconContainer = card.querySelector('.card-icon-container');
        if (cardIconContainer) {
            cardIconContainer.classList.remove('loading', 'needs-download');
            const downloadIcon = cardIconContainer.querySelector('.download-icon');
            if (downloadIcon) downloadIcon.remove();
            card.classList.add('clickable');
            
            const instanceId = card.closest('#detail-cards-container').dataset.instanceId;
            const url = card.dataset.url;
            card.addEventListener('click', (e) => {
                if (card.classList.contains('opening')) {
                    return;
                }
                card.classList.add('opening');
                setTimeout(() => card.classList.remove('opening'), 2000);

                if (typeof openUrl === 'function') {
                    openUrl(url, instanceId);
                }
            });
        }
    }
}


// --- Main Rendering Function ---
export async function displayPacketContent(instance, browserState, canonicalPacketUrl) {
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
    
    try {
        const isAlreadyRendered = container.querySelector(`#detail-cards-container[data-instance-id="${instance.instanceId}"]`);
        const { progressPercentage, visitedCount, totalCount } = packetUtils.calculateInstanceProgress(instance);

        if (isAlreadyRendered) {
            updateCardVisibility(instance);
            updateActiveCardHighlight(canonicalPacketUrl);
            
            const progressBar = domRefs.detailProgressContainer?.querySelector('.progress-bar');
            if (progressBar) progressBar.style.width = `${progressPercentage}%`;
            
            const progressBarContainer = domRefs.detailProgressContainer?.querySelector('.progress-bar-container');
            if (progressBarContainer) progressBarContainer.title = `${visitedCount}/${totalCount} - ${progressPercentage}% Complete`;
            
            const oldActionButtonContainer = document.getElementById('detail-action-button-container');
            const newActionButtonContainer = await createActionButtons(instance, browserState);
            if (oldActionButtonContainer) {
                oldActionButtonContainer.replaceWith(newActionButtonContainer);
            }
            
            await redrawAllVisibleWaveforms(currentState, instance);

        } else {
            const colorName = packetUtils.getColorForTopic(instance.title);
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
            updatePlaybackUI(currentState, instance);
            
            const mediaCards = container.querySelectorAll('.card.media');
            for (const mediaCard of mediaCards) {
                const url = mediaCard.dataset.url;
                const lrl = mediaCard.dataset.lrl;
                const canvas = mediaCard.querySelector('.waveform-canvas');
                const waveformContainer = mediaCard.querySelector('.media-waveform-container');

                if (lrl && canvas && waveformContainer) {
                    const indexedDbKey = sanitizeForFileName(lrl);
                    const audioContent = await indexedDbStorage.getGeneratedContent(instance.instanceId, indexedDbKey);
                    
                    if (audioContent && audioContent[0]?.content) {
                        try {
                            const audioData = audioContent[0].content;
                            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                            const decodedData = await audioContext.decodeAudioData(audioData.slice(0));
                            
                            const barHeights = calculateWaveformBars(decodedData.getChannelData(0), canvas.clientWidth);
                            audioDataCache.set(`${instance.instanceId}::${url}`, {
                                barHeights: barHeights,
                                duration: decodedData.duration
                            });
                            
                            redrawAllVisibleWaveforms(currentState, instance);

                        } catch (err) {
                            logger.error("DetailView", "Failed to draw initial waveform post-render", err);
                        }
                    } else {
                        // Media is not cached, show placeholder.
                        waveformContainer.classList.add('needs-download');
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


/**
 * A lightweight function to update only the visibility and visited status of cards.
 * Avoids a full re-render.
 * @param {object} instance - The latest packet instance data.
 */
export function updateCardVisibility(instance) {
    if (!domRefs.detailCardsContainer || !instance) return;
    
    const visitedUrlsSet = new Set(instance.visitedUrls || []);

    domRefs.detailCardsContainer.querySelectorAll('.card').forEach(card => {
        const cardUrl = card.dataset.url;
        const isVisited = cardUrl && visitedUrlsSet.has(cardUrl);
        card.classList.toggle('visited', isVisited);

        const momentIndices = card.dataset.momentIndices ? JSON.parse(card.dataset.momentIndices) : [];
        if (momentIndices.length > 0) {
            const isRevealed = momentIndices.some(index => instance.momentsTripped && instance.momentsTripped[index] === 1);
            
            const wasHidden = card.classList.contains('hidden-by-rule');
            if (isRevealed && wasHidden) {
                logger.log('CardLogger:Reveal', `Revealing card: "${card.querySelector('.card-title')?.textContent.trim()}"`, {
                    momentIndices: momentIndices,
                    momentsTrippedState: instance.momentsTripped
                });
            }
            
            card.classList.toggle('hidden-by-rule', !isRevealed);
        }
    });
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
    const { progressPercentage, visitedCount, totalCount } = packetUtils.calculateInstanceProgress(instance);
    const progressWrapper = document.createElement('div');
    progressWrapper.id = 'detail-progress-container';
    progressWrapper.innerHTML = `<div class="progress-bar-container" title="${visitedCount}/${totalCount} - ${progressPercentage}% Complete"><div class="progress-bar" style="width: ${progressPercentage}%"></div></div>`;
    domRefs.detailProgressContainer = progressWrapper;
    return progressWrapper;
}

async function createActionButtons(instance, browserState) {
    const actionButtonContainer = document.createElement('div');
    actionButtonContainer.id = 'detail-action-button-container';

    const isCompleted = await packetUtils.isPacketInstanceCompleted(instance);
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
    
    if (instance.contents && instance.contents.length > 0) {
        const cardPromises = instance.contents.map(item => createContentCard(item, instance));
        const cards = await Promise.all(cardPromises);
        cards.forEach(card => {
            if (card) cardsWrapper.appendChild(card);
        });
    } else {
        cardsWrapper.innerHTML = '<div class="empty-state">This packet has no content items.</div>';
    }

    domRefs.detailCardsContainer = cardsWrapper;
    return cardsWrapper;
}

async function createContentCard(contentItem, instance) {
    if (!contentItem || !contentItem.format) return null;

    const card = document.createElement('div');
    card.className = 'card';
    const { url, lrl, title = 'Untitled', context = '', format, origin } = contentItem;

    if (url) card.dataset.url = url;
    if (lrl) card.dataset.lrl = lrl;

    let isClickable = (origin === 'external') || (origin === 'internal' && contentItem.published);
    let needsDownload = false;

    if (format === 'html') {
        let iconHTML = origin === 'external' ? '🔗' : '📄';
        let displayUrl = '';
        if (origin === 'external') {
            try { displayUrl = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { displayUrl = url || '(URL missing)'; }
        } else {
            displayUrl = contentItem.published ? title : '(Not Published)';
        }
        
        let iconContainerHTML = `<div class="card-icon">${iconHTML}</div>`;

        if (origin === 'internal' && contentItem.cacheable) {
            isClickable = true;
        }
        
        card.innerHTML = `${iconContainerHTML}<div class="card-text"><div class="card-title">${title}</div><div class="card-url">${displayUrl}</div>${context ? `<div class="card-relevance">${context}</div>` : ''}</div>`;
    } else if (format === 'audio') {
        card.classList.add('media');
        card.innerHTML = `
            <div class="media-waveform-container">
                 <div class="download-icon"></div>
                 <canvas class="waveform-canvas"></canvas>
                 <div class="waveform-marker-container"></div>
            </div>`;
    }
    
    if (!isClickable) {
        card.style.opacity = '0.7';
    }

    const visitedUrlsSet = new Set(instance.visitedUrls || []);
    const isVisited = url && visitedUrlsSet.has(url);

    if (isVisited) {
        card.classList.add('visited');
    }
    
    if (!instance.sourceContent) {
        instance.sourceContent = instance.contents; // Fallback for older instances
    }

    const imageItem = instance.sourceContent.find(item => {
        if (origin === 'external') {
            return item.url === url;
        } else { // 'internal'
            return item.lrl === lrl;
        }
    }) || contentItem;
    if (!imageItem) {
        logger.error("DetailView", "Could not find matching image item for instance item", { contentItem });
        return card; // Return a partially rendered card to prevent a crash
    }
    
    const momentIndices = Array.isArray(contentItem.revealedByMoments) ? contentItem.revealedByMoments : [];

    if (momentIndices.length > 0) {
        card.dataset.momentIndices = JSON.stringify(momentIndices);
        const isRevealed = momentIndices.some(index => instance.momentsTripped && instance.momentsTripped[index] === 1);
        if (!isRevealed) {
            card.classList.add('hidden-by-rule');
        }
    }

    if (isClickable) {
        card.classList.add('clickable');
        if (format === 'audio') {
            playMediaInCard(card, contentItem, instance);
        } else {
            card.addEventListener('click', (e) => {
                if (card.classList.contains('opening')) {
                    return;
                }
                card.classList.add('opening');
                setTimeout(() => card.classList.remove('opening'), 2000);

                if (typeof openUrl === 'function') {
                    openUrl(url, instance.instanceId);
                }
            });
        }
    } else if (card.classList.contains('needs-download')) {
        card.addEventListener('click', () => {
            const cardIconContainer = card.querySelector('.card-icon-container');
            if (cardIconContainer && cardIconContainer.classList.contains('needs-download')) {
                cardIconContainer.classList.remove('needs-download');
                cardIconContainer.classList.add('loading');
                sendMessageToBackground({
                    action: 'ensure_html_is_cached',
                    data: { instanceId: instance.instanceId, url: contentItem.url, lrl: contentItem.lrl }
                });
            }
        });
    }

    return card;
}

// --- UI Updates ---

export function updateActiveCardHighlight(canonicalPacketUrl) {
    const cardsContainer = domRefs.detailCardsContainer;
    if (!cardsContainer) return;

    let activeCardElement = null;
    cardsContainer.querySelectorAll('.card').forEach(card => {
        let cardUrl = card.dataset.url;
        try {
            if (cardUrl) cardUrl = decodeURIComponent(cardUrl);
        } catch (e) { /* ignore invalid url */ }
        
        let packetUrl = canonicalPacketUrl;
        try {
            if (packetUrl) packetUrl = decodeURIComponent(packetUrl);
        } catch (e) { /* ignore invalid url */ }

        const isActive = (packetUrl && cardUrl === packetUrl);
        
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
        action: 'request_playback_action',
        data: { intent: 'stop' }
    });
    
    clearCurrentDetailView();

    if (typeof navigateTo === 'function') {
        navigateTo('root');
    }
    
    sendMessageToBackground({
        action: 'remove_tab_groups',
        data: { groupIds: [tabGroupId] }
    }).catch(err => {
        logger.error("DetailView", `Error sending close group message: ${err.message}`);
    });
}
export async function stopAndClearActiveAudio() {
    sendMessageToBackground({
        action: 'request_playback_action',
        data: { intent: 'stop' }
    });
}

export function stopAudioIfPacketDeleted(deletedPacketId) {
    const playingCards = document.querySelectorAll('.card.media.playing');
    playingCards.forEach(card => card.classList.remove('playing'));
}

async function playMediaInCard(card, contentItem, instance) {
    card.addEventListener('click', () => {
        const waveformContainer = card.querySelector('.media-waveform-container');

        if (waveformContainer && waveformContainer.classList.contains('needs-download')) {
            waveformContainer.classList.remove('needs-download');
            waveformContainer.classList.add('loading');
            sendMessageToBackground({
                action: 'ensure_media_is_cached',
                data: { instanceId: instance.instanceId, url: contentItem.url, lrl: contentItem.lrl }
            });
            return; // Don't try to play yet, wait for cache to populate.
        }

        const isThisCardPlaying = currentPlayingUrl === contentItem.url;

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
                    url: contentItem.url,
                    lrl: contentItem.lrl // Pass the LRL for DB lookup
                }
            });
        }
    });
}