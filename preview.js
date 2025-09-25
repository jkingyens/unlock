// ext/preview.js
console.log("Unlock Preview Script Version: 1.97");
document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const rlr = params.get('rlr'); // For draft previews
    const instanceId = params.get('instanceId'); // For instance previews
    const lrl = params.get('lrl'); // For instance previews
    const frame = document.getElementById('content-frame');

    const displayContent = (htmlContent, title) => {
        if (title) {
            document.title = title;
        }
        if (frame && htmlContent) {
            const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent);
            frame.src = dataUrl;
        } else if (frame) {
            frame.srcdoc = '<h1>Error: Could not load content.</h1>';
        }
    };
    
    // --- START OF FIX: Send destination URL to background for robust handling ---
    window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'unlock-navigate' && event.data.url) {
            // Instead of navigating directly, ask the background script to handle it.
            // This leverages the centralized openOrFocusContent logic which correctly
            // handles finding existing tabs and preventing duplicates.
            chrome.runtime.sendMessage({
                action: 'open_content_from_preview',
                data: { 
                    instanceId: instanceId, // The instanceId is in the preview.html URL
                    url: event.data.url 
                }
            });
        }
    });
    // --- END OF FIX ---

    if (rlr) { // Handle draft previews
        chrome.runtime.sendMessage({
            action: 'get_draft_item_for_preview',
            data: { rlr: rlr }
        }, (response) => {
            if (response && response.success) {
                displayContent(response.htmlContent, response.title);
            } else {
                 if(frame) frame.srcdoc = `<h1>Error: ${response?.error || 'Could not load preview.'}</h1>`;
            }
        });
    } else if (instanceId && lrl) { // Handle cached HTML for instances
        chrome.runtime.sendMessage({
            action: 'get_cached_html_content',
            data: { instanceId, lrl }
        }, (response) => {
            if (response && response.success) {
                displayContent(response.htmlContent, response.title);
            } else {
                if(frame) frame.srcdoc = `<h1>Error: ${response?.error || 'Could not load cached content.'}</h1>`;
            }
        });
    } else {
        if(frame) frame.srcdoc = '<h1>Error: No resource locator provided.</h1>';
    }
});