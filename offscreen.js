// ext/offscreen.js
import Tesseract from './lib/tesseract.esm.min.js';

if (typeof window.unlockOffscreenInitialized === 'undefined') {
    window.unlockOffscreenInitialized = true;

    let isSandboxReady = false;
    const sandboxMessageQueue = [];

    let audio = null;
    let timeUpdateTimer = null;
    let isSidebarOpen = false;

    // ... (Helper functions base64ToAb, scheduleTimeUpdate, setupAudioElement, handleAudioControl, normalizeAudioAndGetDuration, encodeWAV, interleave, Readability remain the same) ...
    function base64ToAb(base64) {
        const binary_string = window.atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary_string.charCodeAt(i);
        }
        return bytes.buffer;
    }

    function scheduleTimeUpdate() {
        if (timeUpdateTimer) clearTimeout(timeUpdateTimer);
        const delay = isSidebarOpen ? 250 : 1000;
        timeUpdateTimer = setTimeout(() => {
            if (!audio || audio.paused) return;
            if (chrome.runtime?.id) {
                chrome.runtime.sendMessage({
                    action: 'audio_time_update',
                    data: {
                        currentTime: audio.currentTime,
                        duration: audio.duration,
                        url: audio.dataset.url
                    }
                });
            }
            scheduleTimeUpdate();
        }, delay);
    }

    function setupAudioElement() {
        if (audio) return;
        audio = new Audio();
        audio.onplay = () => scheduleTimeUpdate();
        audio.onpause = () => { if (timeUpdateTimer) clearTimeout(timeUpdateTimer); timeUpdateTimer = null; };
        audio.onended = () => {
            if (timeUpdateTimer) clearTimeout(timeUpdateTimer);
            timeUpdateTimer = null;
            if (chrome.runtime?.id) {
                chrome.runtime.sendMessage({
                    action: 'media_playback_complete',
                    data: { instanceId: audio.dataset.instanceId, url: audio.dataset.url }
                });
            }
        };
    }

    async function handleAudioControl(request) {
        setupAudioElement();
        const { command, data } = request;
        switch (command) {
            case 'play':
                const needsSrcUpdate = audio.dataset.instanceId !== data.instanceId || audio.dataset.url !== data.url;
                if (needsSrcUpdate) {
                    const audioBuffer = base64ToAb(data.audioB64);
                    const blob = new Blob([audioBuffer], { type: data.mimeType });
                    const audioUrl = URL.createObjectURL(blob);
                    if (audio.src && audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
                    audio.src = audioUrl;
                    audio.dataset.url = data.url;
                    audio.dataset.instanceId = data.instanceId;
                    return new Promise((resolve) => {
                        const onMetadata = async () => {
                            if (data.startTime) audio.currentTime = data.startTime;
                            try { await audio.play(); resolve({ success: true, isPlaying: true, currentTime: audio.currentTime }); }
                            catch (e) { console.error("Audio play failed:", e); resolve({ success: false, error: e.message }); }
                        };
                        audio.addEventListener('loadedmetadata', onMetadata, { once: true });
                        audio.load();
                    });
                } else {
                    if (data.startTime) audio.currentTime = data.startTime;
                    try { await audio.play(); return { success: true, isPlaying: true, currentTime: audio.currentTime }; }
                    catch (e) { return { success: false, error: e.message }; }
                }
            case 'pause': audio.pause(); return { success: true, isPlaying: false, currentTime: audio.currentTime };
            case 'stop': audio.pause(); audio.currentTime = 0; if (audio.src && audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src); audio.src = ''; return { success: true, isPlaying: false, currentTime: 0 };
            case 'toggle':
                if (audio.paused) { try { await audio.play(); return { success: true, isPlaying: true, currentTime: audio.currentTime }; } catch (e) { return { success: false, error: e.message }; } }
                else { audio.pause(); return { success: true, isPlaying: false, currentTime: audio.currentTime }; }
            case 'get_current_time': return { success: true, currentTime: audio.currentTime, isPlaying: !audio.paused };
        }
        return { success: true };
    }

    // ... (normalizeAudioAndGetDuration, encodeWAV, interleave, Readability) ...
    async function normalizeAudioAndGetDuration(audioBuffer) {
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const originalAudioBuffer = await audioContext.decodeAudioData(audioBuffer);
            const duration = originalAudioBuffer.duration;
            const offlineContext = new OfflineAudioContext(originalAudioBuffer.numberOfChannels, originalAudioBuffer.length, originalAudioBuffer.sampleRate);
            const compressor = offlineContext.createDynamicsCompressor();
            compressor.threshold.setValueAtTime(-40, 0);
            compressor.knee.setValueAtTime(30, 0);
            compressor.ratio.setValueAtTime(20, 0);
            compressor.attack.setValueAtTime(0.003, 0);
            compressor.release.setValueAtTime(0.4, 0);
            const source = offlineContext.createBufferSource();
            source.buffer = originalAudioBuffer;
            source.connect(compressor);
            compressor.connect(offlineContext.destination);
            source.start(0);
            const processedAudioBuffer = await offlineContext.startRendering();
            return { wavBuffer: encodeWAV(processedAudioBuffer), duration: duration };
        } catch (error) { console.error('[Offscreen] Audio normalization failed:', error); throw error; }
    }

    function encodeWAV(audioBuffer) {
        const numChannels = audioBuffer.numberOfChannels, sampleRate = audioBuffer.sampleRate, format = 1, bitDepth = 16;
        let result = numChannels === 2 ? interleave(audioBuffer.getChannelData(0), audioBuffer.getChannelData(1)) : audioBuffer.getChannelData(0);
        const dataLength = result.length * (bitDepth / 8), buffer = new ArrayBuffer(44 + dataLength), view = new DataView(buffer);
        function writeString(view, offset, string) { for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i)); }
        let offset = 0;
        writeString(view, offset, 'RIFF'); offset += 4;
        view.setUint32(offset, 36 + dataLength, true); offset += 4;
        writeString(view, offset, 'WAVE'); offset += 4;
        writeString(view, offset, 'fmt '); offset += 4;
        view.setUint32(offset, 16, true); offset += 4;
        view.setUint16(offset, format, true); offset += 2;
        view.setUint16(offset, numChannels, true); offset += 2;
        view.setUint32(offset, sampleRate, true); offset += 4;
        view.setUint32(offset, sampleRate * numChannels * (bitDepth / 8), true); offset += 4;
        view.setUint16(offset, numChannels * (bitDepth / 8), true); offset += 2;
        view.setUint16(offset, bitDepth, true); offset += 2;
        writeString(view, offset, 'data'); offset += 4;
        view.setUint32(offset, dataLength, true); offset += 4;
        let lng = result.length, index = 44, volume = 1;
        for (let i = 0; i < lng; i++) { view.setInt16(index, result[i] * (0x7FFF * volume), true); index += 2; }
        return view.buffer;
    }

    function interleave(inputL, inputR) {
        let length = inputL.length + inputR.length, result = new Float32Array(length), index = 0, inputIndex = 0;
        while (index < length) { result[index++] = inputL[inputIndex]; result[index++] = inputR[inputIndex]; inputIndex++; }
        return result;
    }

    const readability = {
        Readability: class {
            constructor(doc) { this.doc = doc; }
            parse() {
                const articleEl = this.doc.querySelector('article') || this.doc.querySelector('main');
                return { textContent: articleEl ? articleEl.innerText : this.doc.body.innerText };
            }
        }
    };

    function handleMessages(request, sender, sendResponse) {
        if (!chrome.runtime?.id) return false;
        if (request.target !== 'offscreen') return false;

        switch (request.type) {
            case 'execute_remote_agent':
                const sandboxFrame = document.getElementById('sandbox-frame');
                if (sandboxFrame && sandboxFrame.contentWindow) {

                    const payload = {
                        type: 'EXECUTE_AGENT',
                        payload: request.data
                    };

                    if (isSandboxReady) {
                        // Sandbox is ready, send immediately
                        sandboxFrame.contentWindow.postMessage(payload, '*');
                        console.log("[Offscreen] Agent sent to sandbox (Immediate)");
                    } else {
                        // Sandbox loading, queue it
                        sandboxMessageQueue.push(payload);
                        console.log("[Offscreen] Agent queued (Waiting for Sandbox)");
                    }

                    sendResponse({ success: true, message: 'Agent queued/forwarded' });
                } else {
                    console.error("[Offscreen] Sandbox frame missing.");
                    sendResponse({ success: false, error: 'Sandbox frame not ready' });
                }
                return false;

            case 'execute_remote_agent_url':
                const sandboxFrameUrl = document.getElementById('sandbox-frame');
                if (sandboxFrameUrl && sandboxFrameUrl.contentWindow) {
                    const payload = {
                        type: 'EXECUTE_AGENT_FROM_URL',
                        payload: request.data
                    };
                    if (isSandboxReady) {
                        sandboxFrameUrl.contentWindow.postMessage(payload, '*');
                        console.log("[Offscreen] Agent URL sent to sandbox (Immediate)");
                    } else {
                        sandboxMessageQueue.push(payload);
                        console.log("[Offscreen] Agent URL queued (Waiting for Sandbox)");
                    }
                    sendResponse({ success: true, message: 'Agent URL queued/forwarded' });
                } else {
                    sendResponse({ success: false, error: 'Sandbox frame not ready' });
                }
                return false;



            case 'execute_js_agent':
                (async () => {
                    console.log("[Offscreen] Received execute_js_agent request");
                    try {
                        let jsSource = request.data.code;
                        console.log("[Offscreen] JS Source length:", jsSource.length);

                        // 1. Fetch Shim Content (Needed for Sandbox Import Map)
                        const shimNames = ['cli', 'clocks', 'filesystem', 'http', 'io', 'random', 'sockets', 'environment', 'config'];
                        const shims = {};

                        // We fetch shims because the Agent (even pre-bundled) might rely on the Sandbox 
                        // to provide specific environment bindings via import map, or simply 'component-runtime'.
                        console.log("[Offscreen] Fetching shim sources...");
                        await Promise.all(shimNames.map(async (name) => {
                            const url = chrome.runtime.getURL(`agents/shims/${name}.js`);
                            const res = await fetch(url);
                            const text = await res.text();
                            shims[name] = text;
                        }));
                        console.log("[Offscreen] Fetched shims:", Object.keys(shims));

                        // 2. Send to Sandbox
                        const sandboxFrame = document.getElementById('sandbox-frame');
                        if (sandboxFrame && sandboxFrame.contentWindow) {
                            if (!isSandboxReady) await new Promise(r => setTimeout(r, 1000));

                            sandboxFrame.contentWindow.postMessage({
                                type: 'EXECUTE_AGENT_FROM_SOURCE',
                                payload: {
                                    ...request.data,
                                    code: jsSource,
                                    shims: shims,
                                    wasmFiles: {} // No separate Wasm files (inlined)
                                }
                            }, '*');
                            console.log("[Offscreen] Pre-transpiled Agent sent to sandbox.");
                            sendResponse({ success: true });
                        } else {
                            throw new Error("Sandbox frame not ready");
                        }
                    } catch (e) {
                        console.error("[Offscreen] Error executing JS Agent:", e);
                        sendResponse({ success: false, error: e.toString() });
                    }
                })();
                return true;

            case 'execute_raw_wasm':
                (async () => {
                    console.log("[Offscreen] Received execute_raw_wasm request");
                    try {
                        const { transpile } = await import(chrome.runtime.getURL('agents/jco.js'));
                        console.log("[Offscreen] Loaded JCO, processing request...");

                        const wasmBuffer = base64ToAb(request.data.wasmB64);
                        console.log("[Offscreen] Decoded Wasm. Length:", wasmBuffer.byteLength);

                        // 1. Fetch Shim Content
                        const shimNames = ['cli', 'clocks', 'filesystem', 'http', 'io', 'random', 'sockets', 'environment', 'config'];
                        const shims = {};
                        const map = {};

                        console.log("[Offscreen] Fetching shim sources...");
                        await Promise.all(shimNames.map(async (name) => {
                            const url = chrome.runtime.getURL(`agents/shims/${name}.js`);
                            const res = await fetch(url);
                            const text = await res.text();
                            shims[name] = text;
                            // 2. Map KEYS to the import paths generated by JCO when using default shims
                            // JCO (with noWasiShim: false) generates imports like '@bytecodealliance/preview2-shim/cli'
                            map[`@bytecodealliance/preview2-shim/${name}`] = `__SHIM_${name.toUpperCase()}__`;
                        }));

                        // We also need to map the internal relative imports OF the shims?
                        // We do that in sandbox.js (the "recursive" replacement).
                        // Here we just need to catch the "Entry" imports from agent.js.

                        console.log("[Offscreen] Fetched shims:", Object.keys(shims));
                        console.log("[Offscreen] Map keys:", Object.keys(map));

                        console.log("[Offscreen] Transpiling Wasm Component with Shim Placeholders...");
                        const component = await transpile(wasmBuffer, {
                            name: 'agent',
                            noNodejsCompat: true,
                            noWasiShim: false
                            // map: map // Remove map to see raw output imports first
                        });

                        let files = {};
                        if (Array.isArray(component.files)) {
                            component.files.forEach(([name, content]) => files[name] = content);
                        } else {
                            files = component.files;
                        }
                        console.log("[Offscreen] JCO Generated Files:", Object.keys(files));

                        // JCO returns a 'files' object or array of entries depending on version/bundling
                        let jsSource;
                        if (Array.isArray(component.files)) {
                            const agentEntry = component.files.find(entry => entry[0] === 'agent.js');
                            jsSource = agentEntry ? agentEntry[1] : null;
                        } else {
                            jsSource = component.files['agent.js'];
                        }

                        // Collect all Wasm files
                        const wasmFiles = {};
                        Object.entries(files).forEach(([filename, content]) => {
                            if (filename.endsWith('.wasm')) {
                                wasmFiles[filename] = content;
                            }
                        });
                        console.log("[Offscreen] Wasm Files found:", Object.keys(wasmFiles));

                        if (!jsSource) {
                            throw new Error("Transpilation failed to produce agent.js");
                        }

                        if (jsSource instanceof Uint8Array) {
                            jsSource = new TextDecoder().decode(jsSource);
                        }

                        // [PATCH] Apply JSPI patches on-the-fly
                        jsSource = patchAgentSource(jsSource);
                        console.log("[Offscreen] Applied JSPI patches to agent source.");

                        console.log("[Offscreen] Sending Transpiled Code & Shims to Sandbox...");

                        const sandboxFrame = document.getElementById('sandbox-frame');
                        if (sandboxFrame && sandboxFrame.contentWindow) {
                            if (!isSandboxReady) await new Promise(r => setTimeout(r, 1000));

                            sandboxFrame.contentWindow.postMessage({
                                type: 'EXECUTE_AGENT_FROM_SOURCE',
                                payload: {
                                    ...request.data,
                                    code: jsSource,
                                    shims: shims,
                                    wasmFiles: wasmFiles
                                }
                            }, '*');
                            console.log("[Offscreen] Agent source & shims sent to sandbox");
                        } else {
                            throw new Error("Sandbox frame missing");
                        }

                        sendResponse({ success: true, message: 'Agent source forwarded' });
                        return;
                    } catch (e) {
                        console.error("[Offscreen] JCO Transpilation Error:", e);
                        sendResponse({ success: false, error: e.message });
                    }
                })();
                return true; // Async response
            case 'set_sidebar_state': isSidebarOpen = request.data.isOpen; sendResponse({ success: true }); return false;
            case 'create-blob-url':
                try { const blob = new Blob([request.data.html], { type: 'text/html' }); const blobUrl = URL.createObjectURL(blob); sendResponse({ success: true, blobUrl: blobUrl }); }
                catch (error) { sendResponse({ success: false, error: error.message }); } return false;
            case 'create-blob-url-from-buffer':
                try { const buffer = base64ToAb(request.data.bufferB64); const blob = new Blob([buffer], { type: request.data.type }); const blobUrl = URL.createObjectURL(blob); sendResponse({ success: true, blobUrl: blobUrl }); }
                catch (error) { sendResponse({ success: false, error: error.message }); } return false;
            case 'parse-html-for-tts-and-links':
                try {
                    const parser = new DOMParser(); const doc = parser.parseFromString(request.data.html, 'text/html'); const context = { plainText: '', linkMappings: [] };
                    function processNode(node) {
                        if (node.nodeType === Node.TEXT_NODE) { context.plainText += node.textContent.replace(/\s+/g, ' ').trim() + ' '; }
                        else if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.tagName === 'A' && node.hasAttribute('data-timestampable')) {
                                const href = node.getAttribute('href');
                                if (href && !context.linkMappings.some(m => m.href === href)) { context.linkMappings.push({ href: href, text: node.textContent.trim(), charIndex: context.plainText.length }); }
                            }
                            node.childNodes.forEach(processNode);
                            if (['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV', 'LI'].includes(node.tagName)) context.plainText += '\n';
                        }
                    }
                    processNode(doc.body); context.plainText = context.plainText.replace(/\s+/g, ' ').trim(); sendResponse({ success: true, data: { plainText: context.plainText, linkMappings: context.linkMappings } });
                } catch (error) { sendResponse({ success: false, error: error.message }); } return false;
            case 'control-audio': handleAudioControl(request.data).then(sendResponse); return true;
            case 'crop_image':
                (async () => {
                    const { dataUrl, rect, devicePixelRatio } = request.data;
                    const img = new Image();
                    img.onload = () => {
                        const canvas = document.createElement('canvas');
                        // Use the provided rect which is in CSS pixels, but the screenshot is in device pixels
                        const scale = devicePixelRatio || 1;
                        canvas.width = rect.width * scale;
                        canvas.height = rect.height * scale;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(
                            img,
                            rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale,
                            0, 0, rect.width * scale, rect.height * scale
                        );
                        const croppedDataUrl = canvas.toDataURL('image/png');
                        sendResponse({ success: true, croppedDataUrl });
                    };
                    img.onerror = (err) => {
                        sendResponse({ success: false, error: 'Failed to load image for cropping' });
                    };
                    img.src = dataUrl;
                })();
                return true;
            case 'parse-html-for-text':
            case 'parse-html-for-text-with-markers':
            case 'parse-html-for-links':
                try {
                    const parser = new DOMParser(); const doc = parser.parseFromString(request.data, 'text/html');
                    if (request.type === 'parse-html-for-links') {
                        const links = Array.from(doc.querySelectorAll('a[data-timestampable="true"]')).map(link => ({ href: link.getAttribute('href'), text: link.textContent.trim() }));
                        sendResponse({ success: true, data: links });
                    } else {
                        if (request.type === 'parse-html-for-text-with-markers') {
                            doc.querySelectorAll('a[data-timestampable="true"]').forEach(link => { link.parentNode.replaceChild(document.createTextNode(`*${link.textContent.trim()}*`), link); });
                        }
                        const reader = new readability.Readability(doc); const article = reader.parse(); sendResponse({ success: true, data: article ? article.textContent : "" });
                    }
                } catch (error) { sendResponse({ success: false, error: error.message }); } return false;
            case 'process_image_to_text':
                if (request.data && request.data.base64) {
                    (async () => {
                        try {
                            console.log('[Offscreen-OCR] Starting OCR processing...');
                            console.log('[Offscreen-OCR] Tesseract version:', Tesseract.version);

                            const result = await Tesseract.recognize(
                                request.data.base64,
                                'eng',
                                {
                                    logger: m => console.log('[Offscreen-OCR-Progress]', m.status, m.progress),
                                    workerPath: chrome.runtime.getURL('lib/worker.min.js'),
                                    corePath: chrome.runtime.getURL('lib/tesseract-core.wasm.js'),
                                    workerBlobURL: false,
                                }
                            );
                            console.log('[Offscreen-OCR] OCR Success:', result.data.text.substring(0, 50) + '...');
                            sendResponse({ success: true, text: result.data.text });
                        } catch (error) {
                            console.error('[Offscreen-OCR] Error:', error);
                            const errorMessage = error ? (error.message || error.toString()) : "Unknown OCR Error";
                            sendResponse({ success: false, error: errorMessage });
                        }
                    })();
                    return true;
                }
                sendResponse({ success: false, error: 'No image data provided.' });
                return false;

            case 'dispatch_navigate':
                const sandbox = document.getElementById('sandbox-frame');
                if (sandbox && sandbox.contentWindow) {
                    sandbox.contentWindow.postMessage({
                        type: 'NAVIGATE',
                        requestId: request.requestId || Date.now(),
                        payload: { url: request.data.url }
                    }, '*');
                    console.log(`[Offscreen] Forwarded NAVIGATE to sandbox: ${request.data.url}`);
                    sendResponse({ success: true });
                } else {
                    console.warn("[Offscreen] No sandbox frame found to dispatch NAVIGATE.");
                    sendResponse({ success: false, error: 'Sandbox not found' });
                }
                return false;
            case 'normalize-audio':
                if (request.data && request.data.base64) {
                    normalizeAudioAndGetDuration(base64ToAb(request.data.base64)).then(result => {
                        const processedBase64 = btoa(new Uint8Array(result.wavBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''));
                        sendResponse({ success: true, data: { base64: processedBase64, type: 'audio/wav', duration: result.duration } });
                    }).catch(error => sendResponse({ success: false, error: error.message }));
                } else { sendResponse({ success: false, error: 'No audio data provided.' }); } return true;
            case 'get-audio-duration':
                if (request.data && request.data.base64) {
                    try {
                        const audioContext = new (window.AudioContext || window.webkitAudioContext)(); const audioBuffer = base64ToAb(request.data.base64);
                        audioContext.decodeAudioData(audioBuffer)
                            .then(decodedData => { sendResponse({ success: true, duration: decodedData.duration }); })
                            .catch(e => { console.error('[Offscreen] Audio decoding failed:', e); sendResponse({ success: false, error: 'Audio decoding failed.' }); });
                    } catch (e) { sendResponse({ success: false, error: e.message }); }
                } else { sendResponse({ success: false, error: 'No audio data provided.' }); } return true;
        }
        return false;
    }

    if (chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener(handleMessages);
    }

    // --- DIRECT AI HANDLER ---
    window.addEventListener('message', async (event) => {
        const sandboxFrame = document.getElementById('sandbox-frame');
        if (!sandboxFrame || event.source !== sandboxFrame.contentWindow) return;

        const { type, requestId, prompt, result } = event.data;

        if (type === 'SANDBOX_READY') {
            console.log("[Offscreen] Sandbox reported ready. Flushing queue...");
            isSandboxReady = true;
            while (sandboxMessageQueue.length > 0) {
                const payload = sandboxMessageQueue.shift();
                sandboxFrame.contentWindow.postMessage(payload, '*');
            }
            return;
        }

        // --- QUEST / HOST BRIDGE ---
        if (type.startsWith('quest_')) {
            console.log(`[Offscreen] Bridging ${type} to Background`);
            // Map 'type' to 'action' for the background message handler
            chrome.runtime.sendMessage({
                action: type,
                data: event.data.data // Pass the inner data object (includes instanceId)
            }, (response) => {
                const result = response ? response.result : null;
                const error = response ? response.error : chrome.runtime.lastError?.message;
                sandboxFrame.contentWindow.postMessage({
                    type: 'HOST_RESPONSE',
                    requestId,
                    success: !error,
                    data: error || result
                }, '*');
            });
            return;
        }

        // Case A: Sandbox needs AI
        if (type === 'BRIDGE_AI_REQUEST') {
            try {
                console.log("[Offscreen] Received AI Request:", prompt);

                // Options for Chrome v140+ (Canary/Dev)
                const options = {
                    expectedOutputLanguages: ['en'],
                };

                let session;

                // 1. Feature Detect
                if (window.ai && window.ai.languageModel) {
                    console.log("[Offscreen] Using window.ai.languageModel");
                    const capabilities = await window.ai.languageModel.capabilities();
                    if (capabilities.available === 'no') throw new Error("ai.languageModel not available");
                    session = await window.ai.languageModel.create(options);
                }
                else if (window.LanguageModel) {
                    console.log("[Offscreen] Using window.LanguageModel");
                    const status = await window.LanguageModel.availability();
                    if (status === 'no') throw new Error("LanguageModel.availability() returned 'no'");
                    session = await window.LanguageModel.create(options);
                }
                else {
                    console.log("[Offscreen] No AI API found. window.ai:", window.ai);
                    throw new Error("No Gemini Nano API found.");
                }

                // 2. Prompt
                let answer;
                if (typeof session.prompt === 'function') {
                    answer = await session.prompt(prompt);
                } else if (typeof session.generate === 'function') {
                    answer = await session.generate(prompt);
                } else {
                    throw new Error("Session created but no prompt method found.");
                }

                // 3. Reply
                sandboxFrame.contentWindow.postMessage({
                    type: 'BRIDGE_AI_RESPONSE',
                    requestId,
                    success: true,
                    data: typeof answer === 'string' ? answer : JSON.stringify(answer)
                }, '*');

                if (session.destroy) session.destroy();

            } catch (err) {
                console.error("[Offscreen] AI Failed:", err);
                sandboxFrame.contentWindow.postMessage({
                    type: 'BRIDGE_AI_RESPONSE',
                    requestId,
                    success: false,
                    error: err.message || "Unknown AI Error"
                }, '*');
            }
        }

        // Case B: Sandbox finished execution
        if (type === 'AGENT_EXECUTION_COMPLETE') {
            console.log('[Offscreen] Agent finished:', result);
            chrome.runtime.sendMessage({
                action: 'remote_agent_complete',
                data: { result }
            });
        }
    });
    function patchAgentSource(code) {
        console.log("[Patch] Starting JSPI Patch on code length:", code.length);

        const hostFunctions = ['log', 'registerTask', 'updateTask', 'notifyPlayer', 'getCurrentUrl', 'registerItem', 'ask'];

        for (const func of hostFunctions) {
            // Regex to find ANY trampoline that calls this function
            // We search for: function trampolineXX(...) { ... func( ... }
            // NOTE: We use a simplified regex that finds the trampoline name, then checks content

            // We'll scan for all trampoline definitions first? 
            // Better: Scan specifically for the ones calling our function.
            // Regex: function\s+(trampoline\d+)\(([^)]+)\)\s*\{[^}]*\bfunc\(
            const trampolineRegex = new RegExp(`function\\s+(trampoline\\d+)\\(([^)]+)\\)\\s*\\{[^}]*\\b${func}\\(`, 's');
            const match = code.match(trampolineRegex);

            if (match) {
                const trampolineName = match[1];
                const args = match[2];
                console.log(`[Patch] Found trampoline for '${func}': ${trampolineName}`);

                // 1. Make trampoline async
                const decl = `function ${trampolineName}(${args}) {`;
                const asyncDecl = `async ${decl}`;

                if (!code.includes(asyncDecl)) {
                    code = code.replace(decl, asyncDecl);
                    console.log(`  - Made ${trampolineName} async`);
                }

                // 2. Await the function call
                // Replace "func(" with "await func("
                // Use lookbehind to avoid double await
                const callRegex = new RegExp(`(?<!await\\s)\\b${func}\\(`, 'g');
                if (code.match(callRegex)) {
                    code = code.replace(callRegex, `await ${func}(`);
                    console.log(`  - Added await to ${func}() call(s)`);
                }

                // 3. Wrap trampoline in Suspending in imports
                const importRegex = new RegExp(`'\\d+':\\s*${trampolineName},`, 'g');
                let wrappedCount = 0;
                code = code.replace(importRegex, (m) => {
                    wrappedCount++;
                    return m.replace(trampolineName, `new WebAssembly.Suspending(${trampolineName})`);
                });
                if (wrappedCount > 0) {
                    console.log(`  - Wrapped ${trampolineName} in Suspending (count: ${wrappedCount})`);
                }
            } else {
                // console.log(`[Patch] Trampoline for '${func}' not found.`);
            }
        }

        // 4. Wrap exports: 'init' and 'on-visit' (mapped to 'onVisit' in JS wrapper)
        // JCO generates wrappers: function onVisit(...) { exports1OnVisit(...) }
        // We need to:
        //  a) Find the raw export assignment: exports1OnVisit = exports1['on-visit']
        //  b) Wrap it in Promising: exports1OnVisit = WebAssembly.promising(exports1['on-visit'])
        //  c) Find the wrapper function: function onVisit(...)
        //  d) Make it async: async function onVisit(...)
        //  e) Await the internal call: await exports1OnVisit(...)

        const exportsToPatch = [
            { witName: 'init', wrapperName: 'init' },
            { witName: 'on-visit', wrapperName: 'onVisit' }
        ];

        for (const { witName, wrapperName } of exportsToPatch) {
            console.log(`[Patch] Processing export: ${witName} (wrapper: ${wrapperName})`);

            // Regex to find assignment: varName = exportsObject['witName'] OR exportsObject.witName
            // Matches: exports1OnVisit = exports1['on-visit'];
            // Matches: exports1Init = exports1.init;
            // Escaping for regex
            const escapedWitName = witName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

            // This regex handles both dot notation and bracket notation
            // Group 1: internal var name (e.g. exports1OnVisit)
            // Group 2: exports object name (e.g. exports1)
            const assignmentRegex = new RegExp(`([a-zA-Z0-9_$]+)\\s*=\\s*([a-zA-Z0-9_$]+)(?:\\.|\\[['"])${escapedWitName}(?:['"]\\])?;`);

            const match = code.match(assignmentRegex);

            if (match) {
                const internalVarName = match[1];
                const exportsObjName = match[2];
                const fullMatch = match[0];

                console.log(`  - Found assignment: ${internalVarName} = ...`);

                // 1. Wrap assignment in WebAssembly.promising
                // Reconstruct the right side to be safe (using the match we found)
                // We replace the WHOLE line to wrap it.
                // We need to extract the "right side" from the match or reconstruct it.
                // easier: capture the right side in the regex?
                // Actually, let's just use the regex to find the right-hand-side start.

                // Construct the Promising wrapper
                // If it was dot access: exports1.init -> replace with WebAssembly.promising(exports1.init)
                // If brackets: exports1['on-visit'] -> WebAssembly.promising(exports1['on-visit'])

                // Let's just use the original right-hand side from the capture if we can?
                // Actually, let's just use the regex to find the right-hand-side start.

                const split = fullMatch.split('=');
                const leftSide = split[0];
                const rightSide = split.slice(1).join('=').trim().replace(/;$/, ''); // remove trailing semicolon

                const newAssignment = `${leftSide}= WebAssembly.promising(${rightSide});`;
                code = code.replace(fullMatch, newAssignment);
                console.log(`  - Wrapped ${internalVarName} in WebAssembly.promising`);

                // 2. Find wrapper function definition and make async
                // function onVisit(arg0) {
                const funcDeclRegex = new RegExp(`function\\s+${wrapperName}\\s*\\(`, 'g');
                if (code.match(funcDeclRegex)) {
                    code = code.replace(funcDeclRegex, `async function ${wrapperName}(`);
                    console.log(`  - Made wrapper function '${wrapperName}' async`);
                } else {
                    console.warn(`  - Wrapper function '${wrapperName}' not found.`);
                }

                // 3. Await the internal call with ret check
                // const ret = internalVarName(...)  OR  internalVarName(...)
                // Parsing depends on return type. 'init' might return void, 'on-visit' might match different pattern.

                // Regex for call: internalVarName(
                // We use a lookahead/behind or just replace.

                // Note: JCO often does: 
                //    const ret = exports1OnVisit(...); 
                //    return ret;
                // OR just: exports1Init();

                const callRegex = new RegExp(`\\b${internalVarName}\\(`, 'g');

                // We want to replace "internalVarName(" with "await internalVarName("
                // BUT we must avoid double await if already patched (unlikely here but good practice)
                // AND we only want to patch calls inside the wrapper? 
                // Actually, patching globally is typically fine in this generated file structure.

                let callCount = 0;
                code = code.replace(callRegex, (m) => {
                    callCount++;
                    return `await ${m}`;
                });

                if (callCount > 0) {
                    console.log(`  - Added await to ${callCount} call(s) of ${internalVarName}`);
                } else {
                    console.warn(`  - No calls to ${internalVarName} found to await.`);
                }

            } else {
                console.warn(`  - Assignment for '${witName}' not found.`);
            }
        }

        return code;
    }
}