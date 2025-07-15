// ext/preview.js
document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const pageId = params.get('pageId');

    if (!pageId) {
        document.body.innerHTML = '<h1>Error: No pageId provided.</h1>';
        return;
    }

    // --- FIX START: Send message to background and handle direct response ---
    chrome.runtime.sendMessage({
        action: 'get_draft_item_for_preview',
        data: { pageId: pageId }
    }, (response) => {
        if (response && response.success) {
            const frame = document.getElementById('content-frame');
            if (response.title) {
                document.title = response.title;
            }
            if (frame && response.htmlContent) {
                const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(response.htmlContent);
                frame.src = dataUrl;
            } else if (frame) {
                frame.srcdoc = '<h1>Error: Could not load content.</h1>';
            }
        } else {
            document.body.innerHTML = `<h1>Error: ${response?.error || 'Could not load preview.'}</h1>`;
        }
    });
    
});