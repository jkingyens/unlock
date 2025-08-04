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

    // --- Main Initialization ---
    function createOverlay() {
        // Prevent creating the overlay multiple times (double check)
        if (document.getElementById('unlock-media-overlay')) {
            return;
        }

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
                <div class="unlock-overlay-link-mention" style="display: none;">
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

        overlay.addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'open_sidebar_and_navigate', data: {} });
        });

        linkMention.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevents the main overlay click (which opens the sidebar)
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
        if (!overlay) return;

        // --- Animation Control ---
        if (state.animate === false) {
            overlay.classList.add('no-transition');
        } else {
            overlay.classList.remove('no-transition');
        }

        // --- Visibility ---
        if (state.isVisible !== isVisible) {
            isVisible = state.isVisible;
            overlay.classList.toggle('visible', isVisible);
        }

        // After changing visibility, remove the transition class so the next change can animate.
        if (state.animate === false) {
            setTimeout(() => {
                overlay.classList.remove('no-transition');
            }, 50);
        }
        
        // Remove the inline style after the first state sync to hand control to the CSS.
        if (overlay.style.opacity !== '') {
            overlay.style.opacity = '';
        }

        // --- Play/Pause State ---
        const isPlaying = state.isPlaying;
        playIcon.style.display = isPlaying ? 'none' : 'block';
        pauseIcon.style.display = isPlaying ? 'block' : 'none';
        overlay.classList.toggle('playing', isPlaying);

        // --- Text Content ---
        overlayText.textContent = state.topic || 'Unlock Media';

        // --- Link Mention ---
        const hasLink = state.lastMentionedLink && state.lastMentionedLink.url;

        if (hasLink) {
            // Always update the content if a link is present
            linkMention.querySelector('.link-text').textContent = state.lastMentionedLink.title;
            linkMention.dataset.url = state.lastMentionedLink.url;
            linkMention.style.display = 'flex';

            // Only add the animation class if explicitly told to
            if (state.animateLinkMention) {
                linkMention.classList.add('animate');
                setTimeout(() => linkMention.classList.remove('animate'), 500);
            }
        } else {
            // Hide the link mention if no link is present
            linkMention.style.display = 'none';
            delete linkMention.dataset.url;
        }

        // --- Visited Animation ---
        if (state.showVisitedAnimation) {
            overlay.classList.add('visited-complete');
            setTimeout(() => {
                overlay.classList.remove('visited-complete');
            }, 1500); // Duration of the animation
        }
    }


    // --- Message Listener from Background Script ---
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'sync_overlay_state') {
            syncState(message.data);
        }
    });


    // --- Initial Setup ---
    // Create the overlay elements as soon as the script is injected.
    createOverlay();

    // Request the initial state from the background script once ready.
    chrome.runtime.sendMessage({ action: 'get_playback_state' }, (initialState) => {
        if (initialState) {
            syncState(initialState);
        }
    });

} // End of idempotency check block