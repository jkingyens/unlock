// ext/page_interceptor.js
// This script is embedded in generated HTML pages to handle link clicks securely.

console.log("Unlock Interceptor: Script loaded successfully.");

document.body.addEventListener('click', function(event) {
    // Determine if the page is running inside an iframe
    const isInsideIframe = (window.self !== window.top);

    // --- The Fix ---
    // Only intercept clicks if running inside the extension's preview iframe.
    if (isInsideIframe) {
        console.log("Unlock Interceptor: Running in iframe, will intercept clicks.");
        
        let target = event.target;
        // Traverse up the DOM tree to find the parent <a> tag if a child element was clicked
        while (target && target.tagName !== 'A') {
            target = target.parentElement;
        }

        if (target && target.tagName === 'A' && target.href) {
            console.log("Unlock Interceptor: Link click intercepted!", { href: target.href });
            // Prevent the iframe from navigating internally
            event.preventDefault();
            
            // Send a message to the parent window (preview.html) with the destination URL.
            console.log("Unlock Interceptor: Sending 'unlock-navigate' message to parent.");
            window.top.postMessage({
                type: 'unlock-navigate',
                url: target.href
            }, '*'); // Use a specific origin in production if possible
        }
    }
    // If not running in an iframe, this listener does nothing, and the browser
    // handles the link click with its default navigation behavior.
});