// ext/overlay.js
// REVISED: This script is now a passive, state-driven view.
// It is injected universally and waits for 'sync_overlay_state' messages
// from the background script to build, update, or hide itself.
// REVISED: It now checks for an 'animate' flag to trigger the glide-in animation.

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

    // --- Core UI Management Functions ---

    function buildOverlayIfNeeded() {
        if (document.getElementById(OVERLAY_ID)) return; // Already built

        const container = document.createElement('div');
        container.id = OVERLAY_ID;
        // The shadow root isolates the overlay's CSS from the host page.
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

        // REVISED: Send a unified action request instead of a specific command.
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

        // Update topic text
        const textElement = shadowRoot.querySelector('.unlock-overlay-text');
        if (textElement && state.topic) {
            textElement.textContent = state.topic;
        }

        // Update play/pause button icon
        const btn = shadowRoot.querySelector('.unlock-overlay-play-pause-btn');
        if (btn) {
            btn.innerHTML = `<div class="icon ${isPlaying ? 'pause-icon' : 'play-icon'}"></div>`;
        }

        // Update animation of the "dancing bars"
        const bars = shadowRoot.querySelector('.unlock-overlay-bars');
        if (bars) {
            bars.querySelectorAll('.bar').forEach(bar => {
                bar.style.animationPlayState = isPlaying ? 'running' : 'paused';
            });
        }

        // Update link mention display
        if (state.lastMentionedLink && state.lastMentionedLink.url !== lastShownLinkUrl) {
            lastShownLinkUrl = state.lastMentionedLink.url;
            showLinkMention(state.lastMentionedLink);
        } else if (!state.lastMentionedLink && lastShownLinkUrl) {
            // If playback seeks backward or link is gone, clear the mention
            lastShownLinkUrl = null;
            const existingMention = shadowRoot.querySelector('.unlock-overlay-link-mention');
            if (existingMention) existingMention.remove();
        }
    }

    function setOverlayVisibility(visible, animate) {
        const overlay = document.getElementById(OVERLAY_ID)?.shadowRoot?.getElementById('unlock-media-overlay');
        if (overlay) {
            if (animate) {
                // Add a class to trigger the animation, then remove it so it can be re-triggered later.
                overlay.classList.add('animate-in');
                setTimeout(() => {
                    overlay.classList.remove('animate-in');
                }, 500); // Duration should be longer than the CSS transition
            }
            overlay.classList.toggle('visible', visible);
        }
    }
    
    function showLinkMention(link) {
        const overlay = document.getElementById(OVERLAY_ID)?.shadowRoot?.getElementById('unlock-media-overlay');
        if (!overlay) return;

        // Remove any existing mention before showing a new one
        const existingMention = overlay.querySelector('.unlock-overlay-link-mention');
        if (existingMention) {
            existingMention.remove();
        }

        const linkMention = document.createElement('div');
        linkMention.className = 'unlock-overlay-link-mention';
        linkMention.innerHTML = `
            <div class="icon"></div>
            <div class="link-text">${link.title}</div>
        `;
        
        linkMention.addEventListener('click', (e) => {
            e.stopPropagation();
            chrome.runtime.sendMessage({
                action: 'open_content',
                data: { 
                    packetId: currentInstanceId, 
                    url: link.url,
                    source: 'overlay_link_click'
                }
            });
        });

        overlay.appendChild(linkMention);
    }

    // --- REVISED: Single Message Listener with Animation Logic ---
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'sync_overlay_state') {
            const state = message.data;

            if (state.isVisible) {
                // If the overlay needs to be visible, ensure it's built and updated.
                buildOverlayIfNeeded();
                updateOverlayUI(state);
                setOverlayVisibility(true, state.animate);
            } else {
                // If the overlay should be hidden, just toggle its visibility without animation.
                setOverlayVisibility(false, false);
            }
            sendResponse({ success: true });
            return true;
        }
    });

})();