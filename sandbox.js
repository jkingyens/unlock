// ext/sandbox.js
console.log("[Sandbox] Initialized. SharedArrayBuffer:", typeof SharedArrayBuffer !== 'undefined', "WebAssembly.promising:", typeof WebAssembly.promising);

const pendingRequests = new Map();
let requestIdCounter = 0;
let currentInstanceId = null;

function callHost(type, data) {
    return new Promise((resolve, reject) => {
        const requestId = requestIdCounter++;
        pendingRequests.set(requestId, { resolve, reject });
        window.parent.postMessage({ type, requestId, data: { ...data, instanceId: currentInstanceId } }, '*');
    });
}

// 1. Define Global Bridge (Accessed by the bundled bridge-impl.js)
globalThis.JCO_BRIDGE = {
    ask: async (prompt) => {
        console.log('[Sandbox] Asking AI:', prompt);
        try {
            const result = await callHost('BRIDGE_AI_REQUEST', { prompt });
            return String(result);
        } catch (e) {
            return 'Error: ' + (e.message || String(e));
        }
    },
    log: (msg) => {
        console.log('[Sandbox Agent]', msg);
    },
    quest: {
        registerTask: (id, title, desc) => callHost('quest_register_task', { id, title, desc }),
        updateTask: (id, taskId, status) => callHost('quest_update_task', { id, taskId, status }),
        notifyPlayer: (message) => callHost('quest_notify', { message }),
        getCurrentUrl: () => callHost('quest_get_url', {}),
        registerItem: (id, url, title, type) => callHost('quest_register_item', { id, url, title, type })
    }
};

window.addEventListener('message', (event) => {
    const { type, requestId, success, data, payload } = event.data;

    if (type === 'BRIDGE_AI_RESPONSE') {
        const resolver = pendingRequests.get(requestId);
        if (resolver) {
            resolver.resolve(success ? data : `Error: ${data} `);
            pendingRequests.delete(requestId);
        }
    }

    if (type === 'EXECUTE_AGENT') {
        executeAgentCode(payload.code, payload);
    }

    if (type === 'EXECUTE_AGENT_FROM_URL') {
        executeAgentFromUrl(payload.url, payload);
    }
});

async function executeAgentCode(codeString, payload) {
    try {
        console.log("[Sandbox] Loading Agent (Eval Code)...");
        const blob = new Blob([codeString], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        try {
            await executeAgentFromUrl(url, payload);
        } finally {
            URL.revokeObjectURL(url);
        }
    } catch (e) {
        console.error("[Sandbox] Execution Error:", e);
        window.parent.postMessage({ type: 'AGENT_EXECUTION_COMPLETE', result: `Error: ${e.message} ` }, '*');
    }
}

async function executeAgentFromUrl(url, payload) {
    try {
        console.log("[Sandbox] Loading Agent from URL:", url);
        currentInstanceId = payload.instanceId; // Set current Instance ID
        // Import module directly from the URL (host must support CORS or be same-origin/extension-scheme)
        const agentModule = await import(url);

        activeAgentModule = agentModule;

        // Debug: Log all available exports
        console.log("[Sandbox] Agent exports:", Object.keys(agentModule));

        // Python componentize-py wraps exports in an 'exports' object
        if (agentModule.init) {
            console.log("[Sandbox] Initializing Quest Agent (JavaScript)...");
            await agentModule.init();
            window.parent.postMessage({ type: 'AGENT_EXECUTION_COMPLETE', result: "Quest Initialized" }, '*');
        } else if (agentModule.exports && agentModule.exports.init) {
            console.log("[Sandbox] Initializing Quest Agent (Python)...");
            activeAgentModule = agentModule.exports;
            await agentModule.exports.init();
            window.parent.postMessage({ type: 'AGENT_EXECUTION_COMPLETE', result: "Quest Initialized" }, '*');
        } else if (agentModule.run) {
            console.log("[Sandbox] Running Agent (Standard Mode)...");
            const userScript = payload.args?.code || "print('Hello from Agent')";
            const result = await agentModule.run(userScript);
            window.parent.postMessage({ type: 'AGENT_EXECUTION_COMPLETE', result }, '*');
        } else if (agentModule.runCode) {
            // Backward compatibility for older packets
            console.log("[Sandbox] Running Agent (Legacy Mode)...");
            const userScript = payload.args?.code || "print('Hello from Agent')";
            const result = await agentModule.runCode(userScript);
            window.parent.postMessage({ type: 'AGENT_EXECUTION_COMPLETE', result }, '*');
        } else {
            throw new Error("Agent module does not export 'init', 'run', or 'runCode'.");
        }
    } catch (e) {
        console.error("[Sandbox] URL Execution Error:", e);
        window.parent.postMessage({ type: 'AGENT_EXECUTION_COMPLETE', result: `Error: ${e.message} ` }, '*');
        throw e;
    }
}

// Store active agent module to dispatch events
let activeAgentModule = null;

window.addEventListener('message', async (event) => {
    const { type, requestId, success, data, payload } = event.data;

    // Handle generic Host Responses (for callHost)
    if (type === 'HOST_RESPONSE' || type === 'BRIDGE_AI_RESPONSE') {
        const resolver = pendingRequests.get(requestId);
        if (resolver) {
            resolver.resolve(success ? data : `Error: ${data} `);
            pendingRequests.delete(requestId);
        }
    } else if (type === 'NAVIGATE') {
        // Dispatch navigation event to the agent
        if (activeAgentModule && activeAgentModule.onVisit) {
            console.log(`[Sandbox] Dispatching onVisit('${payload.url}')`);
            try {
                activeAgentModule.onVisit(payload.url);
            } catch (e) {
                console.error("[Sandbox] onVisit error:", e);
            }
        }
    } else if (type === 'EXECUTE_AGENT') {
        executeAgentCode(payload.code, payload);
    } else if (type === 'EXECUTE_AGENT_FROM_URL') {
        executeAgentFromUrl(payload.url, payload);
    } else if (type === 'EXECUTE_AGENT_FROM_SOURCE') {
        const { code, shims, wasmFiles } = payload;

        // 0. Pre-process Shims to Replace Relative Imports
        // Shims import each other using relative paths like './io.js'
        // We need to rewrite these to use the same Placeholders we use for the main agent
        // Example: "import { streams } from './io.js'" -> "import { streams } from '__SHIM_IO__'"

        const processedShims = {};
        if (shims) {
            Object.keys(shims).forEach(name => {
                let shimCode = shims[name];
                // Replace relative imports of other shims
                Object.keys(shims).forEach(otherName => {
                    const importRegex = new RegExp(`['"]\\.\\/${otherName}\\.js['"]`, 'g');
                    const placeholder = `__SHIM_${otherName.toUpperCase()}__`;
                    shimCode = shimCode.replace(importRegex, `"${placeholder}"`);
                });
                processedShims[name] = shimCode;
            });
        }

        const shimUrls = {};
        const createdUrls = []; // Track for cleanup

        // Handle Wasm Files
        if (wasmFiles) {
            console.log("[Sandbox] Wasm Files received:", Object.keys(wasmFiles));
            Object.entries(wasmFiles).forEach(([filename, content]) => {
                const blob = new Blob([content], { type: 'application/wasm' });
                const url = URL.createObjectURL(blob);
                shimUrls[filename] = url; // Store in map for replacement
                createdUrls.push(url);
                console.log(`[Sandbox] Created Blob for Wasm: ${filename} -> ${url}`);
            });
        }

        // 1. Create Placeholder Map -> Blob URL (Future)
        // We need to do this in two passes or use a "deferred" approach?
        // Actually, we can just assign the UUID placeholders first, create blobs, then replace placeholders?
        // No, we need the Blob URL to put IN the code.
        // But the code needs to be IN the Blob.
        // Cyclic dependency if we use Blob URLs directly!

        // Circular Dependency Solution:
        // Use Import Maps? Sandbox might not support them nicely with Blob URLs.
        // BETTER: Use `URL.createObjectURL` is deterministic? No.

        // WAITING: If shims have cycles (A imports B, B imports A), we can't bake the Blob URL of B into A before A is created.
        // Do they have cycles?
        // cli -> io, environment, config
        // io -> ?
        // If no cycles, we can topologically sort.
        // If cycles, we must use an Import Map.

        // Let's TRY constructing an Import Map data-blob? 
        // Or assume the browser supports `<script type="importmap">` in the sandbox?
        // We can inject an import map into the DOM!

        // NEW STRATEGY: 
        // 1. Create Blobs for all shims using their ORIGINAL Placeholders (unreplaced).
        //    Wait, they need valid import specifiers.
        //    `import ... from "__SHIM_IO__"` is not valid unless mapped.
        // 2. Generate an Import Map that maps `__SHIM_IO__` -> `blob:uuid-of-io`.
        // 3. Inject this Import Map.
        // 4. Then we don't need to replace ANYTHING in the shims! Just leave `./io.js`?
        //    No, `./io.js` is relative. Blob URLs have no directory structure.

        // REVISED STRATEGY:
        // 1. Rewrite all relative shim imports to absolute placeholders: `import ... from "shim://io"`.
        // 2. Rewrite main agent imports to same placeholders.
        // 3. Create Blobs for all code (agent + shims).
        // 4. Inject `<script type="importmap">` mapping `"shim://io": "blob:..."`.
        // 5. Build/Run.

        // Does Chrome Extension Sandbox support Import Maps? It should (Chrome 89+).

        // const shimUrls = {}; // MOVED UP
        // const createdUrls = []; // MOVED UP

        // Rewrite imports in Shims to be Map-friendly keys
        // We'll use bare specifiers like "shim/io"
        // STRATEGY: Direct Replacement (No Import Map)
        // Chrome doesn't support external Import Maps (src="blob:...") well, and CSP blocks inline.
        // We will manually link the modules by replacing import paths with Blob URLs.

        // 1. Create PRELIMINARY Blob URLs for all shims (to get the UUIDs)
        // Wait, we can't get a Blob URL without a Blob. 
        // And we can't close the loop if we need the URL inside the Blob content.
        // BUT: The shims are a Directed Acyclic Graph (DAG). 
        // We can just use placeholders first? No, we need valid URLs in the final code.

        // Recursive dependency resolution is hard if we don't know the order.
        // FORTUNATELY: The `preview2-shim` deps are simple.
        // most -> io.js.
        // So if we create IO first, we can use its URL in others.

        // BETTER: Create Blob URLs for EVERYTHING using a placeholder first? 
        // No, Blob content is immutable.

        // FORCE BRUTE FORCE:
        // We will just generate random UUIDs for our "virtual" files?
        // No, we need actual `blob:` URLs which are browser-generated.

        // OK, we must topologically sort or multipass?
        // Let's just create them in a safe order?
        // shims: cli, clocks, filesystem, http, io, random, sockets
        // Deps:
        // io: none
        // clocks: none
        // random: none
        // cli: io, environment, config
        // filesystem: io
        // http: io
        // sockets: io
        // environment: none? (Check)
        // config: none?

        // Order: 
        // 1. io, clocks, random, environment, config (Leafs)
        // 2. cli, filesystem, http, sockets (Dependents)

        // We don't have environment/config in our `shims` list from offscreen?
        // We fetched: 'cli', 'clocks', 'filesystem', 'http', 'io', 'random', 'sockets'.
        // Wait, `cli.js` imports `environment.js` and `config.js`!
        // We NEED those files if we want to shim `cli`.
        // We missed them in `offscreen.js`.

        // CRITICAL MISSING FILES: environment.js, config.js.
        // If we don't have them, `cli.js` will fail to run.
        // That explains why `cli` might have failed before or will fail now.

        // FIX:
        // 1. We assume we might be missing deps. 
        // 2. But ignoring that for a moment, let's assume we have them or `cli` isn't used?
        //    The agent imports `wasi:cli/*` which maps to `cli.js`.

        // We need to fetch environment.js and config.js in offscreen.js first?
        // Yes.

        // But for this step in `sandbox.js`, assuming we have the code or can't fetch it:
        // We will try to replace specific known deps.

        // Let's implement the URL replacement strategy. 
        // Since we can't easily topologically sort dynamically without parsing, 
        // we will use a "placeholder" strategy with `URL.createObjectURL`?
        // No, we can't predict the URL.

        // HACK: Use `data:` URLs for small shims? 
        // `export ...` in data URL works? Yes for modules.
        // But `preview2-shim` files might be large? `io.js` is 5KB. Data URL is fine.
        // `filesystem.js` is 8KB. 
        // Total < 100KB.
        // CSP `connect-src * data:` allows data?
        // CSP `script-src` does NOT allow `data:` (usually).
        // Our manifest: `script-src ... blob:`. NO `data:`.

        // BACK TO BLOBS.
        // We have to solve the Cycle/Order problem.
        // If A imports B. 
        // We create BlobB. Get URLB.
        // We replace "from './B.js'" in CodeA with "from 'URLB'".
        // We create BlobA.

        // If A imports B and B imports A. Impossible with immutable Blobs.
        // Hopefully no cycles.

        // We will try a multi-pass approach assuming no cycles:
        // Pass 1: "Leaf" shims (shim code doesn't contain './') -> Create Blobs.
        // Pass 2: Shims that only import known Blobs -> Create Blobs.
        // Repeat until done.
        // SIMPLER:
        // The shims we have are: imports map `shims`.
        // We can just iterate until we can't make progress?

        if (shims) {
            console.log("[Sandbox] Shims received:", Object.keys(shims));
            Object.keys(shims).forEach(k => console.log(`[Sandbox] Shim ${k} size: ${shims[k].length}`));
        }

        let remaining = Object.keys(shims);
        let stuck = false;

        while (remaining.length > 0 && !stuck) {
            const nextBatch = [];
            let progress = false;

            for (const name of remaining) {
                let code = shims[name];

                // Check imports
                // We look for `from './X.js'` or `from "./X.js"`
                const re = /from\s+['"]\.\/([^'"]+)\.js['"]/g;
                let match;
                let ready = true;
                const deps = [];

                // Reset regex lastIndex for each shim
                re.lastIndex = 0;
                while ((match = re.exec(code)) !== null) {
                    const depName = match[1];
                    if (!shimUrls[depName]) {
                        // Dependency not yet ready
                        // Check if it's even in our list?
                        if (!shims[depName]) {
                            // Missing dependency (e.g. environment).
                            // We can't resolve it.
                            // We'll have to skip or mock?
                            // For now, let's assume if it's missing we can't link it.
                            // But wait, if `cli.js` needs `environment.js`, and we don't have it, `cli.js` is broken.
                            console.warn("Missing dependency for shim:", name, "->", depName);
                            // We'll allow it to fail at runtime or try to proceed if we can?
                            // No, we can't replace the import.
                        }
                        ready = false;
                    } else {
                        deps.push(depName);
                    }
                }

                if (ready) {
                    console.log(`[Sandbox] Processing shim: ${name}`);
                    // All deps have URLs. Replace them!
                    deps.forEach(dep => {
                        const replRe = new RegExp(`from\\s+['"]\\.\\/${dep}\\.js['"]`, 'g');
                        code = code.replace(replRe, `from '${shimUrls[dep]}'`);
                    });

                    if (name === 'cli') {
                        console.log(`[Sandbox] CLI code imports sample:`, code.substring(0, 300));
                    }

                    const blob = new Blob([code], { type: 'text/javascript' });
                    const url = URL.createObjectURL(blob);
                    shimUrls[name] = url;
                    createdUrls.push(url);
                    progress = true;
                } else {
                    nextBatch.push(name);
                }
            }

            if (!progress && nextBatch.length > 0) {
                console.error("Circular dependency or missing files in shims:", nextBatch);
                // Force create them with broken imports to avoid hang?
                // Or just break.
                stuck = true;
            }
            remaining = nextBatch;
        }

        // Rewrite Main Agent Code using Dynamic Adapters
        // The agent code imports granular interfaces (e.g. 'wasi:cli/stderr')
        // But our shims are bundled packages (e.g. 'cli.js').
        // We generate adapter modules on the fly to bridge this gap.

        let finalAgentCode = code;

        const camelCase = (str) => str.replace(/-([a-z])/g, (g) => g[1].toUpperCase());

        // Find all imports first, then filter for WASI
        const importRegex = /import\s*\{([\s\S]+?)\}\s*from\s*['"]([^'"]+)['"]/g;
        let importMatch;
        const adapterUrls = [];

        const neededAdapters = new Map(); // specifier -> { pkg, iface, exports: [] }

        console.log("[Sandbox] Scanning for WASI imports...");

        while ((importMatch = importRegex.exec(code)) !== null) {
            const [fullStr, distinctImports, specifier] = importMatch;

            let adapterCode = '';

            if (specifier.startsWith('component:agent/')) {
                console.log(`[Sandbox] Found Host Component import: ${specifier}`);
                const parts = specifier.split('/');
                const name = parts[1]; // host-capabilities or host-console

                if (name === 'host-capabilities') {
                    adapterCode = `
                        export const ask = async (prompt) => {
                            return await globalThis.JCO_BRIDGE.ask(prompt);
                        };
                    `;
                } else if (name === 'host-console') {
                    adapterCode = `
                        export const log = (msg) => {
                            globalThis.JCO_BRIDGE.log(msg);
                        };
                    `;
                }
            } else if (specifier.startsWith('component:quest-v1/')) {
                console.log(`[Sandbox] Found Quest V1 import: ${specifier}`);
                const parts = specifier.split('/');
                const name = parts[1]; // host-quest-manager or host-events
                if (name === 'host-quest-manager') {
                    // We need to alias the imports to avoid collisions if multiple things are imported
                    adapterCode = `
                         export const registerTask = (qid, tid, desc) => globalThis.JCO_BRIDGE.quest.registerTask(qid, tid, desc);
                         export const updateTask = (qid, tid, s) => globalThis.JCO_BRIDGE.quest.updateTask(qid, tid, s);
                         export const notifyPlayer = (msg) => globalThis.JCO_BRIDGE.quest.notifyPlayer(msg);
                         export const status = { locked: 'locked', active: 'active', completed: 'completed', failed: 'failed' };
                     `;
                } else if (name === 'host-events') {
                    adapterCode = `
                         export const getCurrentUrl = () => globalThis.JCO_BRIDGE.quest.getCurrentUrl();
                      `;
                } else if (name === 'host-console') {
                    adapterCode = `
                          export const log = (msg) => globalThis.JCO_BRIDGE.log(msg);
                       `;
                } else if (name === 'host-content') {
                    adapterCode = `
                         export const registerItem = (id, url, title, type) => globalThis.JCO_BRIDGE.quest.registerItem(id, url, title, type);
                      `;
                }
            }

            if (adapterCode) {
                const blob = new Blob([adapterCode], { type: 'text/javascript' });
                const url = URL.createObjectURL(blob);
                adapterUrls.push(url);

                // Safer Replacement for Host Components too
                finalAgentCode = finalAgentCode.replaceAll(`from '${specifier}'`, `from '${url}'`);
                finalAgentCode = finalAgentCode.replaceAll(`from "${specifier}"`, `from '${url}'`);
                finalAgentCode = finalAgentCode.replaceAll(`import('${specifier}')`, `import('${url}')`);
                finalAgentCode = finalAgentCode.replaceAll(`import("${specifier}")`, `import('${url}')`);

                console.log(`[Sandbox] Mocked Host Component ${specifier} -> ${url}`);
                console.log(`[Sandbox] Mocked Host Component ${specifier} -> ${url}`);
                continue;
            }



            if (!specifier.startsWith('wasi:')) {
                continue;
            }

            console.log(`[Sandbox] Found WASI import: ${specifier} imports: ${distinctImports.replace(/\s+/g, ' ')}`);

            const specMatch = /^wasi:([^/]+)\/(.+)$/.exec(specifier);
            if (!specMatch) {
                console.warn("[Sandbox] Skipped unrecognized WASI specifier:", specifier);
                continue;
            }
            const pkg = specMatch[1];
            const iface = specMatch[2];

            if (!neededAdapters.has(specifier)) {
                neededAdapters.set(specifier, { pkg, iface, members: new Set() });
            }

            distinctImports.split(',').forEach(part => {
                const partTrim = part.trim();
                if (partTrim) {
                    neededAdapters.get(specifier).members.add(partTrim);
                }
            });
        }

        if (neededAdapters.size === 0) {
            console.warn("[Sandbox] No WASI imports found to adapt! Code sample:", code.substring(0, 500));
        }

        // Now iterate through the collected neededAdapters to create the actual adapter modules
        for (const [specifier, { pkg, iface, members }] of neededAdapters.entries()) {
            if (!shimUrls[pkg]) {
                console.warn(`[Sandbox] Missing shim for package: ${pkg} (required by ${specifier})`);
                continue;
            }

            const resourceName = camelCase(iface);
            const shimUrl = shimUrls[pkg];

            // Adapter Code
            // import { stderr } from 'blob:...';
            // export const getStderr = stderr.getStderr;

            // FIX: Alias the import to avoid collision if the exported member has the same name as the resource
            // e.g. import { poll as _poll } ... export const poll = _poll.poll;

            let adapterCode = `import { ${resourceName} as _${resourceName} } from '${shimUrl}';\n`;
            members.forEach(member => {
                // Handle alias "foo as bar" in the *importing* code (agent)
                // member string is like "poll as poll$1"
                const parts = member.split(/\s+as\s+/);
                const localName = parts[0];
                // The adapter must export `localName` because that's what the agent module asks for.
                // The agent might rename it locally to `poll$1`, but it executes `import { poll }` against our adapter.

                adapterCode += `export const ${localName} = _${resourceName}.${localName};\n`;
            });

            console.log(`[Sandbox] Created Adapter for ${specifier}:\n${adapterCode}`);
            const blob = new Blob([adapterCode], { type: 'text/javascript' });
            const url = URL.createObjectURL(blob);
            adapterUrls.push(url);

            // Replace in Agent Code
            // Safer Replacement: Only replace 'from "specifier"' or 'import("specifier")'
            // We use replaceAll with specific patterns to avoid breaking strings inside error messages or debug logs

            // 1. Static Imports: from "specifier"
            finalAgentCode = finalAgentCode.replaceAll(`from '${specifier}'`, `from '${url}'`);
            finalAgentCode = finalAgentCode.replaceAll(`from "${specifier}"`, `from '${url}'`);

            // 2. Dynamic Imports: import("specifier")
            finalAgentCode = finalAgentCode.replaceAll(`import('${specifier}')`, `import('${url}')`);
            finalAgentCode = finalAgentCode.replaceAll(`import("${specifier}")`, `import('${url}')`);
        }
        // Replace Wasm file references in the code
        // IMPORTANT: JCO generates `new URL('./agent.core.wasm', import.meta.url)`
        // We need to replace this pattern with the Blob URL string.
        if (wasmFiles) {
            Object.keys(wasmFiles).forEach(filename => {
                const url = shimUrls[filename];
                if (url) {
                    const escapedFilename = filename.replace(/\./g, '\\.');
                    // Regex to match `new URL('./filename', import.meta.url)` 
                    const pattern = `new\\s+URL\\(\\s*(['"])(\\.?\\/)?${escapedFilename}\\1\\s*,\\s*import\\.meta\\.url\\s*\\)`;
                    const re = new RegExp(pattern, 'g');

                    if (re.test(finalAgentCode)) {
                        console.log(`[Sandbox] Replacing Wasm new URL(...) for ${filename}`);
                        finalAgentCode = finalAgentCode.replace(re, `'${url}'`);
                    } else {
                        // Fallback
                        const reLiteral = new RegExp(`(['"])(\\.?\\/)?${escapedFilename}\\1`, 'g');
                        finalAgentCode = finalAgentCode.replace(reLiteral, `'${url}'`);
                    }
                }
            });
        }

        createdUrls.push(...adapterUrls);

        if (shims) {
            // Fallback: Also do the direct shim replacement if any remain (e.g. wasi:http/types -> http shim?)
            // This was the old logic. We keep it only for direct file mappings if any.
            Object.keys(shimUrls).forEach(name => {
                const placeholder = `__SHIM_${name.toUpperCase()}__`;
                const regex = new RegExp(placeholder, 'g');
                finalAgentCode = finalAgentCode.replace(regex, shimUrls[name]);
            });
        }
        console.log(`[Sandbox] Final Agent Code imports sample:`, finalAgentCode.substring(0, 500));

        const agentBlob = new Blob([finalAgentCode], { type: 'text/javascript' });
        const agentUrl = URL.createObjectURL(agentBlob);
        createdUrls.push(agentUrl);

        // No Import Map needed!
        try {
            await executeAgentFromUrl(agentUrl, payload);
        } catch (e) {
            console.error("[Sandbox] Execution Failed:", e);
            if (e instanceof SyntaxError) {
                // Attempt to find line number from stack trace or error
                // Format often: ... (at blob:url:Line:Col)
                const match = e.stack?.match(/:(\d+):(\d+)\)/);
                if (match) {
                    const line = parseInt(match[1], 10);
                    const lines = finalAgentCode.split('\n');
                    const start = Math.max(0, line - 10);
                    const end = Math.min(lines.length, line + 10);
                    console.log(`[Sandbox] Syntax Error Context (Lines ${start}-${end}):`);
                    console.log(lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n'));
                } else {
                    console.log("[Sandbox] Code excerpt (lines 5400-5450):");
                    const lines = finalAgentCode.split('\n');
                    console.log(lines.slice(5400, 5450).map((l, i) => `${5400 + i + 1}: ${l}`).join('\n'));
                }
            }
            throw e;
        } finally {
            createdUrls.forEach(u => URL.revokeObjectURL(u));
        }
    }
});

window.parent.postMessage({ type: 'SANDBOX_READY' }, '*');