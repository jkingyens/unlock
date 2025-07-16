// ext/offscreen.js

// --- NEW: Helper to convert Base64 string to ArrayBuffer ---
function base64ToAb(base64) {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

// --- Audio processing functions ---

async function normalizeAudio(audioBuffer) {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const originalAudioBuffer = await audioContext.decodeAudioData(audioBuffer);

        const offlineContext = new OfflineAudioContext(
            originalAudioBuffer.numberOfChannels,
            originalAudioBuffer.length,
            originalAudioBuffer.sampleRate
        );

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
        throw error; // Propagate error back to the caller
    }
}

function encodeWAV(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;

    let result;
    if (numChannels === 2) {
        result = interleave(audioBuffer.getChannelData(0), audioBuffer.getChannelData(1));
    } else {
        result = audioBuffer.getChannelData(0);
    }

    const dataLength = result.length * (bitDepth / 8);
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    function writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    let offset = 0;
    // RIFF chunk descriptor
    writeString(view, offset, 'RIFF'); offset += 4;
    view.setUint32(offset, 36 + dataLength, true); offset += 4;
    writeString(view, offset, 'WAVE'); offset += 4;
    // FMT sub-chunk
    writeString(view, offset, 'fmt '); offset += 4;
    view.setUint32(offset, 16, true); offset += 4;
    view.setUint16(offset, format, true); offset += 2;
    view.setUint16(offset, numChannels, true); offset += 2;
    view.setUint32(offset, sampleRate, true); offset += 4;
    view.setUint32(offset, sampleRate * numChannels * (bitDepth / 8), true); offset += 4;
    view.setUint16(offset, numChannels * (bitDepth / 8), true); offset += 2;
    view.setUint16(offset, bitDepth, true); offset += 2;
    // Data sub-chunk
    writeString(view, offset, 'data'); offset += 4;
    view.setUint32(offset, dataLength, true); offset += 4;

    let lng = result.length;
    let index = 44;
    let volume = 1;
    for (let i = 0; i < lng; i++) {
        view.setInt16(index, result[i] * (0x7FFF * volume), true);
        index += 2;
    }

    return view.buffer;
}

function interleave(inputL, inputR) {
    let length = inputL.length + inputR.length;
    let result = new Float32Array(length);
    let index = 0, inputIndex = 0;
    while (index < length) {
        result[index++] = inputL[inputIndex];
        result[index++] = inputR[inputIndex];
        inputIndex++;
    }
    return result;
}


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
        const reader = new readability.Readability(doc);
        const article = reader.parse();
        const textContent = article ? article.textContent : doc.body.innerText;
        sendResponse({ success: true, data: textContent });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
      break;

    case 'parse-html-for-text-with-markers':
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(request.data, 'text/html');
        const clonedDoc = doc.cloneNode(true);
        clonedDoc.querySelectorAll('a[data-timestampable="true"]').forEach(link => {
            const markerText = document.createTextNode(`*${link.textContent.trim()}*`);
            link.parentNode.replaceChild(markerText, link);
        });
        const reader = new readability.Readability(clonedDoc);
        const article = reader.parse();
        const textContent = article ? article.textContent : clonedDoc.body.innerText;
        sendResponse({ success: true, data: textContent });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
      break;
    
    case 'parse-html-for-links':
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(request.data, 'text/html');
        const links = Array.from(doc.querySelectorAll('a[data-timestampable="true"]'));
        const linkData = links.map(link => ({
          href: link.getAttribute('href'),
          text: link.textContent.trim()
        }));
        sendResponse({ success: true, data: linkData });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
      break;
    
    // --- Case for handling audio normalization ---
    case 'normalize-audio':
      if (request.data && request.data.base64) {
        const audioBuffer = base64ToAb(request.data.base64);
        normalizeAudio(audioBuffer)
          .then(processedBuffer => {
            // Convert processed buffer back to Base64 for the response
            const processedBase64 = btoa(new Uint8Array(processedBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''));
            sendResponse({ success: true, data: { base64: processedBase64, type: 'audio/wav' } });
          })
          .catch(error => {
            sendResponse({ success: false, error: error.message });
          });
      } else {
        sendResponse({ success: false, error: 'No audio data provided.' });
      }
      return true; // Indicates we will respond asynchronously
  }
  return true;
}

// Simple Readability.js polyfill to improve text extraction
const readability = {
    Readability: class {
        constructor(doc) { this.doc = doc; }
        parse() {
            const articleEl = this.doc.querySelector('article');
            if (articleEl) return { textContent: articleEl.innerText };
            const mainEl = this.doc.querySelector('main');
            if (mainEl) return { textContent: mainEl.innerText };
            return { textContent: this.doc.body.innerText };
        }
    }
};