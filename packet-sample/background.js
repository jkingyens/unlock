// 1. Setup the Offscreen Document
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Sandboxed execution relay',
  });
}

// 2. Listen for the Popup's message
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'run_remote_code') {
    (async () => {
      await ensureOffscreen();

      // 3. Forward to Offscreen
      const response = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'execute_code',
        code: msg.code
      });
      
      sendResponse(response);
    })();
    return true; // Keep channel open for async response
  }
});