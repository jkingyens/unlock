// ext/overlay.js

// Wrap in IIFE to prevent "Identifier has already been declared" errors
(function () {

    function initializeUnlockOverlay() {
        // --- Globals ---
        let overlay, playPauseBtn, playIcon, pauseIcon, overlayText, linkMention;
        let isVisible = false;

        // --- Cleanup "Zombie" Elements ---
        function cleanupZombies() {
            const oldOverlay = document.getElementById('unlock-media-overlay');
            if (oldOverlay) {
                oldOverlay.remove();
            }
            
            const oldFilters = document.getElementById('unlock-svg-filter-container');
            if (oldFilters) {
                oldFilters.remove();
            }
        }

        /**
         * Injects the SVG filter definitions required for the liquid glass effect.
         */
        function injectSvgFilters() {
            if (document.getElementById('unlock-svg-filter-container')) return;
            const displacementMapSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="450" height="54"><defs><radialGradient id="unlock-grad" cx="50%" cy="50%" r="50%"><stop offset="70%" stop-color="gray" /><stop offset="100%" stop-color="white" /></radialGradient></defs><rect width="100%" height="100%" rx="27" fill="url(#unlock-grad)" /></svg>`;
            const encodedDisplacementMap = `data:image/svg+xml;base64,${btoa(displacementMapSvg)}`;
            const svgFilterContainer = document.createElement('div');
            svgFilterContainer.id = 'unlock-svg-filter-container';
            svgFilterContainer.style.display = 'none';
            svgFilterContainer.innerHTML = `<svg><defs><filter id="unlock-liquid-glass-filter"><feImage href="${encodedDisplacementMap}" result="displacementMap" /><feGaussianBlur in="displacementMap" stdDeviation="2" result="blurredMap" /><feDisplacementMap in="SourceGraphic" in2="blurredMap" scale="15" xChannelSelector="R" yChannelSelector="G"/><feGaussianBlur in="SourceGraphic" stdDeviation="1" /></filter></defs></svg>`;
            document.body.appendChild(svgFilterContainer);
        }

        /**
         * Creates the overlay elements.
         */
        function setupOverlayElements() {
            // We always create fresh because cleanupZombies() ran first.
            injectSvgFilters();
            
            document.body.insertAdjacentHTML('beforeend', `
                <div id="unlock-media-overlay" style="opacity: 0 !important;">
                    <div class="unlock-overlay-content-wrapper">
                        <button class="unlock-overlay-play-pause-btn">
                            <div class="icon play-icon"></div>
                            <div class="icon pause-icon" style="display: none;"></div>
                        </button>
                        <div class="unlock-overlay-bars">
                            <div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div>
                        </div>
                        <div class="unlock-overlay-text"></div>
                    </div>
                    <div class="unlock-overlay-link-mention">
                            <div class="icon"></div>
                            <div class="link-text"></div>
                    </div>
                </div>
            `);
            
            overlay = document.getElementById('unlock-media-overlay');
            playPauseBtn = overlay.querySelector('.unlock-overlay-play-pause-btn');
            playIcon = overlay.querySelector('.play-icon');
            pauseIcon = overlay.querySelector('.pause-icon');
            overlayText = overlay.querySelector('.unlock-overlay-text');
            linkMention = overlay.querySelector('.unlock-overlay-link-mention');
        }

        function syncState(state) {
            if (!overlay || !state) return;

            overlay.classList.toggle('no-transition', state.animate === false);
            if (state.isVisible !== isVisible) {
                isVisible = state.isVisible;
                overlay.classList.toggle('visible', isVisible);
            }
            if (state.animate === false) {
                setTimeout(() => overlay.classList.remove('no-transition'), 50);
            }
            // Clear any inline opacity left over from initialization
            if (overlay.style.opacity !== '') overlay.style.opacity = '';

            const isPlaying = state.isPlaying;
            playIcon.style.display = isPlaying ? 'none' : 'block';
            pauseIcon.style.display = isPlaying ? 'block' : 'none';
            overlay.classList.toggle('playing', isPlaying);
            overlayText.textContent = state.title || 'Unlock Media';

            if (state.lastTrippedMoment) {
                linkMention.querySelector('.link-text').textContent = state.lastTrippedMoment.title;
                linkMention.dataset.url = state.lastTrippedMoment.url;
                linkMention.classList.add('visible');
            } else {
                linkMention.classList.remove('visible');
            }

            if (state.showVisitedAnimation) {
                overlay.classList.add('visited-complete');
                setTimeout(() => overlay.classList.remove('visited-complete'), 1500);
            }
        }

        // --- Main Execution ---
        
        // 1. Clean up any artifacts from previous extension lifecycles
        cleanupZombies();

        // 2. Create fresh elements
        setupOverlayElements();

        // 3. Bind Events
        playPauseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            try {
                chrome.runtime.sendMessage({ action: 'request_playback_action', data: { intent: 'toggle' } });
            } catch (error) {
                // Extension context invalidated, suppress error
            }
        });
        
        linkMention.addEventListener('click', (e) => {
            e.stopPropagation();
            const urlToOpen = linkMention.dataset.url;
            if (urlToOpen) {
                try {
                    chrome.runtime.sendMessage({ action: 'open_content_from_overlay', data: { url: urlToOpen } });
                } catch (error) {
                    // Extension context invalidated, suppress error
                }
            }
        });

        // 4. Setup Communication
        // Use try-catch for adding listener in case 'chrome.runtime' is gone
        try {
            chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
                if (message.action === 'update_overlay_state' || message.action === 'sync_overlay_state') {
                    syncState(message.data);
                }
                return true;
            });
        } catch (e) { /* ignore */ }
        
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                try {
                    if (chrome.runtime && chrome.runtime.id) {
                        chrome.runtime.sendMessage({ action: 'get_playback_state' }, (state) => {
                            if (!chrome.runtime.lastError && state) {
                                syncState(state);
                            }
                        });
                    }
                } catch (error) {
                    // Context invalidated, ignore.
                }
            }
        });

        // 5. Initial State Fetch
        try {
            if (chrome.runtime && chrome.runtime.id) {
                chrome.runtime.sendMessage({ action: 'get_playback_state' }, (initialState) => {
                    if (!chrome.runtime.lastError && initialState) {
                        syncState(initialState);
                    }
                });
            }
        } catch (error) {
            // Context invalidated, ignore.
        }
    }

    // --- Entry Point ---
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeUnlockOverlay);
    } else {
        initializeUnlockOverlay();
    }

})();