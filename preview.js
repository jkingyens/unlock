// ext/preview.js
document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const rlr = params.get('rlr'); // REFACTOR: Get 'rlr' instead of 'pageId'
    const instanceId = params.get('instanceId');
    const lrl = params.get('lrl');
    const frame = document.getElementById('content-frame');


    if (rlr) { // Handle draft previews
        chrome.runtime.sendMessage({
            action: 'get_draft_item_for_preview',
            data: { rlr: rlr } // REFACTOR: Send 'rlr' in the message
        }, (response) => {
            if (response && response.success) {
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
                 if(frame) frame.srcdoc = `<h1>Error: ${response?.error || 'Could not load preview.'}</h1>`;
            }
        });
    } else if (instanceId && lrl) { // Handle cached HTML
        chrome.runtime.sendMessage({
            action: 'get_cached_html_content',
            data: { instanceId, lrl }
        }, (response) => {
            if (response && response.success) {
                if (response.title) {
                    document.title = response.title;
                }
                if (frame && response.htmlContent) {
                    // Create a Blob from the HTML content
                    const blob = new Blob([response.htmlContent], { type: 'text/html' });
                    // Create a URL for the Blob and set it as the iframe's src
                    frame.src = URL.createObjectURL(blob);
                } else if (frame) {
                    frame.srcdoc = '<h1>Error: Could not load content.</h1>';
                }
            } else {
                if(frame) frame.srcdoc = `<h1>Error: ${response?.error || 'Could not load cached content.'}</h1>`;
            }
        });
    } else {
        if(frame) frame.srcdoc = '<h1>Error: No resource locator provided.</h1>';
    }
});