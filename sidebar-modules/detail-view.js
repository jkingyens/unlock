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

// --- Waveform Generation Helper ---

/**
 * Generates a simple, decorative SVG waveform data URI.
 * @param {string} color - The hex color for the waveform bars.
 * @returns {string} - A data URI for the SVG.
 */
function _generateWaveformSVGDataUri(color = '#a0a0a0') {
    const width = 200;
    const height = 40;
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">`;
    const barCount = 50;
    const barWidth = width / barCount;

    for (let i = 0; i < barCount; i++) {
        const barHeight = Math.random() * (height - 10) + 10;
        const y = (height - barHeight) / 2;
        svg += `<rect x="${i * barWidth}" y="${y}" width="${barWidth - 1}" height="${barHeight}" fill="${color}" rx="1"/>`;
    }

    svg += `</svg>`;
    return `data:image/svg+xml;base64,${btoa(svg)}`;
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

    // NEW: Always pause and clear any active audio when displaying a new packet context
    // This helps reset the state even if coming from another audio-playing packet.
    if (activeAudioElement && activeAudioElement.dataset.instanceId !== instance?.instanceId) {
        pauseAndClearActiveAudio();
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
            const cardsWrapper = await createCardsSection(instance);
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
            displayUrl = title; // For generated pages, show title instead of long S3 key
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
        
        const waveformColor = getComputedStyle(domRefs.packetDetailView).getPropertyValue('--packet-color-accent').trim();
        const waveformDataUri = _generateWaveformSVGDataUri(waveformColor);

        card.innerHTML = `
            <div class="media-waveform-container">
                <img src="${waveformDataUri}" class="waveform-svg" alt="Audio waveform" />
                <div class="media-highlights-container"></div> <div class="media-progress-overlay"></div>
            </div>
            <div class="media-play-icon">▶️</div>
            <div class="card-text">
                <div class="card-title">${title}</div>
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

/**
 * Pauses any currently active audio element and clears the reference.
 * Should be called when navigating away from a view that plays audio,
 * or when preparing to play new audio.
 */
export function pauseAndClearActiveAudio() {
    if (activeAudioElement) {
        logger.log('DetailView', 'Pausing and clearing active audio element.');
        activeAudioElement.pause();
        activeAudioElement.src = ''; // Clear src to release resources
        activeAudioElement.load(); // Reload to ensure src is cleared
        activeAudioElement = null;
    }
}

/**
 * Checks if the currently playing audio belongs to a packet that was just deleted.
 * If so, it stops the audio.
 * @param {string} deletedPacketId - The instanceId of the packet that was deleted.
 */
export function stopAudioIfPacketDeleted(deletedPacketId) {
    if (activeAudioElement && activeAudioElement.dataset.instanceId === deletedPacketId) {
        logger.log('DetailView', `Stopping audio because its packet (${deletedPacketId}) was deleted.`);
        pauseAndClearActiveAudio();
    }
}


async function playMediaInCard(card, contentItem, instance) {
    const waveformContainer = card.querySelector('.media-waveform-container');
    const highlightsContainer = card.querySelector('.media-highlights-container');
    if (!waveformContainer || !highlightsContainer) return;

    const initializeAndPlayAudio = async () => {
        // Pause and reset other playing audio elements
        // Ensure only one audio element is "active" at the module level.
        // If a different audio element is currently active, pause and clear it.
        if (activeAudioElement && activeAudioElement.dataset.pageId !== contentItem.pageId) {
            pauseAndClearActiveAudio();
        }
        
        card.classList.add('playing');
        const playIcon = card.querySelector('.media-play-icon');

        if (!activeAudioElement || activeAudioElement.dataset.pageId !== contentItem.pageId) {
            const audio = new Audio();
            audio.dataset.pageId = contentItem.pageId;
            audio.dataset.instanceId = instance.instanceId; // Store instanceId for click handling on highlights
            activeAudioElement = audio;
            
            const cachedAudio = await indexedDbStorage.getGeneratedContent(instance.imageId, contentItem.pageId);
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
                    card.classList.remove('playing');
                    return;
                }
            }
        }
        
        const audio = activeAudioElement;
        const sessionKey = `audio_progress_${instance.instanceId}_${contentItem.pageId}`;
        const progressOverlay = card.querySelector('.media-progress-overlay');
        
        audio.onplay = () => { if (playIcon) playIcon.textContent = '⏸️'; card.classList.add('playing'); };
        audio.onpause = async () => { if (playIcon) playIcon.textContent = '▶️'; card.classList.remove('playing'); await storage.setSession({ [sessionKey]: audio.currentTime }); const freshInstance = await storage.getPacketInstance(instance.instanceId); if (!freshInstance || !audio.duration || isNaN(audio.duration)) return; const { progressPercentage } = calculateInstanceProgress(freshInstance, { [contentItem.pageId]: audio.currentTime / audio.duration }); const progressBar = document.querySelector('#detail-progress-container .progress-bar'); if (progressBar) progressBar.style.width = `${progressPercentage}%`; };
        
        audio.ontimeupdate = async () => {
            if (!audio.duration || isNaN(audio.duration)) return;
            const freshInstance = await storage.getPacketInstance(instance.instanceId);
            if (!freshInstance) return;
            const percentage = (audio.currentTime / audio.duration) * 100;
            if (progressOverlay) progressOverlay.style.width = `${percentage}%`;
            
            // --- Highlighting active link segments on waveform ---
            let currentActiveLinkUrl = null;
            highlightsContainer.querySelectorAll('.media-highlight-segment').forEach(segment => {
                const segmentStart = parseFloat(segment.dataset.startTime);
                const segmentEnd = parseFloat(segment.dataset.endTime);
                if (audio.currentTime >= segmentStart && audio.currentTime < segmentEnd) {
                    segment.classList.add('active');
                    currentActiveLinkUrl = segment.dataset.linkUrl; // Capture the URL of the active link
                } else {
                    segment.classList.remove('active');
                }
            });

            // --- Highlighting the corresponding content card ---
            // First, remove the highlight from all cards
            domRefs.detailCardsContainer.querySelectorAll('.card.link-mentioned').forEach(c => {
                c.classList.remove('link-mentioned');
            });

            if (currentActiveLinkUrl) {
                // Find the card that corresponds to the active link URL
                const targetCard = Array.from(domRefs.detailCardsContainer.querySelectorAll('.card')).find(c => {
                    // Match external links by dataset.url
                    if (c.dataset.url === currentActiveLinkUrl) {
                        return true;
                    }
                    // Match generated/media content by dataset.pageId
                    // This requires finding the content item in the current instance whose URL is currentActiveLinkUrl,
                    // and then checking if its pageId matches the card's dataset.pageId
                    const linkedContentItem = freshInstance.contents.find(item => item.url === currentActiveLinkUrl);
                    if (linkedContentItem && linkedContentItem.pageId && c.dataset.pageId === linkedContentItem.pageId) {
                        return true;
                    }
                    return false;
                });

                if (targetCard) {
                    targetCard.classList.add('link-mentioned');
                    // Optional: scroll the card into view if it's not visible
                    targetCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            }
            
            const { progressPercentage: overallProgress } = calculateInstanceProgress(freshInstance, { [contentItem.pageId]: percentage / 100 });
            const progressBar = document.querySelector('#detail-progress-container .progress-bar');
            if (progressBar) progressBar.style.width = `${overallProgress}%`;
        };

        audio.onended = async () => {
            if (playIcon) playIcon.textContent = '▶️';
            card.classList.remove('playing');
            if (progressOverlay) progressOverlay.style.width = '100%';
            highlightsContainer.querySelectorAll('.media-highlight-segment').forEach(segment => segment.classList.remove('active')); // Clear waveform highlights
            domRefs.detailCardsContainer.querySelectorAll('.card.link-mentioned').forEach(c => c.classList.remove('link-mentioned')); // Clear card highlights
            storage.removeSession(sessionKey);
            await sendMessageToBackground({ action: 'media_playback_complete', data: { instanceId: instance.instanceId, pageId: contentItem.pageId } });
        };
        
        audio.onloadedmetadata = async () => {
            // Render highlight segments based on duration
            renderLinkHighlights(contentItem.timestamps, audio.duration, highlightsContainer);

            const sessionData = await storage.getSession(sessionKey);
            const savedTime = sessionData[sessionKey];
            if (savedTime && isFinite(savedTime)) audio.currentTime = savedTime;
            audio.play();
        };
        if (audio.readyState >= 1) { // If metadata already loaded
            // Render highlight segments immediately
            renderLinkHighlights(contentItem.timestamps, audio.duration, highlightsContainer);

            const sessionData = await storage.getSession(sessionKey);
            const savedTime = sessionData[sessionKey];
            if (savedTime && isFinite(savedTime)) audio.currentTime = savedTime;
            audio.play();
        }
    };
    
    // --- REVISED SEEK AND PLAY/PAUSE LOGIC ---
    let isDragging = false;
    let wasPlayingBeforeSeek = false;
    let dragThreshold = 5; // Pixels mouse must move to be considered a drag
    let startX = 0;

    const handleSeek = (e) => {
        if (!activeAudioElement || !activeAudioElement.duration) return;
        const rect = waveformContainer.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const percentage = Math.max(0, Math.min(1, offsetX / rect.width));
        activeAudioElement.currentTime = percentage * activeAudioElement.duration;
    };

    const handleMouseMove = (e) => {
        if (Math.abs(e.clientX - startX) > dragThreshold) {
            isDragging = true;
            if (!wasPlayingBeforeSeek && activeAudioElement) {
                 activeAudioElement.pause();
            }
        }
        if (isDragging) {
            handleSeek(e);
        }
    };

    const handleMouseUp = (e) => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        
        if (isDragging) {
            // Seek is finished, handle final position
            handleSeek(e);
            if (wasPlayingBeforeSeek && activeAudioElement) {
                activeAudioElement.play();
            }
        } else {
            // This was a click, not a drag. Toggle play/pause.
            if (activeAudioElement && !activeAudioElement.paused) {
                activeAudioElement.pause();
            } else if (activeAudioElement && activeAudioElement.paused) {
                activeAudioElement.play();
            } else {
                initializeAndPlayAudio();
            }
        }
        isDragging = false;
    };
    
    waveformContainer.onmousedown = (e) => {
        e.preventDefault();
        isDragging = false;
        startX = e.clientX;
        wasPlayingBeforeSeek = activeAudioElement && !activeAudioElement.paused;

        // If audio isn't loaded yet, initialize it on first interaction
        if (!activeAudioElement) {
            initializeAndPlayAudio().then(() => {
                // Now that audio is loaded, we can proceed
                document.addEventListener('mousemove', handleMouseMove);
                document.addEventListener('mouseup', handleMouseUp);
            });
        } else {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        }
    };
}

/**
 * Renders highlight segments on the waveform container based on link timestamps.
 * @param {Array<Object>} timestamps - The array of link timestamp objects ({url, text, startTime, endTime}).
 * @param {number} audioDuration - The total duration of the audio in seconds.
 * @param {HTMLElement} container - The .media-highlights-container element.
 */
function renderLinkHighlights(timestamps, audioDuration, container) {
    if (!container || !timestamps || timestamps.length === 0 || !audioDuration || isNaN(audioDuration) || audioDuration <= 0) {
        container.innerHTML = ''; // Clear any existing highlights
        return;
    }

    container.innerHTML = ''; // Clear previous highlights before re-rendering

    timestamps.forEach(ts => {
        const startPercent = (ts.startTime / audioDuration) * 100;
        const endPercent = (ts.endTime / audioDuration) * 100;
        const widthPercent = endPercent - startPercent;

        if (widthPercent <= 0) return; // Skip invalid segments

        const highlightDiv = document.createElement('div');
        highlightDiv.className = 'media-highlight-segment';
        highlightDiv.style.left = `${startPercent}%`;
        highlightDiv.style.width = `${widthPercent}%`;
        highlightDiv.title = `Link: ${ts.text} (${formatTime(ts.startTime)} - ${formatTime(ts.endTime)})`; // Tooltip
        
        // Store data for runtime access
        highlightDiv.dataset.startTime = ts.startTime;
        highlightDiv.dataset.endTime = ts.endTime;
        highlightDiv.dataset.linkUrl = ts.url;

        container.appendChild(highlightDiv);

        // Optional: Add click listener to highlight segment to navigate to link
        highlightDiv.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent waveformContainer's click handler from firing
            openUrl(ts.url, activeAudioElement.dataset.instanceId); // Assuming instanceId can be retrieved or passed
        });
    });
}

/** Helper function to format time for tooltips (e.g., 0:30.123) */
function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    const ms = Math.floor((remainingSeconds - Math.floor(remainingSeconds)) * 1000);
    return `${minutes}:${Math.floor(remainingSeconds).toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}