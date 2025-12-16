chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  if (msg.type === 'execute_code') {
    const sandboxFrame = document.getElementById('sandbox-frame');
    console.log("[Offscreen] 🚀 Sending code to sandbox...");

    // 1. Listen for results AND logs
    const messageListener = (event) => {
      const data = event.data;
      if (!data) return;

      // HANDLER: Logs from Sandbox
      if (data.type === 'SANDBOX_LOG') {
        const prefix = `[Sandbox ${data.level}]`;
        if (data.level === 'ERR') console.error(prefix, data.message);
        else console.log(prefix, data.message);
      }

      // HANDLER: Execution Result
      if (data.type === 'EXECUTION_COMPLETE') {
        console.log("[Offscreen] ✅ Finished:", data.result);
        window.removeEventListener('message', messageListener);
        sendResponse({ result: data.result });
      }
    };
    window.addEventListener('message', messageListener);

    // 2. Post the code
    sandboxFrame.contentWindow.postMessage({
      type: 'RUN_IN_SANDBOX',
      code: msg.code
    }, '*');

    return true;
  }
});