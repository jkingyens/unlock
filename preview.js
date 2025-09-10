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
    
    window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'unlock-navigate' && event.data.url) {
            window.location.href = event.data.url;
        }
    });

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