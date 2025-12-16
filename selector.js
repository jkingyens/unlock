// ext/selector.js

if (!window.unlockSelectorInitialized) {
    window.unlockSelectorInitialized = true;

    let activeTool = null;
    let overlay = null;

    function createOverlay() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'unlock-selector-overlay';
        const toolText = activeTool === 'image' ? 'drag an image' : 'select text';
        overlay.innerHTML = `
            <div class="unlock-selector-box">
                <span class="unlock-selector-indicator"></span>
                <p>Unlock tool is active. <strong>${toolText.toUpperCase()}</strong> on the page to capture it.</p>
            </div>
        `;
        document.body.appendChild(overlay);
        // Add a class to the body for general styling hooks
        document.body.classList.add('unlock-tool-active');
    }

    function removeOverlay() {
        if (overlay) {
            overlay.remove();
            overlay = null;
        }
        document.body.classList.remove('unlock-tool-active');
    }

    function cleanup() {
        document.body.classList.remove('unlock-text-tool-active', 'unlock-image-tool-active');
        document.removeEventListener('mouseup', handleTextSelection);
        document.removeEventListener('dragstart', handleImageDrag);
        activeTool = null;
        removeOverlay();
    }

    function activateTool(toolType) {
        cleanup();
        activeTool = toolType;
        document.body.classList.add(`unlock-${toolType}-tool-active`);
        createOverlay(); // Create the overlay with the correct text

        if (toolType === 'text') {
            document.addEventListener('mouseup', handleTextSelection);
        } else if (toolType === 'image') {
            document.addEventListener('dragstart', handleImageDrag, true);
        }
    }

    function handleTextSelection(e) {
        if (activeTool !== 'text') return;
        const selectedText = window.getSelection().toString().trim();
        if (selectedText) {
            chrome.runtime.sendMessage({
                action: 'content_script_data_captured',
                data: {
                    type: 'text/plain',
                    payload: selectedText
                }
            });
            cleanup(); // Deactivate after successful capture
        }
    }

    function handleImageDrag(e) {
        if (activeTool !== 'image' || e.target.tagName !== 'IMG') return;
        chrome.runtime.sendMessage({
            action: 'content_script_data_captured',
            data: {
                type: 'image/png', // Simplified assumption
                payload: e.target.src
            }
        });
        cleanup(); // Deactivate after successful capture
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'activate_selector_tool') {
            activateTool(message.data.toolType);
        } else if (message.action === 'deactivate_selector_tool') {
            cleanup();
        }
    });
}