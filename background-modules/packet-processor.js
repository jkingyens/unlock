// ext/background-modules/packet-processor.js
// Handles the complex logic for creating packet images and instances,
// managing generated content in IndexedDB, publishing to cloud storage,
// and the sharing/import logic.
// REVISED: Re-integrated Base64 content into PacketImage.

import {
    logger,
    storage,
    indexedDbStorage,
    shouldUseTabGroups,
    CONFIG,
    arrayBufferToBase64,
    base64Decode,
    MPI_PARAMS,
    sanitizeForFileName
} from '../utils.js';
import llmService from '../llm_service.js';
import cloudStorage from '../cloud-storage.js';
import * as tabGroupHandler from './tab-group-handler.js';
import * as ruleManager from './rule-manager.js';
import ttsService from '../tts_service.js';

// --- Offscreen Document Management ---
let creatingOffscreenDocument; // A Promise that resolves when the offscreen document is created

async function hasOffscreenDocument() {
    if (typeof chrome.runtime.getManifest === 'function' && chrome.runtime.getManifest().offscreen) {
        // Correct check for Manifest V3
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT']
        });
        return contexts.length > 0;
    } else {
         // Fallback for older environments or where the API might not be fully supported
         // This path is less reliable.
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
            reasons: ['DOM_PARSER'],
            justification: 'Parse HTML string to extract text content and links.',
        });
        await creatingOffscreenDocument;
        creatingOffscreenDocument = null;
    }
}


async function getAndParseHtml(html) {
  await setupOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    type: 'parse-html-for-text',
    target: 'offscreen',
    data: html,
  });

  if (response && response.success) {
      return response.data;
  } else {
      throw new Error(response.error || 'Failed to parse HTML for text in offscreen document.');
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

async function processHtmlViaOffscreen(html, packetImageId) {
    logger.log('PacketProcessor:processHtmlViaOffscreen', 'Offscreen processing is DISABLED. Returning raw HTML.', { packetImageId, htmlLength: html?.length });
    return html;
}

// Helper to send targeted progress messages for stencil updates to the sidebar
function sendStencilProgressNotification(imageId, step, status, text, progressPercent, topic = null) {
    const data = {
        imageId: imageId,
        step: step,
        status: status,
        text: text,
        progressPercent: progressPercent
    };
    if (topic) {
        data.topic = topic;
    }
    const message = {
        action: 'packet_creation_progress',
        data: data
    };
    chrome.runtime.sendMessage(message).catch(err => {
        if (err && err.message && !err.message.includes("Receiving end does not exist") && !err.message.includes("Could not establish connection")) {
            logger.warn('PacketProcessor:sendStencilProgress', `Could not send progress for ${imageId}. Error: ${err.message}`, { messageData: message.data });
        }
    });
}


function sendProgressNotification(action, data) {
    chrome.runtime.sendMessage({ action: action, data: data })
      .catch(err => {
           if (err && err.message && !err.message.includes("Receiving end does not exist") && !err.message.includes("Could not establish connection")) {
               logger.warn('PacketProcessor:sendProgress', `Could not send ${action} message`, err);
           }
      });
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
.options-list input[type="radio"] { margin-right: 10px; accent-color: var(--text-accent); }
.feedback-area { margin-top: 10px; padding: 8px; border-radius: 4px; font-size: 0.9em; }
.feedback-area.correct { background-color: var(--quiz-feedback-correct-bg); color: var(--quiz-feedback-correct-text); border: 1px solid var(--quiz-feedback-correct-text); }
.feedback-area.incorrect { background-color: var(--fce8e6); color: var(--quiz-feedback-incorrect-text); border: 1px solid var(--quiz-feedback-incorrect-text); }
@media (max-width: 768px) { .page-container { padding: 15px; } h1 { font-size: 1.8em; } h2 { font-size: 1.4em; } h3 { font-size: 1.2em; } .button, button { width: 100%; } }
`;

export function enhanceHtml(bodyHtml, topic, pageTitle) {
    let cleanBody = String(bodyHtml || "").trim();
    const bodyMatch = cleanBody.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch && bodyMatch[1]) {
        cleanBody = bodyMatch[1].trim();
    }
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
</body>
</html>`;
}

// --- Main Processing Functions ---

export async function processGenerateCustomPageRequest(data) {
    const { prompt, context } = data;
    if (!prompt) {
        return { success: false, error: 'A prompt is required.' };
    }

    try {
        // --- PASS 1: Generate the initial page ---
        logger.log("PacketProcessor:CustomPage", "Starting initial page generation.");
        const generationResult = await llmService.callLLM('custom_page', { prompt, context });
        if (!generationResult.success || !generationResult.data) {
            throw new Error(generationResult.error || "LLM service failed to generate page.");
        }
        const initialHtml = generationResult.data;
        logger.log("PacketProcessor:CustomPage", "Initial page generated. Starting modification pass.");

        // --- PASS 2: Analyze and modify the generated page ---
        const modificationResult = await llmService.callLLM('modify_html_for_completion', { htmlContent: initialHtml });
        if (!modificationResult.success || !modificationResult.data) {
            logger.warn("PacketProcessor:CustomPage", "Modification pass failed. Using initial HTML.", modificationResult.error);
            // Fallback to using the initial HTML if the modification pass fails
        }
        const finalHtml = modificationResult.data || initialHtml;
        
        // --- Finalize and package the result ---
        const contentB64 = arrayBufferToBase64(new TextEncoder().encode(finalHtml));
        const titleMatch = finalHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
        const pageTitle = titleMatch ? titleMatch[1] : (prompt.substring(0, 50) + (prompt.length > 50 ? '...' : ''));

        // Check if the completion trigger was added to determine if the page is interactive
        const isInteractive = finalHtml.includes("notifyExtensionOnCompletion()");

        const newContentItem = {
            type: 'generated',
            pageId: `custom_${Date.now()}`,
            title: pageTitle,
            contentType: 'text/html',
            contentB64: contentB64,
            interactionBasedCompletion: isInteractive // Set based on analysis
        };

        logger.log("PacketProcessor:CustomPage", "Custom page processing complete.", { pageTitle, isInteractive });
        return { success: true, newItem: newContentItem };

    } catch (error) {
        logger.error("PacketProcessor:CustomPage", "Error generating custom page", error);
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

        // Create a content item for the source page itself
        const sourcePageContentItem = {
            type: 'external',
            url: tab.url,
            title: tab.title || 'Source Page',
            relevance: 'The original source page this packet was created from.'
        };

        sendStencilProgressNotification(imageId, 'init', 'active', 'Analyzing page...', 5, 'Analyzing Page...');

        // Step 1: Check config
        const activeModelConfig = await storage.getActiveModelConfig();
        const cloudStorageEnabled = await storage.isCloudStorageEnabled();
        if (!activeModelConfig || !cloudStorageEnabled || !(await cloudStorage.initialize())) {
            throw new Error('LLM and Cloud Storage must be fully configured in Settings.');
        }

        // Step 2: Inject script to get page content
        const injectionResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => document.documentElement.outerHTML,
        });

        if (!injectionResults || injectionResults.length === 0 || !injectionResults[0].result) {
            throw new Error("Could not retrieve page content. The page may be protected.");
        }
        const htmlContent = injectionResults[0].result;
        
        // Use the offscreen document to parse the HTML and get main text
        const pageTextContent = await getAndParseHtml(htmlContent);

        sendStencilProgressNotification(imageId, 'analyze', 'active', 'Extracting topic...', 10);
        const llmAnalysis = await llmService.callLLM('extract_topic_from_html', { htmlContent: pageTextContent });
        if (!llmAnalysis.success || !llmAnalysis.data?.topic) {
            throw new Error(llmAnalysis.error || 'LLM failed to analyze page content.');
        }
        analysisResult = llmAnalysis.data;
        const topic = analysisResult.topic;
        logger.log('PacketProcessor:FromTab', 'LLM analysis complete', { topic: topic });
        sendStencilProgressNotification(imageId, 'analyze', 'completed', 'Topic identified', 20, topic);

        // Step 3: Find related articles and media
        sendStencilProgressNotification(imageId, 'articles', 'active', 'Finding articles...', 25, topic);
        const externalContentResponse = await llmService.callLLM('article_suggestions', { topic: topic, contentSummary: analysisResult.contentSummary });
        if (!externalContentResponse.success || !externalContentResponse.data?.contents) {
            throw new Error(externalContentResponse.error || 'LLM failed to return articles.');
        }
        const validatedExternalLinks = (externalContentResponse.data.contents || [])
            .filter(item => item?.url?.startsWith('https://en.wikipedia.org/wiki/') && item.title && item.relevance)
            .map(item => ({ type: 'external', url: decodeURIComponent(item.url), title: item.title, relevance: item.relevance }));
        
        if (validatedExternalLinks.length === 0) {
            logger.warn('PacketProcessor:FromTab', `LLM returned no valid Wikipedia articles for "${topic}". Packet will be created without them.`);
        }

        sendStencilProgressNotification(imageId, 'media', 'active', 'Finding media...', 35, topic);
        const mediaResponse = await llmService.callLLM('extract_media', { htmlContent: pageTextContent });
        let mediaContentItems = [];
        if (mediaResponse.success && Array.isArray(mediaResponse.data?.media)) {
            const pageUrl = new URL(tab.url); // The base URL of the page

            for (const media of mediaResponse.data.media) {
                if (media.url && media.title) {
                    let absoluteUrl;
                    try {
                        // Create a new URL object, which will handle both absolute and relative URLs
                        absoluteUrl = new URL(media.url, pageUrl.href).href;
                    } catch (e) {
                        logger.warn('PacketProcessor:FromTab', `Could not create a valid URL for media: "${media.url}"`, e);
                        continue; // Skip this media item if the URL is invalid
                    }

                    const mediaHtml = `<h1>${media.title}</h1><p><a href="${absoluteUrl}" target="_blank" rel="noopener noreferrer">View media</a></p>`;
                    const enhancedMediaHtml = enhanceHtml(mediaHtml, topic, media.title);
                    mediaContentItems.push({
                        type: 'generated',
                        pageId: `media_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                        title: media.title,
                        contentType: 'text/html',
                        contentB64: arrayBufferToBase64(new TextEncoder().encode(enhancedMediaHtml))
                    });
                }
            }
        }
        sendStencilProgressNotification(imageId, 'articles_media', 'completed', `Found ${validatedExternalLinks.length} articles and ${mediaContentItems.length} media files`, 40, topic);

        
        // Step 4: Generate summary and quiz
        const summaryPageDef = { type: "generated", pageId: "summary-page", title: `${topic} Summary`, contentType: "text/html" };
        let audioMediaItem = null;
        
        const contentForSummaryPrompt = [...validatedExternalLinks, ...mediaContentItems];

        sendStencilProgressNotification(imageId, 'generate_summary', 'active', 'Generating summary...', 50, topic);
        let summaryResponse = await llmService.callLLM('summary_page', { topic: topic, allPacketContents: contentForSummaryPrompt });
        if (!summaryResponse.success || !summaryResponse.data) throw new Error(summaryResponse.error || 'LLM failed to generate summary.');
        
        // Generate audio for the summary
        const summaryTextForTTS = await getAndParseHtml(summaryResponse.data);
        const ttsResponse = await ttsService.generateAudioAndTimestamps(summaryTextForTTS);
        let summaryHtmlBody = await processHtmlViaOffscreen(String(summaryResponse.data).trim(), imageId);
        
        if (ttsResponse.success && ttsResponse.audioBlob) {
            const audioBuffer = await ttsResponse.audioBlob.arrayBuffer();
            audioMediaItem = {
                type: 'media',
                pageId: `audio_summary_${Date.now()}`,
                title: summaryPageDef.title,
                mimeType: 'audio/mpeg',
                timestamps: []
            };
            
            // Extract links and their text from the summary HTML using the offscreen document
            const links = await getLinksFromHtml(summaryHtmlBody);
            let wordTimestamps = [];

            const alignmentResponse = await ttsService.getAlignmentForExistingAudio(audioBuffer, summaryTextForTTS);
            if (!alignmentResponse.success) {
                logger.warn('PacketProcessor:FromTab', 'Failed to get alignment for generated audio.', alignmentResponse.error);
            } else {
                wordTimestamps = alignmentResponse.wordTimestamps;
            }

            // Store debug info from alignment process
            const debugData = {
                rawTimestamps: wordTimestamps || [],
                extractedLinks: links || []
            };
            audioMediaItem.debug = debugData;

            if (wordTimestamps && links.length > 0) {
                // Prepare the word timestamps for searching
                const transcriptWords = wordTimestamps.map(ts => ts.text.toLowerCase().replace(/[.,!?;:]/g, ''));

                links.forEach(link => {
                    const linkWords = link.text.toLowerCase().replace(/[.,!?;:]/g, '').split(/\s+/).filter(w => w);
                    if (linkWords.length === 0) return;

                    // Find the sequence of link words in the transcript
                    let matchIndex = -1;
                    for (let i = 0; i <= transcriptWords.length - linkWords.length; i++) {
                        let isMatch = true;
                        for (let j = 0; j < linkWords.length; j++) {
                            if (transcriptWords[i + j] !== linkWords[j]) {
                                isMatch = false;
                                break;
                            }
                        }
                        if (isMatch) {
                            matchIndex = i;
                            break;
                        }
                    }

                    if (matchIndex !== -1) {
                        const startTime = wordTimestamps[matchIndex].start;
                        const endTime = wordTimestamps[matchIndex + linkWords.length - 1].end;
                        audioMediaItem.timestamps.push({
                            url: link.href,
                            text: link.text,
                            startTime: startTime,
                            endTime: endTime
                        });
                    } else {
                        logger.warn("PacketProcessor:Timestamping", "Could not find word sequence for link text in transcript", { linkText: link.text });
                    }
                });
            }

            await indexedDbStorage.saveGeneratedContent(imageId, audioMediaItem.pageId, [{
                name: 'audio.mp3',
                content: audioBuffer,
                contentType: 'audio/mpeg'
            }]);
            logger.log('PacketProcessor:FromTab', 'Successfully created media item for TTS audio and saved to IndexedDB.');
        } else {
            logger.warn('PacketProcessor:FromTab', 'Failed to generate audio from ElevenLabs.', ttsResponse.error);
        }

        summaryPageDef.contentB64 = arrayBufferToBase64(new TextEncoder().encode(enhanceHtml(summaryHtmlBody, topic, summaryPageDef.title)));
        sendStencilProgressNotification(imageId, 'generate_summary', 'completed', 'Summary generated', 70, topic);
        
        // Step 5: Assemble and save PacketImage, with the source page first.
        const summaryContent = {
            type: 'alternative',
            alternatives: [summaryPageDef]
        };
        if (audioMediaItem) {
            summaryContent.alternatives.push(audioMediaItem);
        }

        const finalSourceContent = [
            summaryContent,
            ...validatedExternalLinks,
            ...mediaContentItems,
            sourcePageContentItem
        ];
        
        const packetImage = { id: imageId, topic: topic, created: new Date().toISOString(), sourceContent: finalSourceContent };
        
        await storage.savePacketImage(packetImage);
        logger.log('PacketProcessor:FromTab', 'Packet Image with embedded Base64 content saved successfully', { imageId });
        sendStencilProgressNotification(imageId, 'local_save_final', 'completed', 'Packet ready in Library', 100, topic);

        sendProgressNotification('packet_image_created', { image: packetImage });
        return { success: true, imageId: imageId };

    } catch (error) {
        logger.error('PacketProcessor:processCreatePacketRequestFromTab', `Error creating packet from tab ${initiatorTabId}`, error);
        sendProgressNotification('packet_creation_failed', { imageId: imageId, error: error.message, topic: analysisResult?.topic });
        return { success: false, error: error.message };
    }
}


export async function processCreatePacketRequest(data, initiatorTabId) {
    const { topic } = data;
    if (!topic) { return { success: false, error: "Topic is required." }; }

    const imageId = `img_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    logger.log('PacketProcessor:processCreatePacketRequest', 'Starting image creation for topic:', { topic, imageId });

    try {
        // Send initial progress notification using the final imageId for tracking
        sendStencilProgressNotification(imageId, 'init', 'active', 'Preparing...', 5, topic);

        const activeModelConfig = await storage.getActiveModelConfig();
        const cloudStorageEnabled = await storage.isCloudStorageEnabled();
        if (!activeModelConfig || !cloudStorageEnabled || !(await cloudStorage.initialize())) {
            throw new Error('LLM and Cloud Storage must be fully configured in Settings.');
        }
        sendStencilProgressNotification(imageId, 'config_check', 'completed', 'Configuration validated', 10);

        sendStencilProgressNotification(imageId, 'articles', 'active', 'Finding articles...', 15);
        const externalContentResponse = await llmService.callLLM('article_suggestions', { topic });
        if (!externalContentResponse.success || !externalContentResponse.data?.contents) {
            throw new Error(externalContentResponse.error || 'LLM failed to return articles.');
        }
        const validatedExternalLinks = (externalContentResponse.data.contents || [])
            .filter(item => item?.url?.startsWith('https://en.wikipedia.org/wiki/') && item.title && item.relevance)
            .map(item => ({ type: 'external', url: decodeURIComponent(item.url), title: item.title, relevance: item.relevance }));
        if (validatedExternalLinks.length === 0) {
            throw new Error(`LLM returned no valid Wikipedia articles for "${topic}". Please try a more specific topic.`);
        }
        sendStencilProgressNotification(imageId, 'articles', 'completed', `Found ${validatedExternalLinks.length} articles`, 30);
        
        // 1. Define generated content structure
        const summaryPageDef = { type: "generated", pageId: "summary-page", title: `${topic} Summary`, contentType: "text/html" };

        // 2. Generate content for each defined item
        sendStencilProgressNotification(imageId, 'generate_summary', 'active', 'Generating summary...', 40);
        const summaryResponse = await llmService.callLLM('summary_page', { topic: topic, allPacketContents: validatedExternalLinks });
        if (!summaryResponse.success || !summaryResponse.data) throw new Error(summaryResponse.error || 'LLM failed to generate summary.');
        const summaryHtmlBody = await processHtmlViaOffscreen(String(summaryResponse.data).trim(), imageId);
        const finalSummaryHtml = enhanceHtml(summaryHtmlBody, topic, summaryPageDef.title);
        summaryPageDef.contentB64 = arrayBufferToBase64(new TextEncoder().encode(finalSummaryHtml));
        sendStencilProgressNotification(imageId, 'generate_summary', 'completed', 'Summary generated', 60);

        // 3. Assemble the final PacketImage with embedded content
        const finalSourceContent = [
            {
                type: 'alternative',
                alternatives: [summaryPageDef]
            },
            ...validatedExternalLinks,
        ];

        const packetImage = { id: imageId, topic: topic, created: new Date().toISOString(), sourceContent: finalSourceContent };
        await storage.savePacketImage(packetImage);
        logger.log('PacketProcessor', 'Packet Image with embedded Base64 content saved successfully', { imageId });
        sendStencilProgressNotification(imageId, 'local_save_final', 'completed', 'Packet ready in Library', 100);

        // Notify the sidebar that a new image has been created
        sendProgressNotification('packet_image_created', { image: packetImage });

        return { success: true, imageId: imageId };

    } catch (error) {
        logger.error('PacketProcessor:processCreatePacketRequest', `Error creating packet image for topic ${topic}`, error);
        // Use the imageId for the failure notification as well
        sendProgressNotification('packet_creation_failed', { imageId: imageId, error: error.message });
        return { success: false, error: error.message };
    }
}

export async function processGenerateTimestampsRequest(data) {
    const { draftId, htmlPageId, mediaPageId, htmlContentB64 } = data;
    if (!draftId || !htmlPageId || !mediaPageId || !htmlContentB64) {
        return { success: false, error: "Missing required data for timestamp generation." };
    }

    try {
        const htmlContent = new TextDecoder().decode(base64Decode(htmlContentB64));
        
        // 1. Get plain text and links from summary HTML
        const [plainText, links] = await Promise.all([
            getAndParseHtml(htmlContent),
            getLinksFromHtml(htmlContent)
        ]);

        if (!links || links.length === 0) {
            return { success: true, updatedMediaItem: null, message: "No timestampable links found." };
        }

        // 2. Fetch existing audio from IndexedDB
        const audioContent = await indexedDbStorage.getGeneratedContent(draftId, mediaPageId);
        if (!audioContent || audioContent.length === 0) {
            throw new Error(`Audio content not found in IndexedDB for pageId: ${mediaPageId}`);
        }
        const audioBuffer = audioContent[0].content;

        // 3. Get timestamps using the forced alignment API
        const alignmentResponse = await ttsService.getAlignmentForExistingAudio(audioBuffer, plainText);
        if (!alignmentResponse.success) {
            throw new Error(alignmentResponse.error || "Forced alignment service failed.");
        }
        
        const { wordTimestamps } = alignmentResponse;
        
        // 4. Match links to timestamps with the robust algorithm
        const timestamps = [];
        const debugData = {
            rawTimestamps: wordTimestamps || [],
            extractedLinks: links || []
        };

        if (wordTimestamps) {
            const transcriptWords = wordTimestamps.map(ts => ts.text.toLowerCase().replace(/[.,!?;:]/g, ''));
            links.forEach(link => {
                const linkWords = link.text.toLowerCase().replace(/[.,!?;:]/g, '').split(/\s+/).filter(w => w);
                if (linkWords.length === 0) return;

                let matchIndex = -1;
                for (let i = 0; i <= transcriptWords.length - linkWords.length; i++) {
                    let isMatch = true;
                    for (let j = 0; j < linkWords.length; j++) {
                        if (transcriptWords[i + j] !== linkWords[j]) {
                            isMatch = false;
                            break;
                        }
                    }
                    if (isMatch) {
                        matchIndex = i;
                        break;
                    }
                }

                if (matchIndex !== -1) {
                    const startTime = wordTimestamps[matchIndex].start;
                    const endTime = wordTimestamps[matchIndex + linkWords.length - 1].end;
                    timestamps.push({
                        url: link.href,
                        text: link.text,
                        startTime: startTime,
                        endTime: endTime
                    });
                }
            });
        }
        
        // 5. Create the updated media item data structure
        const updatedMediaItem = {
            type: 'media',
            pageId: mediaPageId,
            title: "Summary Audio", // Or get from original item if needed
            mimeType: 'audio/mpeg',
            timestamps: timestamps,
            debug: debugData
        };

        return { success: true, updatedMediaItem };

    } catch (error) {
        logger.error("PacketProcessor:processGenerateTimestampsRequest", "Error during timestamp generation", error);
        return { success: false, error: error.message };
    }
}


export async function instantiatePacket(imageId, preGeneratedInstanceId, initiatorTabId = null) {
    const instanceId = preGeneratedInstanceId;
    logger.log('PacketProcessor:instantiatePacket', 'Starting INSTANCE finalization', { imageId, instanceId });

    try {
        const packetImage = await storage.getPacketImage(imageId);
        if (!packetImage) throw new Error(`Packet Image ${imageId} not found.`);

        const hasGeneratedContent = packetImage.sourceContent.some(item => item.type === 'generated' || item.type === 'media' || (item.type === 'alternative' && item.alternatives.some(alt => alt.type === 'generated' || alt.type === 'media')));
        let activeCloudConfig = null;

        if (hasGeneratedContent) {
            logger.log('PacketProcessor:instantiatePacket', 'Packet contains generated content, checking cloud storage...');
            activeCloudConfig = await storage.getActiveCloudStorageConfig();
            if (!activeCloudConfig) {
                throw new Error("This packet contains generated pages, but no active cloud storage is configured for publishing.");
            }
            if (!(await cloudStorage.initialize())) {
                throw new Error("Cloud storage failed to initialize for publishing.");
            }
        } else {
            logger.log('PacketProcessor:instantiatePacket', 'Packet contains only external links. Skipping cloud storage checks.');
        }

        let packetInstance = {
            instanceId: instanceId,
            imageId: imageId,
            topic: packetImage.topic,
            created: packetImage.created,
            instantiated: new Date().toISOString(),
            contents: [],
            visitedUrls: [],
            visitedGeneratedPageIds: [],
        };

        for (const sourceItem of packetImage.sourceContent) {
            if (sourceItem.type === 'alternative') {
                const settings = await storage.getSettings();
                const preferAudio = settings.preferAudio && sourceItem.alternatives.some(a => a.type === 'media');

                const chosenItem = preferAudio
                    ? sourceItem.alternatives.find(a => a.type === 'media')
                    : sourceItem.alternatives.find(a => a.type === 'generated');
                
                if (chosenItem) {
                    packetInstance.contents.push(chosenItem);
                }

            } else {
                packetInstance.contents.push(sourceItem);
            }
        }
        
        for (let i = 0; i < packetInstance.contents.length; i++) {
            const item = packetInstance.contents[i];
            if (item.type === 'generated') {
                const { pageId, contentB64, contentType } = item;
                if (!contentB64) {
                    logger.warn('PacketProcessor:instantiate', `Generated item ${pageId} is missing Base64 content. Cannot publish.`);
                    item.published = false;
                    item.url = null;
                } else {
                    const decodedContent = base64Decode(contentB64);
                    const filesToUpload = [{ name: 'index.html', content: new TextDecoder().decode(decodedContent), contentType }];
                    
                    await indexedDbStorage.saveGeneratedContent(imageId, pageId, filesToUpload);

                    const uploadResult = await cloudStorage.uploadPacketFiles(instanceId, pageId, filesToUpload, 'private');
                    if (uploadResult.success) {
                        item.url = uploadResult.url;
                        item.published = true;
                        item.publishContext = {
                            storageConfigId: activeCloudConfig.id,
                            provider: activeCloudConfig.provider,
                            region: activeCloudConfig.region,
                            bucket: activeCloudConfig.bucket
                        };
                    } else {
                        throw new Error(`Failed to publish ${pageId}: ${uploadResult.error}`);
                    }
                }
                delete item.contentB64;
            } else if (item.type === 'media') {
                const { pageId, mimeType, title } = item;
                const cachedContent = await indexedDbStorage.getGeneratedContent(imageId, pageId);

                if (!cachedContent || cachedContent.length === 0) {
                    logger.warn('PacketProcessor:instantiate', `Media item ${pageId} is missing from IndexedDB. Cannot publish.`);
                    item.published = false;
                    item.url = null;
                } else {
                    const fileContent = cachedContent[0].content;
                    const fileExtension = mimeType === 'audio/mpeg' ? '.mp3' : '';
                    const fileName = sanitizeForFileName(title) + fileExtension;
                    const filePath = `packets/${instanceId}/${pageId}/${fileName}`;
                    
                    const uploadResult = await cloudStorage.uploadFile(filePath, fileContent, mimeType, 'private');
                    if (uploadResult.success) {
                        item.url = uploadResult.fileName;
                        item.published = true;
                        item.publishContext = {
                            storageConfigId: activeCloudConfig.id,
                            provider: activeCloudConfig.provider,
                            region: activeCloudConfig.region,
                            bucket: activeCloudConfig.bucket
                        };
                    } else {
                        throw new Error(`Failed to publish media ${title}: ${uploadResult.error}`);
                    }
                }
            }
        }

        if (!(await storage.savePacketInstance(packetInstance))) {
            throw new Error("Failed to save final Packet Instance.");
        }
        
        await storage.savePacketBrowserState({ instanceId: instanceId, tabGroupId: null, activeTabIds: [], lastActiveUrl: null });
        
        // This will correctly do nothing if there are no generated items to create rules for
        await ruleManager.addOrUpdatePacketRules(packetInstance);
        
        logger.log('PacketProcessor:instantiatePacket', 'Final Packet Instance and BrowserState saved.', { instanceId });

        return { success: true, instanceId: instanceId, instance: packetInstance };

    } catch (error) {
        logger.error('PacketProcessor:instantiatePacket', 'Error during final instantiation/publishing', { imageId, instanceId, error });
        if (instanceId) {
            await ruleManager.removePacketRules(instanceId);
        }
        return { success: false, error: error.message || 'Unknown instantiation error' };
    }
}

export async function publishImageForSharing(imageId) {
    if (!imageId) return { success: false, error: "Image ID is required for sharing." };
    if (!(await cloudStorage.initialize())) {
        return { success: false, error: "Cloud storage not initialized. Cannot share." };
    }

    try {
        const packetImage = await storage.getPacketImage(imageId);
        if (!packetImage) return { success: false, error: `Packet image ${imageId} not found.` };
        
        // --- FIX START: Embed media content into the export ---
        const imageForExport = JSON.parse(JSON.stringify(packetImage)); // Deep copy to avoid modifying original

        for (const contentItem of imageForExport.sourceContent) {
            let itemsToProcess = [];
            if (contentItem.type === 'media') {
                itemsToProcess.push(contentItem);
            } else if (contentItem.type === 'alternative' && Array.isArray(contentItem.alternatives)) {
                itemsToProcess.push(...contentItem.alternatives.filter(alt => alt.type === 'media'));
            }

            for (const mediaItem of itemsToProcess) {
                const mediaContent = await indexedDbStorage.getGeneratedContent(imageId, mediaItem.pageId);
                if (mediaContent && mediaContent[0] && mediaContent[0].content) {
                    mediaItem.contentB64 = arrayBufferToBase64(mediaContent[0].content);
                }
            }
        }
        // --- FIX END ---

        const jsonString = JSON.stringify(imageForExport);
        const shareFileName = `shared/img_${imageId.replace(/^img_/, '')}_${Date.now()}.json`;

        const uploadResult = await cloudStorage.uploadFile(shareFileName, jsonString, 'application/json', 'public-read');

        if (uploadResult.success && uploadResult.fileName) {
            const publicUrl = cloudStorage.getPublicUrl(uploadResult.fileName);
            if (!publicUrl) return { success: false, error: "Failed to construct public URL after upload." };
            
            logger.log('PacketProcessor:publishImageForSharing', 'Image published for sharing.', { imageId, shareUrl: publicUrl });
            return { success: true, shareUrl: publicUrl, message: "Packet link ready to share!" };
        } else {
            return { success: false, error: `Failed to upload shareable image: ${uploadResult.error || 'Unknown cloud error'}` };
        }
    } catch (error) {
        logger.error('PacketProcessor:publishImageForSharing', 'Error publishing image', { imageId, error });
        return { success: false, error: error.message || "Unknown error during image sharing." };
    }
}

export async function importImageFromUrl(url) {
    if (!url) return { success: false, error: "URL is required for import." };

    const imageId = `img_${Date.now()}_imported_${Math.random().toString(36).substring(2, 9)}`;

    try {
        sendStencilProgressNotification(imageId, 'init', 'active', 'Downloading...', 10, 'Importing Packet...');

        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Failed to download packet from URL (${response.status})`);
        const sharedImage = await response.json();

        if (!sharedImage || !sharedImage.topic || !Array.isArray(sharedImage.sourceContent)) {
            throw new Error("Invalid packet image format in downloaded JSON.");
        }
        
        const importedPacketImage = { ...sharedImage, id: imageId, created: new Date().toISOString(), shareUrl: url };
        
        // --- FIX START: Process imported media and save to IndexedDB ---
        for (const contentItem of importedPacketImage.sourceContent) {
            let itemsToProcess = [];
             if (contentItem.type === 'media') {
                itemsToProcess.push(contentItem);
            } else if (contentItem.type === 'alternative' && Array.isArray(contentItem.alternatives)) {
                itemsToProcess.push(...contentItem.alternatives.filter(alt => alt.type === 'media'));
            }

            for (const mediaItem of itemsToProcess) {
                if (mediaItem.contentB64) {
                    const audioBuffer = base64Decode(mediaItem.contentB64);
                    if (audioBuffer) {
                        await indexedDbStorage.saveGeneratedContent(imageId, mediaItem.pageId, [{
                            name: 'audio.mp3',
                            content: audioBuffer,
                            contentType: mediaItem.mimeType
                        }]);
                    }
                    delete mediaItem.contentB64; // Clean up after saving to DB
                }
            }
        }
        // --- FIX END ---

        await storage.savePacketImage(importedPacketImage);
        logger.log('PacketProcessor:importImageFromUrl', 'Packet image imported and saved.', { newImageId: imageId, originalUrl: url });
        
        sendStencilProgressNotification(imageId, 'complete', 'completed', 'Ready in Library', 100);
        sendProgressNotification('packet_image_created', { image: importedPacketImage });

        return { success: true, imageId: imageId };

    } catch (error) {
        logger.error('PacketProcessor:importImageFromUrl', 'Error importing image', { url, error });
        sendProgressNotification('packet_creation_failed', { imageId: imageId, error: error.message, step: 'import_failure' });
        return { success: false, error: error.message };
    }
}

export async function processRepublishRequest(data, initiatorTabId = null) {
    const { instanceId, pageId } = data;
    if (!instanceId || !pageId) return { success: false, error: "Instance ID and Page ID are required." };

    logger.log('PacketProcessor:processRepublishRequest', `Republishing ${pageId} for instance ${instanceId}`);
    sendProgressNotification('packet_instance_updated', { instance: { instanceId, status: 'republishing_page', pageId }});


    try {
        const instance = await storage.getPacketInstance(instanceId);
        if (!instance) throw new Error(`Instance ${instanceId} not found.`);
        if (!instance.imageId) throw new Error(`Image ID missing from instance ${instanceId}.`);

        const packetImage = await storage.getPacketImage(instance.imageId);
        if (!packetImage) throw new Error(`Packet Image ${instance.imageId} not found.`);

        const sourceContentItem = packetImage.sourceContent.find(item => item.type === 'generated' && item.pageId === pageId);
        if (!sourceContentItem) throw new Error(`Generated item ${pageId} not found in packet image.`);
        
        if (!sourceContentItem.contentB64) {
            throw new Error(`Cannot republish: Base64 content for ${pageId} not found in PacketImage.`);
        }

        const decodedContent = base64Decode(sourceContentItem.contentB64);
        const filesToUpload = [{ name: 'index.html', content: new TextDecoder().decode(decodedContent), contentType: sourceContentItem.contentType || 'text/html' }];

        if (!(await cloudStorage.initialize())) {
             throw new Error("Cloud storage not initialized. Cannot republish.");
        }

        const uploadResult = await cloudStorage.uploadPacketFiles(instanceId, pageId, filesToUpload, 'private');
        if (!uploadResult || !uploadResult.success) {
            throw new Error(uploadResult.error || `Failed to republish ${pageId} to cloud.`);
        }

        const mainHtmlFileResult = uploadResult.files?.find(f => f.fileName && f.fileName.endsWith('index.html'));
        const newS3Key = mainHtmlFileResult?.fileName || `packets/${instanceId}/${pageId}/index.html`;

        let itemUpdated = false;
        instance.contents = instance.contents.map(item => {
            if (item.pageId === pageId && item.type === 'generated') {
                item.url = newS3Key;
                item.published = true;
                itemUpdated = true;
            }
            return item;
        });

        if (!itemUpdated) {
             logger.warn('PacketProcessor:republish', `Generated item ${pageId} not found in instance ${instanceId} contents during update.`);
        }

        delete instance.status;
        await storage.savePacketInstance(instance);
        await ruleManager.addOrUpdatePacketRules(instance);

        logger.log('PacketProcessor:republish', `${pageId} republished for instance ${instanceId}. New URL: ${newS3Key}`);
        sendProgressNotification('packet_instance_updated', { instance: instance, source: 'republish_complete' });
        return { success: true, instance: instance, message: `${sourceContentItem.title} republished.` };

    } catch (error) {
        logger.error('PacketProcessor:republish', `Error republishing ${pageId} for ${instanceId}`, error);
        const instanceWithError = await storage.getPacketInstance(instanceId);
        if (instanceWithError) {
            delete instanceWithError.status;
            sendProgressNotification('packet_instance_updated', { instance: instanceWithError, source: 'republish_failed' });
        }
        return { success: false, error: error.message };
    }
}

export async function processDeletePacketImageRequest(data) {
    const { imageId } = data;
    if (!imageId) {
        return { success: false, error: "Image ID is required for deletion." };
    }
    logger.log('PacketProcessor:processDeletePacketImage', 'Processing delete request for image:', imageId);
    let errors = [];

    try {
        await storage.deletePacketImage(imageId);
        logger.log('PacketProcessor:deleteImage', `Deleted PacketImage: ${imageId}`);
    } catch (error) {
        logger.error('PacketProcessor:deleteImage', `Error deleting packet image ${imageId}`, error);
        errors.push(error.message);
    }

    try {
        await indexedDbStorage.deleteGeneratedContentForImage(imageId);
        logger.log('PacketProcessor:deleteImage', `Deleted IndexedDB content for: ${imageId}`);
    } catch (error) {
        logger.error('PacketProcessor:deleteImage', `Error deleting IDB content for image ${imageId}`, error);
        errors.push(error.message);
    }
    
    // Notify the UI that the image has been removed
    sendProgressNotification('packet_image_deleted', { imageId: imageId });
    
    return {
        success: errors.length === 0,
        errors: errors
    };
}

export async function processDeletePacketsRequest(data, initiatorTabId = null) {
    const { packetIds } = data;
    if (!Array.isArray(packetIds) || packetIds.length === 0) {
        return { success: false, error: "No packet IDs provided for deletion." };
    }
    logger.log('PacketProcessor:processDeletePacketsRequest', 'Processing delete request for packets:', packetIds);
    let deletedCount = 0;
    let errors = [];

    for (const instanceId of packetIds) {
        try {
            const instance = await storage.getPacketInstance(instanceId);
            if (!instance) {
                logger.warn('PacketProcessor:delete', `Packet instance ${instanceId} not found for deletion.`);
                await storage.deletePacketBrowserState(instanceId).catch(e => logger.warn('PacketProcessor:delete', `Error deleting orphaned browser state for ${instanceId}`, e));
                await ruleManager.removePacketRules(instanceId);
                continue;
            }

            const imageId = instance.imageId;
            const browserState = await storage.getPacketBrowserState(instanceId);

            if (browserState?.tabGroupId) {
                logger.log('PacketProcessor:delete', `Packet ${instanceId} has tab group ${browserState.tabGroupId}. Requesting removal.`);
                await tabGroupHandler.handleRemoveTabGroups({ groupIds: [browserState.tabGroupId] }, () => {});
            } else if (browserState) {
                await storage.deletePacketBrowserState(instanceId);
            }
            
            for (const item of instance.contents) {
                if (item.type === 'media' && item.pageId) {
                    const sessionKey = `audio_progress_${instanceId}_${item.pageId}`;
                    await storage.removeSession(sessionKey);
                }
            }

            if (await cloudStorage.initialize()) {
                for (const item of instance.contents) {
                    if (item.type === 'generated' && item.pageId && item.url) {
                        await cloudStorage.deletePacketFiles(instanceId, item.pageId)
                            .catch(e => logger.warn('PacketProcessor:delete', `Error deleting cloud files for ${instanceId}/${item.pageId}`, e));
                    }
                }
            } else {
                logger.warn('PacketProcessor:delete', `Cloud storage not initialized, cannot delete cloud files for instance ${instanceId}.`);
            }
            
            await storage.deletePacketInstance(instanceId);
            logger.log('PacketProcessor:delete', `Deleted PacketInstance: ${instanceId}`);

            await ruleManager.removePacketRules(instanceId);
            logger.log('PacketProcessor:delete', `Removed redirect rules for: ${instanceId}`);

            sendProgressNotification('packet_instance_deleted', { packetId: instanceId, source: 'user_action' });

            // if (imageId) {
            //     const remainingInstances = await storage.getInstanceCountForImage(imageId);
            //     if (remainingInstances === 0) {
            //         logger.log('PacketProcessor:delete', `No other instances use image ${imageId}. Deleting image and its IDB content.`);
            //         await storage.deletePacketImage(imageId).catch(e => logger.warn('PacketProcessor:delete', `Error deleting packet image ${imageId}`, e));
            //         await indexedDbStorage.deleteGeneratedContentForImage(imageId).catch(e => logger.warn('PacketProcessor:delete', `Error deleting IDB content for image ${imageId}`, e));
            //     } else {
            //         logger.log('PacketProcessor:delete', `${remainingInstances} other instances still use image ${imageId}. Image and IDB content retained.`);
            //     }
            // }
            deletedCount++;
        } catch (error) {
            logger.error('PacketProcessor:delete', `Error deleting packet ${instanceId}`, error);
            errors.push({ instanceId, error: error.message });
        }
    }

    const result = {
        success: errors.length === 0,
        deletedCount: deletedCount,
        totalRequested: packetIds.length,
        errors: errors,
        message: errors.length > 0 ? `${deletedCount} deleted, ${errors.length} failed.` : `${deletedCount} packet(s) deleted successfully.`
    };
    sendProgressNotification('packet_deletion_complete', result);
    return result;
}