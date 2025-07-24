// ext/overlay.js
// REVISED: This script is now a passive, state-driven view.
// It is injected universally and waits for 'sync_overlay_state' messages
// from the background script to build, update, or hide itself.
// REVISED: Animation logic is now handled locally to prevent race conditions on tab switch.

(() => {
    // If this script has already been injected, do nothing.
    if (window.unlockOverlayInjected) {
        return;
    }
    window.unlockOverlayInjected = true;
    
    const OVERLAY_ID = 'unlock-media-overlay-container';

    // --- State for the overlay ---
    let currentInstanceId = null;
    let isPlaying = true;
    let lastShownLinkUrl = null;
    let becameVisibleTimestamp = 0; // Track when the overlay last appeared

    // --- Core UI Management Functions ---

    function buildOverlayIfNeeded() {
        if (document.getElementById(OVERLAY_ID)) return; // Already built

        const container = document.createElement('div');
        container.id = OVERLAY_ID;
        const shadowRoot = container.attachShadow({ mode: 'open' });

        shadowRoot.innerHTML = `
            <link rel="stylesheet" href="${chrome.runtime.getURL('overlay.css')}">
            <div id="unlock-media-overlay">
                <div class="unlock-overlay-content-wrapper">
                    <button class="unlock-overlay-play-pause-btn" title="Play/Pause">
                        <div class="icon pause-icon"></div>
                    </button>
                    <div class="unlock-overlay-bars">
                        <div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div>
                    </div>
                    <div class="unlock-overlay-text">Playing Packet</div>
                </div>
            </div>
        `;

        document.body.appendChild(container);

        // --- Event Listeners ---
        const overlay = shadowRoot.getElementById('unlock-media-overlay');
        const playPauseBtn = shadowRoot.querySelector('.unlock-overlay-play-pause-btn');

        playPauseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            chrome.runtime.sendMessage({
                action: 'request_playback_action',
                data: { intent: 'toggle' }
            });
        });
        
        overlay.addEventListener('click', () => {
            if (currentInstanceId) {
                chrome.runtime.sendMessage({ 
                    action: 'open_sidebar_and_navigate',
                    data: {
                        targetView: 'packet-detail',
                        instanceId: currentInstanceId
                    }
                });
            }
        });
    }

    function updateOverlayUI(state) {
        const shadowRoot = document.getElementById(OVERLAY_ID)?.shadowRoot;
        if (!shadowRoot) return;
        
        currentInstanceId = state.instanceId;
        isPlaying = state.isPlaying;

        // ... (Update topic text, play/pause icon, and bars - this is unchanged) ...
        const textElement = shadowRoot.querySelector('.unlock-overlay-text');
        if (textElement && state.topic) {
            textElement.textContent = state.topic;
        }
        const btn = shadowRoot.querySelector('.unlock-overlay-play-pause-btn');
        if (btn) {
            btn.innerHTML = `<div class="icon ${isPlaying ? 'pause-icon' : 'play-icon'}"></div>`;
        }
        const bars = shadowRoot.querySelector('.unlock-overlay-bars');
        if (bars) {
            bars.querySelectorAll('.bar').forEach(bar => {
                bar.style.animationPlayState = isPlaying ? 'running' : 'paused';
            });
        }

        // Update link mention display
        if (state.lastMentionedLink && state.lastMentionedLink.url !== lastShownLinkUrl) {
            lastShownLinkUrl = state.lastMentionedLink.url;
            
            // NEW: Animation decision is now made here
            const timeSinceVisible = Date.now() - becameVisibleTimestamp;
            // Animate only if a new link was mentioned AND the overlay has been visible for a moment
            const shouldAnimateLink = state.newLinkMentioned && timeSinceVisible > 500;
            
            showLinkMention(state.lastMentionedLink, shouldAnimateLink);

        } else if (!state.lastMentionedLink && lastShownLinkUrl) {
            lastShownLinkUrl = null;
            const existingMention = shadowRoot.querySelector('.unlock-overlay-link-mention');
            if (existingMention) existingMention.remove();
        }
    }

    function setOverlayVisibility(visible, animate) {
        const overlay = document.getElementById(OVERLAY_ID)?.shadowRoot?.getElementById('unlock-media-overlay');
        if (overlay) {
            const wasVisible = overlay.classList.contains('visible');
            if (visible && !wasVisible) {
                // The overlay is about to become visible, record the timestamp.
                becameVisibleTimestamp = Date.now();
            }
            if (animate) {
                overlay.classList.add('animate-in');
                setTimeout(() => {
                    overlay.classList.remove('animate-in');
                }, 500);
            }
            overlay.classList.toggle('visible', visible);
        }
    }
    
    function showLinkMention(link, animate) {
        const overlay = document.getElementById(OVERLAY_ID)?.shadowRoot?.getElementById('unlock-media-overlay');
        if (!overlay) return;

        const existingMention = overlay.querySelector('.unlock-overlay-link-mention');
        if (existingMention) {
            existingMention.remove();
        }

        const linkMention = document.createElement('div');
        linkMention.className = 'unlock-overlay-link-mention';
        
        if (animate) {
            linkMention.classList.add('animate');
        }

        linkMention.innerHTML = `
            <div class="icon"></div>
            <div class="link-text">${link.title}</div>
        `;
        
        linkMention.addEventListener('click', (e) => {
            e.stopPropagation();

            // Get the current page's URL from the window object
            const currentPageUrl = window.location.href;

            // Only send the message if the current page is not the target page
            if (decodeURIComponent(currentPageUrl) !== decodeURIComponent(link.url)) {
                chrome.runtime.sendMessage({
                    action: 'open_content',
                    data: { 
                        packetId: currentInstanceId, 
                        url: link.url,
                        source: 'overlay_link_click'
                    }
                });
            }
        });

        overlay.appendChild(linkMention);
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'sync_overlay_state') {
            const state = message.data;

            if (state.isVisible) {
                buildOverlayIfNeeded();
                updateOverlayUI(state);
                setOverlayVisibility(true, state.animate);
            } else {
                setOverlayVisibility(false, false);
            }
            sendResponse({ success: true });
            return true;
        }
    });

})();