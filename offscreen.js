// ext/offscreen.js

if (typeof window.unlockOffscreenInitialized === 'undefined') {
    window.unlockOffscreenInitialized = true;

    let audio = null;
    let timeUpdateInterval = null;

    function base64ToAb(base64) {
        const binary_string = window.atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary_string.charCodeAt(i);
        }
        return bytes.buffer;
    }

    function setupAudioElement() {
        if (audio) return;
        audio = new Audio();
        audio.onplay = () => {
            if (timeUpdateInterval) clearInterval(timeUpdateInterval);
            timeUpdateInterval = setInterval(() => {
                if (!audio.paused && chrome.runtime?.id) { // Check context before sending
                    chrome.runtime.sendMessage({
                        action: 'audio_time_update',
                        data: {
                            currentTime: audio.currentTime,
                            duration: audio.duration,
                            pageId: audio.dataset.pageId
                        }
                    });
                }
            }, 250);
        };
        audio.onpause = () => {
            if (timeUpdateInterval) clearInterval(timeUpdateInterval);
            timeUpdateInterval = null;
        };
        audio.onended = () => {
            if (timeUpdateInterval) clearInterval(timeUpdateInterval);
            timeUpdateInterval = null;
            if (chrome.runtime?.id) { // Check context before sending
                chrome.runtime.sendMessage({
                    action: 'media_playback_complete',
                    data: {
                        instanceId: audio.dataset.instanceId,
                        pageId: audio.dataset.pageId
                    }
                });
            }
        };
    }

    function handleAudioControl(request) {
        setupAudioElement();
        const { command, data } = request;
        switch (command) {
            case 'play':
                const needsSrcUpdate = audio.dataset.instanceId !== data.instanceId || audio.dataset.pageId !== data.pageId;
                if (needsSrcUpdate) {
                    const audioBuffer = base64ToAb(data.audioB64);
                    const blob = new Blob([audioBuffer], { type: data.mimeType });
                    const audioUrl = URL.createObjectURL(blob);
                    if (audio.src && audio.src.startsWith('blob:')) {
                        URL.revokeObjectURL(audio.src);
                    }
                    audio.src = audioUrl;
                    audio.dataset.pageId = data.pageId;
                    audio.dataset.instanceId = data.instanceId;
                    audio.addEventListener('loadedmetadata', () => {
                        if (data.startTime) audio.currentTime = data.startTime;
                        audio.play().catch(e => console.error("Audio play failed after metadata load:", e));
                    }, { once: true });
                    audio.load();
                } else {
                    if (data.startTime) audio.currentTime = data.startTime;
                    audio.play().catch(e => console.error("Audio play failed:", e));
                }
                break;
            case 'pause':
                audio.pause();
                break;
            case 'stop':
                audio.pause();
                audio.currentTime = 0;
                if (audio.src && audio.src.startsWith('blob:')) {
                    URL.revokeObjectURL(audio.src);
                }
                audio.src = '';
                audio.removeAttribute('src');
                audio.dataset.pageId = '';
                audio.dataset.instanceId = '';
                break;
            case 'toggle':
                if (audio.paused) audio.play();
                else audio.pause();
                break;
            case 'get_current_time':
                return { success: true, currentTime: audio.currentTime };
        }
        return { success: true };
    }

    async function normalizeAudio(audioBuffer) {
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const originalAudioBuffer = await audioContext.decodeAudioData(audioBuffer);
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
            return encodeWAV(processedAudioBuffer);
        } catch (error) {
            console.error('[Offscreen] Audio normalization failed:', error);
            throw error;
        }
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
        for (let i = 0; i < lng; i++) {
            view.setInt16(index, result[i] * (0x7FFF * volume), true);
            index += 2;
        }
        return view.buffer;
    }

    function interleave(inputL, inputR) {
        let length = inputL.length + inputR.length, result = new Float32Array(length), index = 0, inputIndex = 0;
        while (index < length) {
            result[index++] = inputL[inputIndex];
            result[index++] = inputR[inputIndex];
            inputIndex++;
        }
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
        if (!chrome.runtime?.id) {
            console.warn("Offscreen document context invalidated. Ignoring message.", request.type);
            // Do not return true here, as we cannot send a response.
            return false;
        }

        if (request.target !== 'offscreen') return false;

        switch (request.type) {
            case 'control-audio':
                sendResponse(handleAudioControl(request.data));
                return false; 
            case 'parse-html-for-text':
            case 'parse-html-for-text-with-markers':
            case 'parse-html-for-links':
                try {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(request.data, 'text/html');
                    if (request.type === 'parse-html-for-links') {
                        const links = Array.from(doc.querySelectorAll('a[data-timestampable="true"]')).map(link => ({ href: link.getAttribute('href'), text: link.textContent.trim() }));
                        sendResponse({ success: true, data: links });
                    } else {
                        if (request.type === 'parse-html-for-text-with-markers') {
                            doc.querySelectorAll('a[data-timestampable="true"]').forEach(link => {
                                link.parentNode.replaceChild(document.createTextNode(`*${link.textContent.trim()}*`), link);
                            });
                        }
                        const reader = new readability.Readability(doc);
                        const article = reader.parse();
                        sendResponse({ success: true, data: article ? article.textContent : "" });
                    }
                } catch (error) {
                    sendResponse({ success: false, error: error.message });
                }
                return false;
            case 'normalize-audio':
                if (request.data && request.data.base64) {
                    normalizeAudio(base64ToAb(request.data.base64)).then(processedBuffer => {
                        const processedBase64 = btoa(new Uint8Array(processedBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''));
                        sendResponse({ success: true, data: { base64: processedBase64, type: 'audio/wav' } });
                    }).catch(error => sendResponse({ success: false, error: error.message }));
                } else {
                    sendResponse({ success: false, error: 'No audio data provided.' });
                }
                return true;
        }
        return false;
    }
    
    if (chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener(handleMessages);
    } else {
        console.error("Offscreen document loaded without chrome.runtime.onMessage. This should not happen.");
    }
}