// ext/overlay.js

// --- FIX: Idempotency Check ---
// This check ensures that the script's logic only runs once per page,
// even if the script itself is injected multiple times. This prevents
// the "Identifier 'overlay' has already been declared" error.
if (!window.unlockOverlayInitialized) {
    window.unlockOverlayInitialized = true; // Set a flag to prevent re-execution

    // --- Globals ---
    let overlay, playPauseBtn, playIcon, pauseIcon, overlayText, linkMention;
    let isVisible = false;
    let momentTimeout = null;

    // --- START: New SVG Filter Injection ---
    /**
     * Injects the SVG filter definitions required for the liquid glass effect.
     * This is designed to be self-contained to avoid conflicts with the host page.
     */
    function injectSvgFilters() {
        if (document.getElementById('unlock-svg-filter-container')) return;

        // 1. Define the SVG for the displacement map. This creates the gradient
        // that controls how the content behind the overlay is distorted.
        const displacementMapSvg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="450" height="54">
                <defs>
                    <radialGradient id="unlock-grad" cx="50%" cy="50%" r="50%">
                        <stop offset="70%" stop-color="gray" />
                        <stop offset="100%" stop-color="white" />
                    </radialGradient>
                </defs>
                <rect width="100%" height="100%" rx="27" fill="url(#unlock-grad)" />
            </svg>
        `;

        // 2. Encode the displacement map SVG into a Base64 data URI.
        const encodedDisplacementMap = `data:image/svg+xml;base64,${btoa(displacementMapSvg)}`;

        // 3. Create a container for the main filter definition.
        const svgFilterContainer = document.createElement('div');
        svgFilterContainer.id = 'unlock-svg-filter-container';
        svgFilterContainer.style.display = 'none';

        // 4. Define the main filter, using the data URI as the source.
        // This filter grabs the background, applies the distortion map, and adds a subtle blur.
        svgFilterContainer.innerHTML = `
            <svg>
                <defs>
                    <filter id="unlock-liquid-glass-filter">
                        <feImage href="${encodedDisplacementMap}" result="displacementMap" />
                        <feGaussianBlur in="displacementMap" stdDeviation="2" result="blurredMap" />
                        <feDisplacementMap
                            in="SourceGraphic"
                            in2="blurredMap"
                            scale="15"
                            xChannelSelector="R"
                            yChannelSelector="G"
                        />
                        <feGaussianBlur in="SourceGraphic" stdDeviation="1" />
                    </filter>
                </defs>
            </svg>
        `;
        
        // 5. Append the filter definition to the body so CSS can reference it.
        document.body.appendChild(svgFilterContainer);
    }
    // --- END: New SVG Filter Injection ---


    // --- Main Initialization ---
    function createOverlay() {
        // Prevent creating the overlay multiple times (double check)
        if (document.getElementById('unlock-media-overlay')) {
            return;
        }

        // Inject the SVG filters required for the liquid glass effect
        injectSvgFilters();

        // Add an inline style to prevent the initial flicker
        document.body.insertAdjacentHTML('beforeend', `
            <div id="unlock-media-overlay" style="opacity: 0 !important;">
                <div class="unlock-overlay-content-wrapper">
                    <button class="unlock-overlay-play-pause-btn">
                        <div class="icon play-icon"></div>
                        <div class="icon pause-icon" style="display: none;"></div>
                    </button>
                    <div class="unlock-overlay-bars">
                        <div class="bar"></div>
                        <div class="bar"></div>
                        <div class="bar"></div>
                        <div class="bar"></div>
                    </div>
                    <div class="unlock-overlay-text"></div>
                </div>
                <div class="unlock-overlay-link-mention">
                     <div class="icon"></div>
                     <div class="link-text"></div>
                </div>
            </div>
        `);

        // Cache DOM references
        overlay = document.getElementById('unlock-media-overlay');
        playPauseBtn = overlay.querySelector('.unlock-overlay-play-pause-btn');
        playIcon = overlay.querySelector('.play-icon');
        pauseIcon = overlay.querySelector('.pause-icon');
        overlayText = overlay.querySelector('.unlock-overlay-text');
        linkMention = overlay.querySelector('.unlock-overlay-link-mention');

        // --- Add Event Listeners ---
        playPauseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            chrome.runtime.sendMessage({ action: 'request_playback_action', data: { intent: 'toggle' } });
        });
        
        linkMention.addEventListener('click', (e) => {
            e.stopPropagation();
            const urlToOpen = linkMention.dataset.url;
            if (urlToOpen) {
                chrome.runtime.sendMessage({
                    action: 'open_content_from_overlay',
                    data: { url: urlToOpen }
                });
            }
        });
    }

    /**
     * Updates the entire UI of the overlay based on the state received from the background.
     * @param {object} state - The playback state from background.js
     */
    function syncState(state) {
        if (!overlay || !state) return;

        if (state.animate === false) {
            overlay.classList.add('no-transition');
        } else {
            overlay.classList.remove('no-transition');
        }

        if (state.isVisible !== isVisible) {
            isVisible = state.isVisible;
            overlay.classList.toggle('visible', isVisible);
        }

        if (state.animate === false) {
            setTimeout(() => {
                overlay.classList.remove('no-transition');
            }, 50);
        }
        
        if (overlay.style.opacity !== '') {
            overlay.style.opacity = '';
        }

        const isPlaying = state.isPlaying;
        playIcon.style.display = isPlaying ? 'none' : 'block';
        pauseIcon.style.display = isPlaying ? 'block' : 'none';
        overlay.classList.toggle('playing', isPlaying);

        overlayText.textContent = state.title || 'Unlock Media';

        if (state.lastTrippedMoment) {
            linkMention.querySelector('.link-text').textContent = state.lastTrippedMoment.title;
            linkMention.dataset.url = state.lastTrippedMoment.url;
            
            clearTimeout(momentTimeout);
            overlay.classList.add('moment-visible');
            linkMention.classList.add('visible');

            momentTimeout = setTimeout(() => {
                overlay.classList.remove('moment-visible');
                if (!overlay.classList.contains('moment-visible')) {
                    linkMention.classList.remove('visible');
                }
            }, 5000);
        }

        if (state.showVisitedAnimation) {
            overlay.classList.add('visited-complete');
            setTimeout(() => {
                overlay.classList.remove('visited-complete');
            }, 1500);
        }
    }


    // --- Message Listener from Background Script ---
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'update_overlay_state' || message.action === 'sync_overlay_state') {
            syncState(message.data);
        }
        return true;
    });
    
    // --- Visibility Change Listener ---
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            chrome.runtime.sendMessage({ action: 'get_playback_state' }, (state) => {
                if (!chrome.runtime.lastError && state) {
                    syncState(state);
                }
            });
        }
    });


    // --- Initial Setup ---
    createOverlay();

    chrome.runtime.sendMessage({ action: 'get_playback_state' }, (initialState) => {
        if (chrome.runtime.lastError) {
            // Suppress "Receiving end does not exist" error during page load
        } else if (initialState) {
            syncState(initialState);
        }
    });

}