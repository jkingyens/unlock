// ext/overlay.js

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
    let justShown = false; // Guard to prevent immediate hiding

    // --- Core Functions ---

    function buildOverlay(topic, instanceId) {
        if (document.getElementById(OVERLAY_ID)) return; // Already built

        currentInstanceId = instanceId;

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
                    <div class="unlock-overlay-text">${topic || 'Playing Packet'}</div>
                </div>
            </div>
        `;

        document.body.appendChild(container);

        // --- Event Listeners ---
        const overlay = shadowRoot.getElementById('unlock-media-overlay');
        const playPauseBtn = shadowRoot.querySelector('.unlock-overlay-play-pause-btn');

        playPauseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            chrome.runtime.sendMessage({ action: 'toggle_media_playback' });
        });
        
        overlay.addEventListener('click', () => {
            chrome.runtime.sendMessage({ 
                action: 'open_sidebar_and_navigate',
                data: {
                    targetView: 'packet-detail',
                    instanceId: currentInstanceId
                }
            });
        });
    }

    function setOverlayVisibility(visible) {
        if (!visible && justShown) {
            return; // Ignore hide command right after being shown
        }
        const overlay = document.getElementById(OVERLAY_ID)?.shadowRoot?.getElementById('unlock-media-overlay');
        if (overlay) {
            overlay.classList.toggle('visible', visible);
        }
    }
    
    function destroyOverlay() {
        const container = document.getElementById(OVERLAY_ID);
        if (container) {
            container.remove();
        }
        window.unlockOverlayInjected = false; // Allow re-injection next time
    }

    function updatePlaybackState(state) {
        const shadowRoot = document.getElementById(OVERLAY_ID)?.shadowRoot;
        if (!shadowRoot) return;

        isPlaying = state.isPlaying;
        const btn = shadowRoot.querySelector('.unlock-overlay-play-pause-btn');
        const bars = shadowRoot.querySelector('.unlock-overlay-bars');

        if (btn) {
            btn.innerHTML = `<div class="icon ${isPlaying ? 'pause-icon' : 'play-icon'}"></div>`;
        }
        if (bars) {
            bars.querySelectorAll('.bar').forEach(bar => {
                bar.style.animationPlayState = isPlaying ? 'running' : 'paused';
            });
        }

        if (state.lastMentionedLink && state.lastMentionedLink.url !== lastShownLinkUrl) {
            lastShownLinkUrl = state.lastMentionedLink.url;
            showLinkMention(state.lastMentionedLink);
        } else if (!state.lastMentionedLink && lastShownLinkUrl) {
            // If playback seeks backward, clear the link mention
            lastShownLinkUrl = null;
            const existingMention = shadowRoot.querySelector('.unlock-overlay-link-mention');
            if (existingMention) existingMention.remove();
        }
    }

    function showLinkMention(link) {
        const overlay = document.getElementById(OVERLAY_ID)?.shadowRoot?.getElementById('unlock-media-overlay');
        if (!overlay) return;

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

    // --- Message Listener ---
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        switch (message.action) {
            case 'show_overlay':
                buildOverlay(message.data.topic, message.data.instanceId, message.data);
                updatePlaybackState(message.data);
                setOverlayVisibility(message.data.animate !== false);
                justShown = true;
                setTimeout(() => { justShown = false; }, 500); // Guard for 500ms
                break;
            case 'set_overlay_visibility':
                setOverlayVisibility(message.data.visible);
                break;
            case 'destroy_overlay':
                destroyOverlay();
                break;
            case 'playback_state_updated':
                updatePlaybackState(message.data);
                break;
        }
        sendResponse({ success: true });
        return true; 
    });
})();