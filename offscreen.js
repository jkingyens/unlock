// ext/offscreen.js

// Listen for messages from the service worker
chrome.runtime.onMessage.addListener(handleMessages);

function handleMessages(request, sender, sendResponse) {
  if (request.target !== 'offscreen') {
    return false;
  }

  switch (request.type) {
    case 'parse-html-for-text':
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(request.data, 'text/html');
        // Use a more robust text extraction
        const reader = new readability.Readability(doc);
        const article = reader.parse();
        const textContent = article ? article.textContent : doc.body.innerText;
        
        sendResponse({ success: true, data: textContent });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
      break;
  }
  // return true to indicate you wish to send a response asynchronously
  return true;
}

// Simple Readability.js polyfill to improve text extraction
const readability = {
    Readability: class {
        constructor(doc) { this.doc = doc; }
        parse() {
            // This is a simplified stand-in. A real implementation would be complex.
            // For now, it prioritizes <article>, <main>, or falls back to body.
            const articleEl = this.doc.querySelector('article');
            if (articleEl) return { textContent: articleEl.innerText };
            const mainEl = this.doc.querySelector('main');
            if (mainEl) return { textContent: mainEl.innerText };
            return { textContent: this.doc.body.innerText };
        }
    }
};