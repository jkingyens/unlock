// ext/sidebar-modules/detail-view.js
// Manages the packet detail view, including rendering content cards and progress.

import { domRefs } from './dom-references.js';
import { logger, storage, packetUtils, indexedDbStorage } from '../utils.js';

// --- Module-specific State & Dependencies ---
let isDisplayingPacketContent = false;
let queuedDisplayRequest = null;
let activeAudioElement = null;
const audioDataCache = new Map();
let currentDetailInstance = null;
let saveStateDebounceTimer = null; // Timer for debounced state saving
let isClearingAudio = false; // "Lock" flag to prevent race conditions

// --- In-memory state for the currently playing audio ---
let activeMediaPageId = null;
let activeMentionedMediaLinks = new Set();
let activeMediaTotalLinks = 0;

// Functions to be imported from the new, lean sidebar.js
let sendMessageToBackground;

/**
 * Injects dependencies from the main sidebar module.
 * @param {object} dependencies - The dependencies to inject.
 */
export function init(dependencies) {
    sendMessageToBackground = dependencies.sendMessageToBackground;
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

async function triggerImmediateSave() {
    clearTimeout(saveStateDebounceTimer);
    if (currentDetailInstance) {
        logger.log("DetailView:ImmediateSave", "Persisting state immediately due to navigation or pause.", { id: currentDetailInstance.instanceId });
        await storage.savePacketInstance(currentDetailInstance);
    }
}


// --- Waveform Generation and Drawing ---
async function drawWaveform(canvas, audioSamples, options) {
    const { 
        accentColor, playedColor, linkColor, currentTime, 
        linkMarkersEnabled, timestamps, audioDuration,
        visitedUrlsSet,
        visitedLinkColor
    } = options;
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

    const links = timestamps.map(t => ({ startTime: t.startTime, url: t.url }));

    for (let i = 0; i < numBars; i++) {
        const barStartTime = i * timePerBar;
        const isPlayed = barStartTime < currentTime;
        
        const activeLink = linkMarkersEnabled ? links.find(lt => barStartTime >= lt.startTime && barStartTime < lt.startTime + timePerBar) : null;

        if (activeLink) {
            if (visitedUrlsSet && visitedUrlsSet.has(activeLink.url)) {
                ctx.fillStyle = visitedLinkColor;
            } else {
                ctx.fillStyle = linkColor;
            }
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
        const barHeight = Math.max(1, max * canvasHeight * 1.8);
        const y = (canvasHeight - barHeight) / 2;
        ctx.fillRect(i * (barWidth + barGap), y, barWidth, barHeight);
    }
}

// --- NEW: Function to redraw waveforms on state update ---
async function redrawAllVisibleWaveforms() {
    if (!currentDetailInstance || !domRefs.packetDetailView) return;

    const mediaCards = domRefs.packetDetailView.querySelectorAll('.card.media');
    if (mediaCards.length === 0) return;
    
    const settings = await storage.getSettings();
    const colorOptions = {
        accentColor: getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-accent').trim(),
        playedColor: getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-progress-fill').trim(),
        linkColor: getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-link-marker').trim(),
        visitedLinkColor: '#81c995',
        linkMarkersEnabled: settings.waveformLinkMarkersEnabled,
        visitedUrlsSet: new Set(currentDetailInstance.visitedUrls || [])
    };

    for (const card of mediaCards) {
        const pageId = card.dataset.pageId;
        const canvas = card.querySelector('.waveform-canvas');
        const contentItem = currentDetailInstance.contents.find(item => item.pageId === pageId);
        const audioCacheKey = `${currentDetailInstance.imageId}::${pageId}`;
        const audioSamples = audioDataCache.get(audioCacheKey);

        if (canvas && contentItem && audioSamples) {
            // Use the currently playing audio's time if it matches, otherwise use 0
            const currentTime = (activeAudioElement && activeAudioElement.dataset.pageId === pageId) 
                ? activeAudioElement.currentTime 
                : 0;
            const audioDuration = activeAudioElement && activeAudioElement.dataset.pageId === pageId 
                ? activeAudioElement.duration
                : (audioSamples.length / 44100); // Fallback estimate

            drawWaveform(canvas, audioSamples, { 
                ...colorOptions, 
                timestamps: contentItem.timestamps || [],
                currentTime,
                audioDuration
            });
        }
    }
}


// --- Main Rendering Function ---
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
        await pauseAndClearActiveAudio(); 
    }
    
    currentDetailInstance = instance;
    if (!Array.isArray(currentDetailInstance.mentionedMediaLinks)) {
        currentDetailInstance.mentionedMediaLinks = [];
    }


    try {
        const isAlreadyRendered = container.querySelector(`#detail-cards-container[data-instance-id="${instance.instanceId}"]`);

        const { progressPercentage } = packetUtils.calculateInstanceProgress(instance);

        if (isAlreadyRendered) {
            const visitedUrlsSet = new Set(instance.visitedUrls || []);
            const visitedGeneratedIds = new Set(instance.visitedGeneratedPageIds || []);
            const mentionedLinks = new Set(instance.mentionedMediaLinks || []);

            container.querySelectorAll('.card').forEach(card => {
                const isVisited = (card.dataset.pageId && visitedGeneratedIds.has(card.dataset.pageId)) ||
                                  (card.dataset.url && visitedUrlsSet.has(card.dataset.url));
                card.classList.toggle('visited', isVisited);
                const url = card.dataset.url;
                if (url && !isVisited && !card.classList.contains('media')) {
                    card.classList.toggle('hidden-by-rule', !mentionedLinks.has(url));
                }
            });
            updateActiveCardHighlight(currentPacketUrl);
            
            const progressBar = domRefs.detailProgressContainer?.querySelector('.progress-bar');
            if (progressBar) progressBar.style.width = `${progressPercentage}%`;
            const progressBarContainer = domRefs.detailProgressContainer?.querySelector('.progress-bar-container');
            if (progressBarContainer) progressBarContainer.title = `${progressPercentage}% Complete`;
            
            // --- CHANGE: Redraw waveforms on any state update ---
            await redrawAllVisibleWaveforms();

        } else {
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
                            
                            const settings = await storage.getSettings();
                            const colorOptions = {
                                accentColor: getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-accent').trim(),
                                playedColor: getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-progress-fill').trim(),
                                linkColor: getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-link-marker').trim(),
                                visitedLinkColor: '#81c995',
                                timestamps: contentItem.timestamps || [],
                                currentTime: 0,
                                linkMarkersEnabled: settings.waveformLinkMarkersEnabled,
                                audioDuration: decodedData.duration,
                                visitedUrlsSet: new Set(instance.visitedUrls || [])
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
    const { progressPercentage } = packetUtils.calculateInstanceProgress(instance);
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
        const preferAudio = settings.elevenlabsApiKey && contentItem.alternatives.some(a => a.type === 'media');
        
        const chosenItem = preferAudio 
            ? contentItem.alternatives.find(a => a.type === 'media')
            : contentItem.alternatives.find(a => a.type === 'generated');

        return chosenItem ? createContentCard(chosenItem, visitedUrlsSet, visitedGeneratedIds, instance, mentionedLinks) : null;
    }


    const card = document.createElement('div');
    card.className = 'card';
    let { url: urlToOpen, title = 'Untitled', relevance = '', type } = contentItem;
    let displayUrl = urlToOpen || '(URL missing)', iconHTML = '?', isClickable = false;

    if (contentItem.url) card.dataset.url = contentItem.url;
    if (contentItem.pageId) card.dataset.pageId = contentItem.pageId;

    if (type === 'external') {
        iconHTML = '🔗';
        if (urlToOpen) isClickable = true;
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
                 <canvas class="waveform-canvas" style="width: 100%; height: 100%;"></canvas>
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

    const isMentioned = contentItem.url && mentionedLinks.has(contentItem.url);
    const isVisible = type === 'media' || isVisited || isMentioned;
    
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
            card.addEventListener('click', async () => {
                await openUrl(urlToOpen, instance.instanceId);
            });
        }
    }
    
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

async function openUrl(url, instanceId) {
    if (!url || !instanceId) return;
    
    await triggerImmediateSave();

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

export async function pauseAndClearActiveAudio() {
    if (isClearingAudio) return;

    if (activeAudioElement) {
        isClearingAudio = true; 
        
        logger.log('DetailView', 'Pausing and clearing active audio element.');
        activeAudioElement.pause();
        
        await triggerImmediateSave();

        if (activeAudioElement) {
            activeAudioElement.src = ''; 
            activeAudioElement.load(); 
            activeAudioElement = null; 
        }

        activeMediaPageId = null;
        activeMentionedMediaLinks.clear();
        activeMediaTotalLinks = 0;

        isClearingAudio = false;
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
            await pauseAndClearActiveAudio();
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
        const progressSessionKey = `audio_progress_${instance.instanceId}_${contentItem.pageId}`;
        
        activeMediaPageId = contentItem.pageId;
        activeMentionedMediaLinks = new Set(currentDetailInstance.mentionedMediaLinks || []);
        activeMediaTotalLinks = contentItem.timestamps?.length || 1;
        
        let pageAlreadyMarkedVisited = (instance.visitedGeneratedPageIds || []).includes(contentItem.pageId);
        
        audio.onplay = () => { card.classList.add('playing'); };
        audio.onpause = async () => {
            card.classList.remove('playing');
            await storage.setSession({ [progressSessionKey]: audio.currentTime });
            await pauseAndClearActiveAudio();
        };
        
        audio.ontimeupdate = async () => {
             if (!audio.duration || isNaN(audio.duration) || !audioSamples) return;
             
             const settings = await storage.getSettings();
             const colorOptions = {
                 accentColor: getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-accent').trim(),
                 playedColor: getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-progress-fill').trim(),
                 linkColor: getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-link-marker').trim(),
                 visitedLinkColor: '#81c995',
                 timestamps: contentItem.timestamps || [],
                 linkMarkersEnabled: settings.waveformLinkMarkersEnabled,
                 visitedUrlsSet: new Set(currentDetailInstance.visitedUrls || [])
             };

             drawWaveform(canvas, audioSamples, { ...colorOptions, currentTime: audio.currentTime, audioDuration: audio.duration });
             
             if (!currentDetailInstance) return;

             if (!Array.isArray(currentDetailInstance.mentionedMediaLinks)) {
                currentDetailInstance.mentionedMediaLinks = [];
             }

             if (contentItem.timestamps && contentItem.timestamps.length > 0 && !pageAlreadyMarkedVisited) {
                let cardRevealStateChanged = false;
    
                for (const ts of contentItem.timestamps) {
                    const itemToReveal = currentDetailInstance.contents.find(item => {
                        if (!item.url || !ts.url) return false;
                        try {
                            const itemUrl = new URL(item.url);
                            const tsUrl = new URL(ts.url);
                            return (itemUrl.origin + itemUrl.pathname.replace(/\/$/, '')) === (tsUrl.origin + tsUrl.pathname.replace(/\/$/, ''));
                        } catch (e) {
                            return decodeURIComponent(item.url) === decodeURIComponent(ts.url);
                        }
                    });

                    if (itemToReveal) {
                        if (audio.currentTime >= ts.startTime && !currentDetailInstance.mentionedMediaLinks.includes(itemToReveal.url)) {
                            currentDetailInstance.mentionedMediaLinks.push(itemToReveal.url);
                            cardRevealStateChanged = true;
        
                            const cardToReveal = domRefs.detailCardsContainer.querySelector(`.card[data-url="${itemToReveal.url}"]`);
                            if (cardToReveal) {
                                cardToReveal.classList.remove('hidden-by-rule');
                            }
                        }
                    }
                }

                if (cardRevealStateChanged) {
                    const { progressPercentage } = packetUtils.calculateInstanceProgress(currentDetailInstance);
                    const progressBar = domRefs.detailProgressContainer?.querySelector('.progress-bar');
                    if (progressBar) {
                        progressBar.style.width = `${progressPercentage}%`;
                        progressBar.parentElement.title = `${progressPercentage}% Complete`;
                    }
                    
                    requestDebouncedStateSave();
                    
                    if (currentDetailInstance.mentionedMediaLinks.length === contentItem.timestamps.length) {
                        logger.log('DetailView', `All ${contentItem.timestamps.length} links for media ${contentItem.pageId} have been mentioned. Marking as visited.`);
                        pageAlreadyMarkedVisited = true;

                        const mediaCardElement = domRefs.detailCardsContainer.querySelector(`.card.media[data-page-id="${contentItem.pageId}"]`);
                        if (mediaCardElement) {
                            mediaCardElement.classList.add('visited');
                        }
                        
                        await triggerImmediateSave();
                        
                        await sendMessageToBackground({ 
                            action: 'media_playback_complete', 
                            data: { instanceId: instance.instanceId, pageId: contentItem.pageId } 
                        });
                    }
                }
            }

             let activeTimestamp = null;
             if (contentItem.timestamps) {
                 for (const ts of contentItem.timestamps) {
                     if (audio.currentTime >= ts.startTime && audio.currentTime < ts.endTime) {
                         activeTimestamp = ts;
                         break;
                     }
                 }
             }
 
             domRefs.detailCardsContainer.querySelectorAll('.card.link-mentioned').forEach(c => c.classList.remove('link-mentioned'));
 
             if (activeTimestamp) {
                const itemToHighlight = currentDetailInstance.contents.find(item => {
                    if (!item.url || !activeTimestamp.url) return false;
                    try {
                        const itemUrl = new URL(item.url);
                        const tsUrl = new URL(activeTimestamp.url);
                        return (itemUrl.origin + itemUrl.pathname.replace(/\/$/, '')) === (tsUrl.origin + tsUrl.pathname.replace(/\/$/, ''));
                    } catch (e) {
                        return decodeURIComponent(item.url) === decodeURIComponent(activeTimestamp.url);
                    }
                });

                 if (itemToHighlight) {
                     const targetCard = domRefs.detailCardsContainer.querySelector(`.card[data-url="${itemToHighlight.url}"]`);
                     if (targetCard) {
                         targetCard.classList.add('link-mentioned');
                         targetCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                     }
                 }
             }
        };

        audio.onended = async () => {
            card.classList.remove('playing');
            await storage.removeSession(progressSessionKey);

            if (!contentItem.timestamps || contentItem.timestamps.length === 0) {
                 await sendMessageToBackground({ 
                    action: 'media_playback_complete', 
                    data: { instanceId: instance.instanceId, pageId: contentItem.pageId } 
                });
            }
            await pauseAndClearActiveAudio();
        };
        
        audio.onloadedmetadata = async () => {
            const sessionData = await storage.getSession(progressSessionKey);
            const savedTime = sessionData[progressSessionKey];
            if (savedTime && isFinite(savedTime)) audio.currentTime = savedTime;
            audio.play();
        };
        if (audio.readyState >= 1) {
             const sessionData = await storage.getSession(progressSessionKey);
             const savedTime = sessionData[progressSessionKey];
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