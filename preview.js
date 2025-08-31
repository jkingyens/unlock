// ext/preview.js
document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const rlr = params.get('rlr'); // REFACTOR: Get 'rlr' instead of 'pageId'

    if (!rlr) {
        document.body.innerHTML = '<h1>Error: No resource locator provided.</h1>';
        return;
    }

    chrome.runtime.sendMessage({
        action: 'get_draft_item_for_preview',
        data: { rlr: rlr } // REFACTOR: Send 'rlr' in the message
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