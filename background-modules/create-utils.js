// ext/background-modules/create-utils.js
// Contains logic for creating new packet images, including LLM and TTS interactions.

import {
    logger,
    storage,
    indexedDbStorage,
    arrayBufferToBase64,
    base64Decode,
    sanitizeForFileName
} from '../utils.js';
import llmService from '../llm_service.js';
import ttsService from '../tts_service.js';

// --- Offscreen Document Management ---
let creatingOffscreenDocument;

async function hasOffscreenDocument() {
    if (typeof chrome.runtime.getManifest === 'function' && chrome.runtime.getManifest().offscreen) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT']
        });
        return contexts.length > 0;
    } else {
        for (const client of await self.clients.matchAll()) {
            if (client.url.endsWith('/offscreen.html')) {
                return true;
            }
        }
        return false;
    }
}

async function setupOffscreenDocument() {
    if (await hasOffscreenDocument()) return;
    if (creatingOffscreenDocument) {
        await creatingOffscreenDocument;
    } else {
        creatingOffscreenDocument = chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['DOM_PARSER', 'BLOBS', 'AUDIO_PLAYBACK'],
            justification: 'Parse HTML, process audio data, and handle playback.',
        });
        await creatingOffscreenDocument;
        creatingOffscreenDocument = null;
    }
}

async function getAndParseHtml(html, withMarkers = false) {
    await setupOffscreenDocument();
    const type = withMarkers ? 'parse-html-for-text-with-markers' : 'parse-html-for-text';
    const response = await chrome.runtime.sendMessage({
        type: type,
        target: 'offscreen',
        data: html,
    });

    if (response && response.success) {
        return response.data;
    } else {
        throw new Error(response.error || `Failed to parse HTML in offscreen document (withMarkers: ${withMarkers}).`);
    }
}

async function getLinksFromHtml(html) {
    await setupOffscreenDocument();
    const response = await chrome.runtime.sendMessage({
        type: 'parse-html-for-links',
        target: 'offscreen',
        data: html,
    });

    if (response && response.success) {
        return response.data;
    } else {
        throw new Error(response.error || 'Failed to parse HTML for links in offscreen document.');
    }
}

async function getAudioDurationOffscreen(audioBuffer) {
    await setupOffscreenDocument();
    const base64String = arrayBufferToBase64(audioBuffer);

    const response = await chrome.runtime.sendMessage({
        type: 'get-audio-duration',
        target: 'offscreen',
        data: { base64: base64String }
    });

    if (response && response.success) {
        return response.duration;
    } else {
        throw new Error(response.error || 'Failed to get audio duration from offscreen document.');
    }
}

async function normalizeAudioOffscreen(audioBlob) {
    await setupOffscreenDocument();
    try {
        const arrayBuffer = await audioBlob.arrayBuffer();
        const base64String = arrayBufferToBase64(arrayBuffer);

        const response = await chrome.runtime.sendMessage({
            type: 'normalize-audio',
            target: 'offscreen',
            data: { base64: base64String, type: audioBlob.type }
        });

        if (response && response.success) {
            const processedBuffer = base64Decode(response.data.base64);
            return new Blob([processedBuffer], { type: response.data.type });
        } else {
            logger.error('CreateUtils:normalizeAudioOffscreen', 'Offscreen normalization failed.', response?.error);
            return audioBlob;
        }
    } catch (error) {
        logger.error('CreateUtils:normalizeAudioOffscreen', 'Error sending audio to offscreen doc', error);
        return audioBlob;
    }
}

// --- HTML Generation Helpers ---
const SHARED_GENERATED_PAGE_CSS = `
/* ext/generated_page_style.css */
:root {
  --generated-bg-primary: #ffffff; --generated-bg-secondary: #f8f8f8; --generated-text-primary: #202124; --generated-text-secondary: #5f6368; --generated-text-accent: #1a73e8; --generated-border-primary: #dadce0; --generated-border-secondary: #e0e0e0; --generated-link-color: #1a73e8; --generated-link-hover-color: #185abc; --generated-button-bg: #1a73e8; --generated-button-text: #ffffff; --generated-button-hover-bg: #185abc; --quiz-question-text: var(--generated-text-primary); --quiz-option-bg: var(--generated-bg-secondary); --quiz-option-border: var(--generated-border-secondary); --quiz-feedback-correct-bg: #e6f4ea; --quiz-feedback-correct-text: #1e8e3e; --quiz-feedback-incorrect-bg: #fce8e6; --quiz-feedback-incorrect-text: #d93025;
}
@media (prefers-color-scheme: dark) {
  body:not(.light-mode) {
    --generated-bg-primary: #202124; --generated-bg-secondary: #2d2e31; --generated-text-primary: #e8eaed; --generated-text-secondary: #bdc1c6; --generated-text-accent: #8ab4f8; --generated-border-primary: #5f6368; --generated-border-secondary: #3c4043; --generated-link-color: #8ab4f8; --generated-link-hover-color: #aecbfa; --generated-button-bg: #8ab4f8; --generated-button-text: #202124; --generated-button-hover-bg: #aecbfa; --quiz-question-text: var(--generated-text-primary); --quiz-option-bg: var(--generated-bg-secondary); --quiz-option-border: var(--generated-border-secondary); --quiz-feedback-correct-bg: #2a3a2e; --quiz-feedback-correct-text: #81c995; --quiz-feedback-incorrect-bg: #4d322f; --quiz-feedback-incorrect-text: #f28b82;
  }
}
body.dark-mode {
    --generated-bg-primary: #202124; --generated-bg-secondary: #2d2e31; --generated-text-primary: #e8eaed; --generated-text-secondary: #bdc1c6; --generated-text-accent: #8ab4f8; --generated-border-primary: #5f6368; --generated-border-secondary: #3c4043; --generated-link-color: #8ab4f8; --generated-link-hover-color: #aecbfa; --generated-button-bg: #8ab4f8; --generated-button-text: #202124; --generated-button-hover-bg: #aecbfa;
}
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.65; margin: 0; padding: 0; background-color: var(--generated-bg-primary); color: var(--generated-text-primary); transition: background-color 0.2s ease-in-out, color 0.2s ease-in-out; }
.page-container { max-width: 800px; margin: 0 auto; padding: 20px; }
h1, h2, h3, h4, h5, h6 { color: var(--generated-text-primary); margin-top: 1.8em; margin-bottom: 0.8em; line-height: 1.3; }
h1 { font-size: 2em; border-bottom: 1px solid var(--generated-border-secondary); padding-bottom: 0.4em; }
h2 { font-size: 1.6em; border-bottom: 1px solid var(--generated-border-secondary); padding-bottom: 0.3em;}
h3 { font-size: 1.3em; }
p { margin-bottom: 1.2em; } a { color: var(--generated-link-color); text-decoration: none; } a:hover, a:focus { color: var(--generated-link-hover-color); text-decoration: underline; }
ul, ol { padding-left: 1.5em; margin-bottom: 1.2em; } li { margin-bottom: 0.5em; }
.button, button { display: inline-block; padding: 10px 15px; margin: 5px 0; font-size: 1em; font-weight: 500; color: var(--generated-button-text); background-color: var(--generated-button-bg); border: none; border-radius: 4px; cursor: pointer; text-align: center; text-decoration: none; transition: background-color 0.2s ease; }
.button:hover, button:hover { background-color: var(--generated-button-hover-bg); }
.quiz-container { } .question-container { margin-bottom: 25px; padding: 15px; border: 1px solid var(--generated-border-primary); border-radius: 5px; background-color: var(--generated-bg-secondary); }
.question-text { font-size: 1.1em; font-weight: bold; margin-bottom: 15px; color: var(--quiz-question-text); }
.options-list { list-style: none; padding: 0; } .options-list li { margin-bottom: 10px; padding: 10px; border: 1px solid var(--quiz-option-border); border-radius: 4px; background-color: var(--quiz-option-bg); cursor: pointer; transition: background-color 0.2s, border-color 0.2s; }
.options-list li:hover { border-color: var(--generated-text-accent); background-color: var(--generated-bg-primary); }
.options-list input[type="radio"] { margin-right: 10px; accent-color: var(--generated-text-accent); }
.feedback-area { margin-top: 10px; padding: 8px; border-radius: 4px; font-size: 0.9em; }
.feedback-area.correct { background-color: var(--quiz-feedback-correct-bg); color: var(--quiz-feedback-correct-text); border: 1px solid var(--quiz-feedback-correct-text); }
.feedback-area.incorrect { background-color: var(--fce8e6); color: var(--quiz-feedback-incorrect-text); border: 1px solid var(--quiz-feedback-incorrect-text); }
@media (max-width: 768px) { .page-container { padding: 15px; } h1 { font-size: 1.8em; } h2 { font-size: 1.4em; } h3 { font-size: 1.2em; } .button, button { width: 100%; } }
`;

export function enhanceHtml(bodyHtml, pageTitle) {
    let cleanBody = String(bodyHtml || "").trim();
    const bodyMatch = cleanBody.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch && bodyMatch[1]) {
        cleanBody = bodyMatch[1].trim();
    }
    
    const interceptorUrl = chrome.runtime.getURL('page_interceptor.js');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageTitle} - Unlock</title>
  <style>${SHARED_GENERATED_PAGE_CSS}</style>
</head>
<body>
  <div class="page-container">${cleanBody}</div>
  <script src="${interceptorUrl}"></script>
</body>
</html>`;
}

// --- Main Creation Functions ---

export async function generateDraftPacketFromTab(initiatorTabId) {
    const draftId = `draft_${Date.now()}`;
    let analysisResult = null;

    try {
        const tab = await chrome.tabs.get(initiatorTabId);
        if (!tab || !tab.url || !tab.url.startsWith('http')) {
            throw new Error("Cannot create a packet from the current page. Invalid or inaccessible URL.");
        }

        const sourcePageContentItem = {
            origin: 'external',
            format: 'html',
            access: 'public',
            url: tab.url,
            title: tab.title || 'Source Page',
            context: 'The original source page this packet was created from.'
        };

        const activeModelConfig = await storage.getActiveModelConfig();
        if (!activeModelConfig) {
            throw new Error('LLM must be configured in Settings.');
        }

        const injectionResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => document.documentElement.outerHTML,
        });

        if (!injectionResults || injectionResults.length === 0 || !injectionResults[0].result) {
            throw new Error("Could not retrieve page content.");
        }
        const plainTextForTopic = await getAndParseHtml(injectionResults[0].result);

        const llmAnalysis = await llmService.callLLM('extract_title_from_html', { htmlContent: plainTextForTopic });
        if (!llmAnalysis.success || !llmAnalysis.data?.title) {
            throw new Error(llmAnalysis.error || 'LLM failed to analyze page content.');
        }
        analysisResult = llmAnalysis.data;
        const title = analysisResult.title;

        const externalContentResponse = await llmService.callLLM('article_suggestions', { title: title, contentSummary: analysisResult.contentSummary });
        
        let validatedExternalLinks = externalContentResponse.success ? (externalContentResponse.data.contents || [])
            .filter(item => item?.url?.startsWith('https://en.wikipedia.org/wiki/') && item.title && item.context)
            .map(item => ({
                origin: 'external',
                format: 'html',
                access: 'public',
                url: decodeURIComponent(item.url),
                title: item.title,
                context: item.context
            })) : [];

        const summaryPageDef = {
            origin: 'internal',
            format: 'html',
            access: 'private',
            lrl: `/pages/summary.html`,
            title: `${title} Summary`,
            contentType: "text/html",
            cacheable: true
        };
        
        const allContentForSummary = [...validatedExternalLinks, sourcePageContentItem];
        const summaryContext = { title: title, allPacketContents: allContentForSummary };
        const summaryResponse = await llmService.callLLM('summary_page', summaryContext);
        
        if (!summaryResponse.success || !summaryResponse.data) {
            throw new Error(summaryResponse.error || 'LLM failed to generate summary.');
        }
        const summaryHtmlBodyLLM = String(summaryResponse.data).trim();
        const finalSummaryHtml = enhanceHtml(summaryHtmlBodyLLM, summaryPageDef.title);
        
        const summaryHtmlBuffer = new TextEncoder().encode(finalSummaryHtml);
        await indexedDbStorage.saveGeneratedContent(draftId, sanitizeForFileName(summaryPageDef.lrl), [{
            name: 'index.html',
            content: summaryHtmlBuffer,
            contentType: summaryPageDef.contentType
        }]);

        const ttsParsingResponse = await chrome.runtime.sendMessage({
            type: 'parse-html-for-tts-and-links',
            target: 'offscreen',
            data: { html: finalSummaryHtml }
        });

        if (!ttsParsingResponse || !ttsParsingResponse.success) {
            throw new Error(ttsParsingResponse.error || "Failed to parse HTML for TTS.");
        }
        
        const { plainText: plainTextForAudio, linkMappings } = ttsParsingResponse.data;
        const audioResponse = await ttsService.generateAudio(plainTextForAudio);
        
        let audioItem = null;
        let moments = [];
        let checkpoints = [];

        const summaryVisitMoment = { id: 'moment_0', type: 'visit', sourceUrl: summaryPageDef.lrl };
        moments.push(summaryVisitMoment);
        const summaryVisitMomentIndex = 0;

        const revealableItems = [...validatedExternalLinks, sourcePageContentItem];
        revealableItems.forEach(item => { item.revealedByMoments = [summaryVisitMomentIndex]; });
        revealableItems.forEach(item => { checkpoints.push({ title: `Visit: ${item.title}`, requiredItems: [{ url: item.url }] }); });

        if (audioResponse.success) {
            const normalizedAudioBlob = await normalizeAudioOffscreen(audioResponse.audioBlob);
            const audioBuffer = await normalizedAudioBlob.arrayBuffer();

            audioItem = {
                origin: 'internal',
                format: 'audio',
                access: 'private',
                lrl: `/media/summary-audio.mp3`,
                title: `${title} Audio Summary`,
                mimeType: normalizedAudioBlob.type,
                cacheable: true
            };
            
            await indexedDbStorage.saveGeneratedContent(draftId, sanitizeForFileName(audioItem.lrl), [{
                name: 'audio.mp3',
                content: audioBuffer,
                contentType: audioItem.mimeType
            }]);

            const audioDuration = await getAudioDurationOffscreen(audioBuffer);

            if (audioDuration > 0) {
                const linkTimestamps = {};
                linkMappings.forEach(mapping => {
                    linkTimestamps[mapping.href] = (mapping.charIndex / plainTextForAudio.length) * audioDuration;
                });

                Object.keys(linkTimestamps).forEach(href => {
                    const moment = {
                        id: `moment_${moments.length}`,
                        type: 'mediaTimestamp',
                        sourceUrl: audioItem.lrl,
                        timestamp: linkTimestamps[href]
                    };
                    moments.push(moment);
                    
                    const currentMomentIndex = moments.length - 1;
                    revealableItems.filter(item => item.url === decodeURIComponent(href))
                        .forEach(itemToReveal => { itemToReveal.revealedByMoments.push(currentMomentIndex); });
                });
            }
        }
        
        const finalSourceContent = [summaryPageDef];
        if (audioItem) finalSourceContent.push(audioItem);
        finalSourceContent.push(...revealableItems);
        
        return {
            success: true,
            draft: { id: draftId, title, sourceContent: finalSourceContent, moments, checkpoints }
        };

    } catch (error) {
        logger.error('CreateUtils:generateDraftFromTab', `Error creating draft from tab ${initiatorTabId}`, error);
        return { success: false, error: error.message };
    }
}

export async function processCreatePacketRequest(data, initiatorTabId) {
    const { title } = data;
    if (!title) { return { success: false, error: "Title is required." }; }

    const imageId = `img_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    logger.log('CreateUtils:processCreatePacketRequest', 'Starting image creation for title:', { title, imageId });

    try {
        const activeModelConfig = await storage.getActiveModelConfig();
        const cloudStorageEnabled = await storage.isCloudStorageEnabled();
        if (!activeModelConfig || !cloudStorageEnabled) {
            throw new Error('LLM and Cloud Storage must be fully configured in Settings.');
        }

        const externalContentResponse = await llmService.callLLM('article_suggestions', { title });
        if (!externalContentResponse.success || !externalContentResponse.data?.contents) {
            throw new Error(externalContentResponse.error || 'LLM failed to return articles.');
        }
        const validatedExternalLinks = (externalContentResponse.data.contents || [])
            .filter(item => item?.url?.startsWith('https://en.wikipedia.org/wiki/') && item.title && item.context)
            .map(item => ({
                origin: 'external',
                format: 'html',
                access: 'public',
                url: decodeURIComponent(item.url),
                title: item.title,
                context: item.context
            }));
        if (validatedExternalLinks.length === 0) {
            throw new Error(`LLM returned no valid Wikipedia articles for "${title}". Please try a more specific title.`);
        }
        
        const summaryPageDef = {
            origin: 'internal',
            format: 'html',
            access: 'private',
            lrl: "/pages/summary.html",
            title: `${title} Summary`,
            contentType: "text/html",
            cacheable: true
        };

        const summaryResponse = await llmService.callLLM('summary_page', { title: title, allPacketContents: validatedExternalLinks });
        if (!summaryResponse.success || !summaryResponse.data) throw new Error(summaryResponse.error || 'LLM failed to generate summary.');
        
        const summaryHtmlBodyLLM = String(summaryResponse.data).trim();
        const finalSummaryHtml = enhanceHtml(summaryHtmlBodyLLM, summaryPageDef.title);
        const summaryHtmlBuffer = new TextEncoder().encode(finalSummaryHtml);
        
        await indexedDbStorage.saveGeneratedContent(imageId, sanitizeForFileName(summaryPageDef.lrl), [{
            name: 'index.html',
            content: summaryHtmlBuffer,
            contentType: summaryPageDef.contentType
        }]);

        const finalSourceContent = [
            summaryPageDef,
            ...validatedExternalLinks,
        ];

        const packetImage = {
            id: imageId,
            title: title,
            created: new Date().toISOString(),
            sourceContent: finalSourceContent,
            moments: []
        };
        await storage.savePacketImage(packetImage);
        logger.log('CreateUtils', 'Packet Image and its content saved successfully', { imageId });

        return { success: true, imageId: imageId, image: packetImage };

    } catch (error) {
        logger.error('CreateUtils:processCreatePacketRequest', `Error creating packet image for title ${title}`, error);
        return { success: false, error: error.message };
    }
}

export async function processCreatePacketRequestFromTab(initiatorTabId) {
    const imageId = `img_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    let analysisResult = null;
    try {
        const tab = await chrome.tabs.get(initiatorTabId);
        if (!tab || !tab.url || tab.url.startsWith('chrome')) {
            throw new Error("Cannot create a packet from the current page. Invalid or inaccessible URL.");
        }
        const sourcePageContentItem = {
            origin: 'external',
            format: 'html',
            access: 'public',
            url: tab.url,
            title: tab.title || 'Source Page',
            context: 'The original source page this packet was created from.'
        };
        const activeModelConfig = await storage.getActiveModelConfig();
        if (!activeModelConfig) {
            throw new Error('LLM must be configured in Settings.');
        }
        const injectionResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => document.documentElement.outerHTML,
        });
        if (!injectionResults || !injectionResults.length === 0 || !injectionResults[0].result) {
            throw new Error("Could not retrieve page content. The page may be protected.");
        }
        const plainTextForTopic = await getAndParseHtml(injectionResults[0].result);
        const llmAnalysis = await llmService.callLLM('extract_title_from_html', { htmlContent: plainTextForTopic });
        if (!llmAnalysis.success || !llmAnalysis.data?.title) {
            throw new Error(llmAnalysis.error || 'LLM failed to analyze page content.');
        }
        analysisResult = llmAnalysis.data;
        const title = analysisResult.title;
        const externalContentResponse = await llmService.callLLM('article_suggestions', { title: title, contentSummary: analysisResult.contentSummary });
        let validatedExternalLinks = externalContentResponse.success ? (externalContentResponse.data.contents || [])
            .filter(item => item?.url?.startsWith('https://en.wikipedia.org/wiki/') && item.title && item.context)
            .map(item => ({
                origin: 'external',
                format: 'html',
                access: 'public',
                url: decodeURIComponent(item.url),
                title: item.title,
                context: item.context
            })) : [];
        if (validatedExternalLinks.length === 0) {
            logger.warn('CreateUtils:FromTab', `LLM returned no valid Wikipedia articles for "${title}".`);
        }
        const summaryPageDef = {
            origin: 'internal',
            format: 'html',
            access: 'private',
            lrl: `/pages/summary.html`,
            title: `${title} Summary`,
            contentType: "text/html",
            cacheable: true
        };
        const allContentForSummary = [...validatedExternalLinks, sourcePageContentItem];
        const summaryContext = { title: title, allPacketContents: allContentForSummary };
        const summaryResponse = await llmService.callLLM('summary_page', summaryContext);
        if (!summaryResponse.success || !summaryResponse.data) throw new Error(summaryResponse.error || 'LLM failed to generate summary.');
        const summaryHtmlBodyLLM = String(summaryResponse.data).trim();
        const finalSummaryHtml = enhanceHtml(summaryHtmlBodyLLM, summaryPageDef.title);
        const summaryHtmlBuffer = new TextEncoder().encode(finalSummaryHtml);
        await indexedDbStorage.saveGeneratedContent(imageId, sanitizeForFileName(summaryPageDef.lrl), [{
            name: 'index.html',
            content: summaryHtmlBuffer,
            contentType: summaryPageDef.contentType
        }]);
        const plainTextForAudio = await getAndParseHtml(finalSummaryHtml, true);
        const audioResponse = await ttsService.generateAudio(plainTextForAudio);
        let audioItem = null;
        let moments = [];
        if (audioResponse.success) {
            const normalizedAudioBlob = await normalizeAudioOffscreen(audioResponse.audioBlob);
            const audioBuffer = await normalizedAudioBlob.arrayBuffer();
            audioItem = {
                origin: 'internal',
                format: 'audio',
                access: 'private',
                lrl: `/media/summary-audio.mp3`,
                title: `${title} Audio Summary`,
                mimeType: normalizedAudioBlob.type,
                cacheable: true
            };
            await indexedDbStorage.saveGeneratedContent(imageId, sanitizeForFileName(audioItem.lrl), [{
                name: 'audio.mp3',
                content: audioBuffer,
                contentType: audioItem.mimeType
            }]);
            const audioDuration = await getAudioDurationOffscreen(audioBuffer);
            if (audioDuration > 0) {
                const links = await getLinksFromHtml(finalSummaryHtml);
                const linkTimestamps = {};
                links.forEach(link => {
                    const markedText = `*${link.text}*`;
                    const charIndex = plainTextForAudio.indexOf(markedText);
                    if (charIndex !== -1) {
                        const timestamp = (charIndex / plainTextForAudio.length) * audioDuration;
                        linkTimestamps[link.href] = timestamp;
                    }
                });
                Object.keys(linkTimestamps).forEach(href => {
                    const moment = {
                        id: `moment_${moments.length}`,
                        type: 'mediaTimestamp',
                        sourceUrl: audioItem.lrl,
                        timestamp: linkTimestamps[href]
                    };
                    moments.push(moment);
                    const decodedHref = decodeURIComponent(href);
                    validatedExternalLinks.filter(item => item.url === decodedHref)
                        .forEach(itemToReveal => {
                            if (!Array.isArray(itemToReveal.revealedByMoments)) {
                                itemToReveal.revealedByMoments = [];
                            }
                            itemToReveal.revealedByMoments.push(moments.length - 1);
                        });
                });
            }
        } else {
            logger.warn('CreateUtils:FromTab', 'TTS service failed to generate audio.', audioResponse.error);
        }
        const finalSourceContent = [summaryPageDef];
        if (audioItem) finalSourceContent.push(audioItem);
        finalSourceContent.push(...validatedExternalLinks, sourcePageContentItem);
        const packetImage = { 
            id: imageId, 
            title, 
            created: new Date().toISOString(), 
            sourceContent: finalSourceContent,
            moments: moments
        };
        await storage.savePacketImage(packetImage);
        return { success: true, imageId: imageId, image: packetImage };
    } catch (error) {
        logger.error('CreateUtils:processCreatePacketRequestFromTab', `Error creating packet from tab ${initiatorTabId}`, error);
        return { success: false, error: error.message, title: analysisResult?.title };
    }
}