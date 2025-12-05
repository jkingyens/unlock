// ext/sandbox.js
console.log("[Sandbox] Initialized. SharedArrayBuffer:", typeof SharedArrayBuffer !== 'undefined', "WebAssembly.promising:", typeof WebAssembly.promising);

const pendingRequests = new Map();

function bridgeCall(type, data) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        pendingRequests.set(requestId, { resolve, reject });
        window.parent.postMessage({ type, requestId, ...data }, '*');
    });
}

// 1. Define Global Bridge (Accessed by the bundled bridge-impl.js)
globalThis.JCO_BRIDGE = {
    ask: async (prompt) => {
        console.log("[Sandbox] Asking AI:", prompt);
        try {
            const result = await bridgeCall('BRIDGE_AI_REQUEST', { prompt });
            return String(result);
        } catch (e) {
            return `Error: ${e.message}`;
        }
    },
    log: (msg) => console.log(`[Sandbox Agent] ${msg}`)
};

window.addEventListener('message', (event) => {
    const { type, requestId, success, data, payload } = event.data;

    if (type === 'BRIDGE_AI_RESPONSE') {
        const resolver = pendingRequests.get(requestId);
        if (resolver) {
            resolver.resolve(success ? data : `Error: ${data}`);
            pendingRequests.delete(requestId);
        }
    }

    if (type === 'EXECUTE_AGENT') {
        executeAgentCode(payload.code);
    }
});

async function executeAgentCode(codeString) {
    try {
        console.log("[Sandbox] Loading Agent...");
        const blob = new Blob([codeString], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);

        // 2. Import the Bundled Module
        // This module self-instantiates because we inlined the Wasm.
        // It self-wires because we bundled the bridge.
        const agentModule = await import(url);

        // 3. Run
        if (agentModule.run) {
            console.log("[Sandbox] Running Agent...");
            const result = await agentModule.run();
            window.parent.postMessage({ type: 'AGENT_EXECUTION_COMPLETE', result }, '*');
        } else {
            throw new Error("Agent module does not export 'run'.");
        }

        URL.revokeObjectURL(url);
    } catch (e) {
        console.error("[Sandbox] Execution Error:", e);
        window.parent.postMessage({ type: 'AGENT_EXECUTION_COMPLETE', result: `Error: ${e.message}` }, '*');
    }
}

window.parent.postMessage({ type: 'SANDBOX_READY' }, '*');