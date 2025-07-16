// ext/sidebar-modules/detail-view.js
// Manages the packet detail view, including rendering content cards and progress.

import { domRefs } from './dom-references.js';
import { logger, storage, packetUtils, indexedDbStorage } from '../utils.js';
import { calculateInstanceProgress } from './root-view.js'; // We can reuse this from the root view module

// --- Module-specific State & Dependencies ---
let isDisplayingPacketContent = false;
let queuedDisplayRequest = null;
let activeAudioElement = null;
const audioDataCache = new Map(); // Cache decoded audio data
let currentDetailInstance = null; // Module-level reference to the current instance

// Functions to be imported from the new, lean sidebar.js
let sendMessageToBackground;

/**
 * Injects dependencies from the main sidebar module.
 * @param {object} dependencies - The dependencies to inject.
 */
export function init(dependencies) {
    sendMessageToBackground = dependencies.sendMessageToBackground;
}

// --- Waveform Generation and Drawing ---

/**
 * Draws a waveform on a canvas based on audio data, current time, and link timestamps.
 * @param {HTMLCanvasElement} canvas - The canvas element to draw on.
 * @param {Float32Array} audioSamples - The decoded audio sample data.
 * @param {object} options - Drawing options.
 * @param {string} options.accentColor - Color for unplayed bars.
 * @param {string} options.playedColor - Color for played bars.
 * @param {string} options.linkColor - Color for bars where a link starts.
 * @param {number} options.currentTime - The current playback time in seconds.
 * @param {Array<object>} options.timestamps - Array of link timestamp objects.
 * @param {number} options.audioDuration - Total duration of the audio.
 */
function drawWaveform(canvas, audioSamples, options) {
    const { accentColor, playedColor, linkColor, currentTime, timestamps, audioDuration } = options;
    const dpr = window.devicePixelRatio || 1;
    const canvasWidth = canvas.clientWidth;
    const canvasHeight = canvas.clientHeight;

    canvas.width = canvasWidth * dpr;
    canvas.height = canvasHeight * dpr;
    
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    const barWidth = 2;
    const barGap = 1;
    const numBars = Math.floor(canvasWidth / (barWidth + barGap));
    const samplesPerBar = Math.floor(audioSamples.length / numBars);
    const timePerBar = audioDuration / numBars;

    const linkStartTimes = timestamps.map(t => t.startTime);

    for (let i = 0; i < numBars; i++) {
        const barStartTime = i * timePerBar;
        const isPlayed = barStartTime < currentTime;
        const isLinkStart = linkStartTimes.some(lt => barStartTime >= lt && barStartTime < lt + timePerBar);

        if (isLinkStart) {
            ctx.fillStyle = linkColor;
        } else if (isPlayed) {
            ctx.fillStyle = playedColor;
        } else {
            ctx.fillStyle = accentColor;
        }

        const start = i * samplesPerBar;
        let max = 0;
        for (let j = 0; j < samplesPerBar; j++) {
            const sample = Math.abs(audioSamples[start + j]);
            if (sample > max) {
                max = sample;
            }
        }
        // --- CHANGE: Increased the multiplier from 1.2 to 1.8 to make the waveform taller ---
        const barHeight = Math.max(1, max * canvasHeight * 1.8);
        const y = (canvasHeight - barHeight) / 2;
        ctx.fillRect(i * (barWidth + barGap), y, barWidth, barHeight);
    }
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

    if (activeAudioElement && activeAudioElement.dataset.instanceId !== instance?.instanceId) {
        pauseAndClearActiveAudio();
    }
    
    currentDetailInstance = instance; // Always update the module-level instance

    try {
        const isAlreadyRendered = container.querySelector(`#detail-cards-container[data-instance-id="${instance.instanceId}"]`);

        if (isAlreadyRendered) {
            const visitedUrlsSet = new Set(instance.visitedUrls || []);
            const visitedGeneratedIds = new Set(instance.visitedGeneratedPageIds || []);
            container.querySelectorAll('.card').forEach(card => {
                const isVisited = (card.dataset.pageId && visitedGeneratedIds.has(card.dataset.pageId)) ||
                                  (card.dataset.url && visitedUrlsSet.has(card.dataset.url));
                card.classList.toggle('visited', isVisited);
            });
            updateActiveCardHighlight(currentPacketUrl);

            // Always update the progress bar on any instance update
            const { progressPercentage } = calculateInstanceProgress(instance);
            const progressBar = domRefs.detailProgressContainer?.querySelector('.progress-bar');
            if (progressBar) {
                progressBar.style.width = `${progressPercentage}%`;
            }
            const progressBarContainer = domRefs.detailProgressContainer?.querySelector('.progress-bar-container');
            if (progressBarContainer) {
                progressBarContainer.title = `${progressPercentage}% Complete`;
            }

        } else {
            // --- Full render path (for initial load) ---
            const colorName = packetUtils.getColorForTopic(instance.topic);
            const colors = { grey: { accent: '#90a4ae', progress: '#546e7a', link: '#FFFFFF' }, blue: { accent: '#64b5f6', progress: '#1976d2', link: '#FFFFFF' }, red: { accent: '#e57373', progress: '#d32f2f', link: '#FFFFFF' }, yellow: { accent: '#fff176', progress: '#fbc02d', link: '#000000' }, green: { accent: '#81c784', progress: '#388e3c', link: '#FFFFFF' }, pink: { accent: '#f06292', progress: '#c2185b', link: '#FFFFFF' }, purple: { accent: '#ba68c8', progress: '#7b1fa2', link: '#FFFFFF' }, cyan: { accent: '#4dd0e1', progress: '#0097a7', link: '#FFFFFF' }, orange: { accent: '#ffb74d', progress: '#f57c00', link: '#FFFFFF' } }[colorName] || { accent: '#90a4ae', progress: '#546e7a', link: '#FFFFFF' };
            
            container.style.setProperty('--packet-color-accent', colors.accent);
            container.style.setProperty('--packet-color-progress-fill', colors.progress);
            container.style.setProperty('--packet-color-link-marker', colors.link);
            
            const fragment = document.createDocumentFragment();
            fragment.appendChild(createProgressSection(instance));
            fragment.appendChild(await createActionButtons(instance));
            const cardsWrapper = await createCardsSection(instance);
            cardsWrapper.dataset.instanceId = instance.instanceId;
            fragment.appendChild(cardsWrapper);

            container.innerHTML = '';
            container.appendChild(fragment);

            // Draw waveforms after the cards are in the DOM
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
                            const decodedData = await audioContext.decodeAudioData(audioData.slice(0)); 
                            const samples = decodedData.getChannelData(0);
                            audioDataCache.set(`${instance.imageId}::${contentItem.pageId}`, samples);
                            
                            const colorOptions = {
                                accentColor: getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-accent').trim(),
                                playedColor: getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-progress-fill').trim(),
                                linkColor: getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-link-marker').trim(),
                                timestamps: contentItem.timestamps || [],
                                currentTime: 0,
                                audioDuration: decodedData.duration
                            };
                            drawWaveform(canvas, samples, colorOptions);
                        } catch (err) {
                            logger.error("DetailView", "Failed to draw initial waveform post-render", err);
                        }
                    }
                }
            }

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

async function createCardsSection(instance) {
    const cardsWrapper = document.createElement('div');
    cardsWrapper.id = 'detail-cards-container';
    const visitedUrlsSet = new Set(instance.visitedUrls || []);
    const visitedGeneratedIds = new Set(instance.visitedGeneratedPageIds || []);

    if (instance.contents && instance.contents.length > 0) {
        const cardPromises = instance.contents.map(item =>
            createContentCard(item, visitedUrlsSet, visitedGeneratedIds, instance)
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

async function createContentCard(contentItem, visitedUrlsSet, visitedGeneratedIds, instance) {
    if (!contentItem || !contentItem.type) return null;

    if (contentItem.type === 'alternative') {
        const settings = await storage.getSettings();
        const preferAudio = settings.elevenlabsApiKey && contentItem.alternatives.some(a => a.type === 'media');
        
        const chosenItem = preferAudio 
            ? contentItem.alternatives.find(a => a.type === 'media')
            : contentItem.alternatives.find(a => a.type === 'generated');

        return chosenItem ? createContentCard(chosenItem, visitedUrlsSet, visitedGeneratedIds, instance) : null;
    }


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
        card.innerHTML = `<div class="card-icon">${iconHTML}</div><div class="card-text"><div class="card-title">${title}</div><div class="card-url">${displayUrl}</div>${relevance ? `<div class="card-relevance">${relevance}</div>` : ''}</div>`;

    } else if (type === 'generated') {
        iconHTML = '📄';
        if (urlToOpen && contentItem.published) {
            isClickable = true;
            isVisited = visitedGeneratedIds.has(contentItem.pageId);
            displayUrl = title; 
        } else {
            card.style.opacity = '0.7';
            displayUrl = contentItem.published ? '(Error: URL missing)' : '(Not Published)';
        }
        card.innerHTML = `<div class="card-icon">${iconHTML}</div><div class="card-text"><div class="card-title">${title}</div><div class="card-url">${displayUrl}</div>${relevance ? `<div class="card-relevance">${relevance}</div>` : ''}</div>`;

    } else if (type === 'media') {
        card.classList.add('media');
        if (contentItem.published) {
            isClickable = true;
            isVisited = visitedGeneratedIds.has(contentItem.pageId);
        } else {
            card.style.opacity = '0.7';
        }
        
        card.innerHTML = `
            <div class="media-waveform-container">
                 <canvas class="waveform-canvas" style="width: 100%; height: 100%;"></canvas>
            </div>
        `;
    }


    if (isClickable) {
        card.classList.add('clickable');
        if (type === 'media') {
            playMediaInCard(card, contentItem, instance);
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

export function pauseAndClearActiveAudio() {
    if (activeAudioElement) {
        logger.log('DetailView', 'Pausing and clearing active audio element.');
        activeAudioElement.pause();
        activeAudioElement.src = ''; 
        activeAudioElement.load(); 
        activeAudioElement = null;
    }
}

export function stopAudioIfPacketDeleted(deletedPacketId) {
    if (activeAudioElement && activeAudioElement.dataset.instanceId === deletedPacketId) {
        logger.log('DetailView', `Stopping audio because its packet (${deletedPacketId}) was deleted.`);
        pauseAndClearActiveAudio();
    }
}


async function playMediaInCard(card, contentItem, instance) {
    const canvas = card.querySelector('.waveform-canvas');
    if (!canvas) return;

    const audioCacheKey = `${instance.imageId}::${contentItem.pageId}`;
    
    const initializeAndPlayAudio = async () => {
        if (activeAudioElement && activeAudioElement.dataset.pageId !== contentItem.pageId) {
            pauseAndClearActiveAudio();
        }
        
        card.classList.add('playing');

        if (!activeAudioElement || activeAudioElement.dataset.pageId !== contentItem.pageId) {
            const audio = new Audio();
            audio.dataset.pageId = contentItem.pageId;
            audio.dataset.instanceId = instance.instanceId;
            activeAudioElement = audio;
            
            const cachedAudio = await indexedDbStorage.getGeneratedContent(instance.imageId, contentItem.pageId);
            if (cachedAudio && cachedAudio[0]?.content) {
                const blob = new Blob([cachedAudio[0].content], { type: contentItem.mimeType });
                audio.src = URL.createObjectURL(blob);
            } else {
                 logger.error("DetailView", "Could not find cached audio data to play.", {key: audioCacheKey});
                 return;
            }
        }
        
        const audio = activeAudioElement;
        const audioSamples = audioDataCache.get(audioCacheKey);
        const sessionKey = `audio_progress_${instance.instanceId}_${contentItem.pageId}`;
        const colorOptions = {
             accentColor: getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-accent').trim(),
             playedColor: getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-progress-fill').trim(),
             linkColor: getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-link-marker').trim(),
             timestamps: contentItem.timestamps || []
        };
        
        audio.onplay = () => { card.classList.add('playing'); };
        audio.onpause = async () => { card.classList.remove('playing'); await storage.setSession({ [sessionKey]: audio.currentTime }); };
        
        audio.ontimeupdate = async () => {
             if (!audio.duration || isNaN(audio.duration) || !audioSamples) return;
             
             drawWaveform(canvas, audioSamples, { ...colorOptions, currentTime: audio.currentTime, audioDuration: audio.duration });
             
             if (!currentDetailInstance) return;

             let currentActiveLinkUrl = null;
             if (contentItem.timestamps) {
                 for (const ts of contentItem.timestamps) {
                     if (audio.currentTime >= ts.startTime && audio.currentTime < ts.endTime) {
                         currentActiveLinkUrl = ts.url;
                         break;
                     }
                 }
             }
 
             domRefs.detailCardsContainer.querySelectorAll('.card.link-mentioned').forEach(c => c.classList.remove('link-mentioned'));
 
             if (currentActiveLinkUrl) {
                 const targetCard = Array.from(domRefs.detailCardsContainer.querySelectorAll('.card')).find(c => {
                     if (c.dataset.url === currentActiveLinkUrl) return true;
                     const linkedContentItem = currentDetailInstance.contents.find(item => item.url === currentActiveLinkUrl);
                     return linkedContentItem && linkedContentItem.pageId && c.dataset.pageId === linkedContentItem.pageId;
                 });
 
                 if (targetCard) {
                     targetCard.classList.add('link-mentioned');
                     targetCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                 }
             }
        };

        audio.onended = async () => {
            card.classList.remove('playing');
            storage.removeSession(sessionKey);
            await sendMessageToBackground({ action: 'media_playback_complete', data: { instanceId: instance.instanceId, pageId: contentItem.pageId } });
        };
        
        audio.onloadedmetadata = async () => {
            const sessionData = await storage.getSession(sessionKey);
            const savedTime = sessionData[sessionKey];
            if (savedTime && isFinite(savedTime)) audio.currentTime = savedTime;
            audio.play();
        };
        if (audio.readyState >= 1) {
             const sessionData = await storage.getSession(sessionKey);
             const savedTime = sessionData[sessionKey];
             if (savedTime && isFinite(savedTime)) audio.currentTime = savedTime;
             audio.play();
        }
    };
    
    card.addEventListener('click', () => {
        if (activeAudioElement && !activeAudioElement.paused) {
            activeAudioElement.pause();
        } else {
            initializeAndPlayAudio();
        }
    });
}