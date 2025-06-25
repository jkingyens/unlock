// ext/preview.js
document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const pageId = params.get('pageId');

    if (!pageId) {
        document.body.innerHTML = '<h1>Error: No pageId provided.</h1>';
        return;
    }

    // Listener for the response from the sidebar
    chrome.runtime.onMessage.addListener(function handleResponse(message) {
        if (message.action === 'draft_item_content_response' && message.data.pageId === pageId) {
            const frame = document.getElementById('content-frame');
            
            // Set the page title
            if (message.data.title) {
                document.title = message.data.title;
            }

            if (frame && message.data.htmlContent) {
                // Use a sandboxed data URI for the iframe content
                const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(message.data.htmlContent);
                frame.src = dataUrl;
            } else if (frame) {
                frame.srcdoc = '<h1>Error: Could not load content.</h1>';
            }
            // Clean up listener once we have our content
            chrome.runtime.onMessage.removeListener(handleResponse);
        }
    });

    // Request the content from the sidebar
    chrome.runtime.sendMessage({
        action: 'get_draft_item_for_preview',
        data: { pageId: pageId }
    });
});