// ext/selector.js

if (!window.unlockSelectorInitialized) {
    window.unlockSelectorInitialized = true;

    let activeTool = null;
    const highlightClass = 'unlock-highlight-target';
    const bodyClassPrefix = 'unlock-tool-active-';

    function cleanup() {
        document.body.classList.remove(bodyClassPrefix + 'text', bodyClassPrefix + 'image');
        document.querySelectorAll('.' + highlightClass).forEach(el => el.classList.remove(highlightClass));
        document.removeEventListener('mouseup', handleTextSelection);
        document.removeEventListener('dragstart', handleImageDrag);
        activeTool = null;
    }

    function activateTool(toolType) {
        cleanup();
        activeTool = toolType;
        document.body.classList.add(bodyClassPrefix + toolType);

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
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'activate_selector_tool') {
            activateTool(message.data.toolType);
        } else if (message.action === 'deactivate_selector_tool') {
            cleanup();
        }
    });
}