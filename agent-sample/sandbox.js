// 1. PROXY LOGGER: Send logs to the parent window
function sendLog(level, args) {
  try {
    const message = args.map(arg => {
      if (arg instanceof Error) return arg.message + '\n' + arg.stack;
      try { return JSON.stringify(arg); } catch(e) { return String(arg); }
    }).join(' ');

    window.parent.postMessage({
      type: 'SANDBOX_LOG',
      level: level,
      message: message
    }, '*');
  } catch (e) {
    // Failsafe
  }
}

// Overwrite console methods
const originalLog = console.log;
console.log = (...args) => { originalLog(...args); sendLog('LOG', args); };
console.error = (...args) => { originalLog(...args); sendLog('ERR', args); };
console.warn = (...args) => { originalLog(...args); sendLog('WARN', args); };

// 2. SIGNAL READY
console.log("🟢 SANDBOX SCRIPT STARTED");

window.addEventListener('message', async (event) => {
  console.log("📨 Message received: " + event.data.type);

  const { type, code } = event.data;

  if (type === 'RUN_IN_SANDBOX') {
    try {
      console.log("📦 Creating Blob...");
      const blob = new Blob([code], { type: 'text/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      console.log("🔗 Blob URL: " + blobUrl);

      console.log("⏳ Importing Module...");
      const module = await import(blobUrl);
      console.log("✅ Module Imported. Exports: " + Object.keys(module));

      if (!module.run) throw new Error("No 'run' export found!");

      console.log("🏃 Running...");
      const result = await module.run();
      console.log("🎉 Result: " + result);

      event.source.postMessage({ type: 'EXECUTION_COMPLETE', result }, event.origin);
      
    } catch (err) {
      console.error("💥 CRASH: " + err.message);
      event.source.postMessage({ 
        type: 'EXECUTION_COMPLETE', 
        result: 'Sandbox Error: ' + err.message 
      }, event.origin);
    }
  }
});