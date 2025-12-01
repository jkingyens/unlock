// ext/sandbox.js

console.log("[Sandbox] Initialized.");

// 1. Define Host Capabilities (The 'imports' object for JCO)
// These are the functions the WASM/Agent can call.
const hostCapabilities = {
    ai: {
        // This matches the WIT signature: ask-ai: func(prompt: string) -> string;
        ask: async (prompt) => {
            console.log("[Sandbox] WASM requested AI:", prompt);
            return await bridgeCall('BRIDGE_AI_REQUEST', { prompt });
        }
    },
    console: {
        log: (msg) => console.log("[Sandbox Agent]", msg)
    }
};

// 2. The Bridge Logic (Messaging with Offscreen)
const pendingRequests = new Map();

window.addEventListener('message', (event) => {
    const { type, requestId, success, data, error, payload } = event.data;

    // Handle responses from Offscreen
    if (type === 'BRIDGE_AI_RESPONSE') {
        const resolver = pendingRequests.get(requestId);
        if (resolver) {
            if (success) resolver.resolve(data);
            else resolver.reject(new Error(error));
            pendingRequests.delete(requestId);
        }
    }

    // Handle Execute Command (Simulating downloading and running the agent)
    if (type === 'EXECUTE_AGENT') {
        runAgent(payload);
    }
});

function bridgeCall(type, data) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        pendingRequests.set(requestId, { resolve, reject });
        window.parent.postMessage({ type, requestId, ...data }, '*');
    });
}

// 3. The "Runtime"
// In a real JCO setup, 'agentCode' would be the transpiled JS from 'jco transpile'.
async function runAgent(agentModuleCode) {
    try {
        console.log("[Sandbox] Loading Agent...");
        
        // In a real scenario, we would dynamic import() the blob.
        // For this test, we use a Data URI to simulate a "remote" downloaded module.
        const blob = new Blob([agentModuleCode], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        
        // --- JCO MAGIC HAPPENS HERE ---
        // We import the module and pass it our capabilities.
        // The module uses top-level await or JSPI to call our async hostCapabilities.
        const agent = await import(url);
        
        if (agent.run) {
            const result = await agent.run(hostCapabilities);
            window.parent.postMessage({ type: 'AGENT_EXECUTION_COMPLETE', result }, '*');
        }
        
        URL.revokeObjectURL(url);
    } catch (e) {
        console.error("[Sandbox] Agent Crash:", e);
    }
}