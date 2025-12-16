document.getElementById('runBtn').addEventListener('click', async () => {
  const statusDiv = document.getElementById('status');
  statusDiv.textContent = "Loading WASM...";

  try {
    // 1. Load the generated WASM payload file
    const responseJs = await fetch('./remote-payload.js');
    if (!responseJs.ok) throw new Error("Failed to load remote-payload.js");
    const wasmModuleCode = await responseJs.text();

    // 2. Add the 'run' function that calls our WASM 'add' function
    const fullRemoteCode = wasmModuleCode + `
      export async function run() {
        // 'add' is the function we defined in logic.js
        const result = add(10, 20); 
        return "WASM Calculator Result: " + result;
      }
    `;

    // 3. Send it to the background script
    const response = await chrome.runtime.sendMessage({ 
      action: 'run_remote_code', 
      code: fullRemoteCode 
    });

    statusDiv.textContent = response.result;

  } catch (e) {
    statusDiv.textContent = "Error: " + e.message;
  }
});