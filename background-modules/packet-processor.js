// ext/background-modules/packet-processor.js

import {
    logger,
    storage,
    indexedDbStorage,
    shouldUseTabGroups,
    CONFIG,
    arrayBufferToBase64,
    base64Decode,
    MPI_PARAMS,
    sanitizeForFileName,
    packetUtils
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
            reasons: ['DOM_PARSER', 'BLOBS'],
            justification: 'Parse HTML and process audio blob data.',
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

export async function generateDraftPacketFromTab(initiatorTabId) {
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
            relevance: 'The original source page this packet was created from.'
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
            throw new Error("Could not retrieve page content.");
        }
        const plainTextForTopic = await getAndParseHtml(injectionResults[0].result);

        const llmAnalysis = await llmService.callLLM('extract_topic_from_html', { htmlContent: plainTextForTopic });
        if (!llmAnalysis.success || !llmAnalysis.data?.topic) {
            throw new Error(llmAnalysis.error || 'LLM failed to analyze page content.');
        }
        analysisResult = llmAnalysis.data;
        const topic = analysisResult.topic;

        const externalContentResponse = await llmService.callLLM('article_suggestions', { topic: topic, contentSummary: analysisResult.contentSummary });
        
        let validatedExternalLinks = externalContentResponse.success ? (externalContentResponse.data.contents || [])
            .filter(item => item?.url?.startsWith('https://en.wikipedia.org/wiki/') && item.title && item.relevance)
            .map(item => ({
                origin: 'external',
                format: 'html',
                access: 'public',
                url: decodeURIComponent(item.url),
                title: item.title,
                relevance: item.relevance
            })) : [];

        const summaryPageDef = {
            origin: 'internal',
            format: 'html',
            access: 'private',
            lrl: `/pages/summary.html`, // The permanent local resource locator
            url: null, // URL is null until published
            title: `${topic} Summary`,
            contentType: "text/html"
        };
        let audioMediaItem = null;
        let moments = [];

        const allContentForSummary = [...validatedExternalLinks, sourcePageContentItem];
        const summaryContext = { topic: topic, allPacketContents: allContentForSummary };
        
        const summaryResponse = await llmService.callLLM('summary_page', summaryContext);
        if (!summaryResponse.success || !summaryResponse.data) throw new Error(summaryResponse.error || 'LLM failed to generate summary.');
        
        const summaryHtmlBodyLLM = String(summaryResponse.data).trim();
        const plainTextForTTS = await getAndParseHtml(summaryHtmlBodyLLM, false);
        const ttsResponse = await ttsService.generateAudio(plainTextForTTS);
        
        const draftId = `draft_${Date.now()}`; 
        const links = await getLinksFromHtml(summaryHtmlBodyLLM);

        if (ttsResponse.success && ttsResponse.audioBlob) {
            const normalizedAudioBlob = await normalizeAudioOffscreen(ttsResponse.audioBlob);
            const audioBuffer = await normalizedAudioBlob.arrayBuffer();
            audioMediaItem = {
                origin: 'internal',
                format: 'audio',
                access: 'private',
                lrl: `/media/audio_summary_${Date.now()}.wav`,
                url: null,
                title: summaryPageDef.title,
                mimeType: 'audio/wav',
                published: false 
            };
            
            const alignmentResponse = await ttsService.getAlignmentForExistingAudio(audioBuffer, plainTextForTTS);
            
            if (alignmentResponse.success && alignmentResponse.wordTimestamps && links.length > 0) {
                const sourceOfTruthText = await getAndParseHtml(summaryHtmlBodyLLM, true);
                const totalAudioDuration = alignmentResponse.wordTimestamps[alignmentResponse.wordTimestamps.length - 1]?.end || 0;

                links.forEach(link => {
                    const markedLinkText = `*${link.text}*`;
                    const charIndex = sourceOfTruthText.indexOf(markedLinkText);
                    const linkedItem = validatedExternalLinks.find(ext => ext.url === link.href);

                    if (charIndex !== -1 && linkedItem) {
                        const proportionalPosition = charIndex / sourceOfTruthText.length;
                        const startTime = proportionalPosition * totalAudioDuration;
                        
                        const momentIndex = moments.length;
                        moments.push({
                            id: `moment_${momentIndex}`,
                            type: "mediaTimestamp",
                            sourceUrl: audioMediaItem.lrl,
                            timestamp: parseFloat(startTime.toFixed(2))
                        });
                        linkedItem.revealedByMoment = momentIndex;
                    }
                });
            }
            const indexedDbKey = sanitizeForFileName(audioMediaItem.lrl);
            await indexedDbStorage.saveGeneratedContent(draftId, indexedDbKey, [{ name: 'audio.wav', content: audioBuffer, contentType: 'audio/wav' }]);
        } else if (links.length > 0) {
            links.forEach(link => {
                const linkedItem = validatedExternalLinks.find(ext => ext.url === link.href);
                if (linkedItem) {
                    const momentIndex = moments.length;
                    moments.push({
                        id: `moment_${momentIndex}`,
                        type: "visit",
                        sourceUrl: summaryPageDef.lrl
                    });
                    linkedItem.revealedByMoment = momentIndex;
                }
            });
        }

        summaryPageDef.contentB64 = arrayBufferToBase64(new TextEncoder().encode(enhanceHtml(summaryHtmlBodyLLM, topic, summaryPageDef.title)));
        
        const finalSourceContent = [summaryPageDef];
        if (audioMediaItem) finalSourceContent.push(audioMediaItem);
        finalSourceContent.push(...validatedExternalLinks, sourcePageContentItem);
        
        const draftPacket = {
            id: draftId,
            topic: topic,
            sourceContent: finalSourceContent,
            moments: moments
        };

        return { success: true, draft: draftPacket };

    } catch (error) {
        logger.error('PacketProcessor:generateDraftFromTab', `Error creating draft from tab ${initiatorTabId}`, error);
        return { success: false, error: error.message };
    }
}

// --- Audio Post-Processing function using offscreen document ---
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
            logger.error('PacketProcessor:normalizeAudioOffscreen', 'Offscreen normalization failed.', response?.error);
            return audioBlob; // Fallback to original
        }
    } catch (error) {
        logger.error('PacketProcessor:normalizeAudioOffscreen', 'Error sending audio to offscreen doc', error);
        return audioBlob; // Fallback to original
    }
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
export async function instantiatePacket(imageId, preGeneratedInstanceId, initiatorTabId = null) {
    const instanceId = preGeneratedInstanceId;
    logger.log('PacketProcessor:instantiatePacket', 'Starting INSTANCE finalization', { imageId, instanceId });

    try {
        let packetImage = await storage.getPacketImage(imageId);
        if (!packetImage) throw new Error(`Packet Image ${imageId} not found.`);

        const hasInternalContent = packetImage.sourceContent.some(item => item.origin === 'internal');
        let activeCloudConfig = null;

        if (hasInternalContent) {
            logger.log('PacketProcessor:instantiatePacket', 'Packet contains internal content, checking cloud storage...');
            activeCloudConfig = await storage.getActiveCloudStorageConfig();
            if (!activeCloudConfig) {
                throw new Error("This packet contains internal content, but no active cloud storage is configured for publishing.");
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
            contents: JSON.parse(JSON.stringify(packetImage.sourceContent)),
            visitedUrls: [],
            momentsTripped: packetImage.moments ? Array(packetImage.moments.length).fill(0) : [],
        };
        
        if (Array.isArray(packetImage.checkpoints)) {
            packetInstance.checkpointsTripped = Array(packetImage.checkpoints.length).fill(0);
        }
        
        const imageContentMap = new Map(packetImage.sourceContent.map(item => [item.lrl, item]));

        for (let i = 0; i < packetInstance.contents.length; i++) {
            const item = packetInstance.contents[i];
            if (item.origin === 'internal') {
                const lrl = item.lrl;
                if (!lrl) {
                    logger.warn('PacketProcessor:instantiate', 'Skipping internal item with no LRL.', item);
                    continue;
                }
                const cloudPath = `packets/${instanceId}${lrl.startsWith('/') ? lrl : '/' + lrl}`;
                
                let contentToUpload;
                let contentType;
                const originalImageItem = imageContentMap.get(lrl);

                if (!originalImageItem) {
                     logger.warn('PacketProcessor:instantiate', `Could not find original image item for LRL ${lrl}. Skipping publish.`);
                     item.published = false;
                     item.url = null;
                     continue;
                }

                if (item.format === 'html') {
                    if (!originalImageItem.contentB64) {
                        logger.warn('PacketProcessor:instantiate', `Internal item ${lrl} is missing Base64 content. Cannot publish.`);
                        item.published = false;
                        item.url = null;
                        continue;
                    }
                    contentToUpload = new TextDecoder().decode(base64Decode(originalImageItem.contentB64));
                    contentType = originalImageItem.contentType;
                    delete item.contentB64;

                } else if (item.format === 'audio') {
                    item.currentTime = 0;
                    item.duration = 0;
                    const indexedDbKey = sanitizeForFileName(originalImageItem.lrl); 
                    const cachedContent = await indexedDbStorage.getGeneratedContent(imageId, indexedDbKey);
                    if (!cachedContent || cachedContent.length === 0) {
                         logger.warn('PacketProcessor:instantiate', `Media item ${lrl} is missing from IndexedDB. Cannot publish.`);
                        item.published = false;
                        item.url = null;
                        continue;
                    }
                    contentToUpload = cachedContent[0].content;
                    contentType = item.mimeType;
                }

                const uploadResult = await cloudStorage.uploadFile(cloudPath, contentToUpload, contentType, 'private');
                
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
                    item.published = false;
                    item.url = null;
                    throw new Error(`Failed to publish ${lrl}: ${uploadResult.error}`);
                }
            }
        }

        if (!(await storage.savePacketInstance(packetInstance))) {
            throw new Error("Failed to save final Packet Instance.");
        }
        
        await storage.savePacketBrowserState({ instanceId: instanceId, tabGroupId: null, activeTabIds: [], lastActiveUrl: null });
        
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
                if (item.format === 'audio' && item.url) {
                    const sessionKey = `audio_progress_${instanceId}_${sanitizeForFileName(item.url)}`;
                    await storage.removeSession(sessionKey);
                }
            }

            if (await cloudStorage.initialize()) {
                for (const item of instance.contents) {
                    if (item.origin === 'internal' && item.published && item.url) {
                        await cloudStorage.deleteFile(item.url)
                            .catch(e => logger.warn('PacketProcessor:delete', `Error deleting cloud file ${item.url}`, e));
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
        
        for (const contentItem of importedPacketImage.sourceContent) {
            if (contentItem.format === 'audio' && contentItem.contentB64) {
                const audioBuffer = base64Decode(contentItem.contentB64);
                if (audioBuffer) {
                    const indexedDbKey = sanitizeForFileName(contentItem.lrl);
                    await indexedDbStorage.saveGeneratedContent(imageId, indexedDbKey, [{
                        name: 'audio.wav',
                        content: audioBuffer,
                        contentType: contentItem.mimeType
                    }]);
                }
                delete contentItem.contentB64;
            }
        }

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

export async function processCreatePacketRequest(data, initiatorTabId) {
    const { topic } = data;
    if (!topic) { return { success: false, error: "Topic is required." }; }

    const imageId = `img_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    logger.log('PacketProcessor:processCreatePacketRequest', 'Starting image creation for topic:', { topic, imageId });

    try {
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
            .map(item => ({
                origin: 'external',
                format: 'html',
                access: 'public',
                url: decodeURIComponent(item.url),
                title: item.title,
                relevance: item.relevance
            }));
        if (validatedExternalLinks.length === 0) {
            throw new Error(`LLM returned no valid Wikipedia articles for "${topic}". Please try a more specific topic.`);
        }
        sendStencilProgressNotification(imageId, 'articles', 'completed', `Found ${validatedExternalLinks.length} articles`, 30);
        
        const summaryPageDef = {
            origin: 'internal',
            format: 'html',
            access: 'private',
            lrl: "/pages/summary.html",
            url: null,
            title: `${topic} Summary`,
            contentType: "text/html"
        };

        sendStencilProgressNotification(imageId, 'generate_summary', 'active', 'Generating summary...', 40);
        const summaryResponse = await llmService.callLLM('summary_page', { topic: topic, allPacketContents: validatedExternalLinks });
        if (!summaryResponse.success || !summaryResponse.data) throw new Error(summaryResponse.error || 'LLM failed to generate summary.');
        const summaryHtmlBodyLLM = String(summaryResponse.data).trim();
        const finalSummaryHtml = enhanceHtml(summaryHtmlBodyLLM, topic, summaryPageDef.title);
        summaryPageDef.contentB64 = arrayBufferToBase64(new TextEncoder().encode(finalSummaryHtml));
        sendStencilProgressNotification(imageId, 'generate_summary', 'completed', 'Summary generated', 60);

        const finalSourceContent = [
            summaryPageDef,
            ...validatedExternalLinks,
        ];

        const packetImage = {
            id: imageId,
            topic: topic,
            created: new Date().toISOString(),
            sourceContent: finalSourceContent,
            moments: [] // No moments for text-only packets
        };
        await storage.savePacketImage(packetImage);
        logger.log('PacketProcessor', 'Packet Image with embedded Base64 content saved successfully', { imageId });
        sendStencilProgressNotification(imageId, 'local_save_final', 'completed', 'Packet ready in Library', 100);

        sendProgressNotification('packet_image_created', { image: packetImage });

        return { success: true, imageId: imageId };

    } catch (error) {
        logger.error('PacketProcessor:processCreatePacketRequest', `Error creating packet image for topic ${topic}`, error);
        sendProgressNotification('packet_creation_failed', { imageId: imageId, error: error.message });
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
            relevance: 'The original source page this packet was created from.'
        };

        sendStencilProgressNotification(imageId, 'init', 'active', 'Analyzing page...', 5, 'Analyzing Page...');

        const activeModelConfig = await storage.getActiveModelConfig();
        const cloudStorageEnabled = await storage.isCloudStorageEnabled();
        if (!activeModelConfig || !cloudStorageEnabled || !(await cloudStorage.initialize())) {
            throw new Error('LLM and Cloud Storage must be fully configured in Settings.');
        }

        const injectionResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => document.documentElement.outerHTML,
        });

        if (!injectionResults || injectionResults.length === 0 || !injectionResults[0].result) {
            throw new Error("Could not retrieve page content. The page may be protected.");
        }
        const plainTextForTopic = await getAndParseHtml(injectionResults[0].result);

        sendStencilProgressNotification(imageId, 'analyze', 'active', 'Extracting topic...', 10);
        const llmAnalysis = await llmService.callLLM('extract_topic_from_html', { htmlContent: plainTextForTopic });
        if (!llmAnalysis.success || !llmAnalysis.data?.topic) {
            throw new Error(llmAnalysis.error || 'LLM failed to analyze page content.');
        }
        analysisResult = llmAnalysis.data;
        const topic = analysisResult.topic;
        logger.log('PacketProcessor:FromTab', 'LLM analysis complete', { topic });
        sendStencilProgressNotification(imageId, 'analyze', 'completed', 'Topic identified', 20, topic);

        sendStencilProgressNotification(imageId, 'articles', 'active', 'Finding articles...', 25, topic);
        const externalContentResponse = await llmService.callLLM('article_suggestions', { topic: topic, contentSummary: analysisResult.contentSummary });
        
        let validatedExternalLinks = externalContentResponse.success ? (externalContentResponse.data.contents || [])
            .filter(item => item?.url?.startsWith('https://en.wikipedia.org/wiki/') && item.title && item.relevance)
            .map(item => ({
                origin: 'external',
                format: 'html',
                access: 'public',
                url: decodeURIComponent(item.url),
                title: item.title,
                relevance: item.relevance
            })) : [];

        if (validatedExternalLinks.length === 0) {
            logger.warn('PacketProcessor:FromTab', `LLM returned no valid Wikipedia articles for "${topic}". Packet will be created without them.`);
        }
        sendStencilProgressNotification(imageId, 'articles', 'completed', `Found ${validatedExternalLinks.length} articles`, 40, topic);

        const summaryPageDef = {
            origin: 'internal',
            format: 'html',
            access: 'private',
            lrl: `/pages/summary.html`,
            url: null,
            title: `${topic} Summary`,
            contentType: "text/html"
        };
        let audioMediaItem = null;
        let moments = [];

        sendStencilProgressNotification(imageId, 'generate_summary', 'active', 'Generating summary...', 50, topic);

        const allContentForSummary = [...validatedExternalLinks, sourcePageContentItem];
        const summaryContext = { topic: topic, allPacketContents: allContentForSummary };
        
        const summaryResponse = await llmService.callLLM('summary_page', summaryContext);

        if (!summaryResponse.success || !summaryResponse.data) throw new Error(summaryResponse.error || 'LLM failed to generate summary.');
        const summaryHtmlBodyLLM = String(summaryResponse.data).trim();
        
        const plainTextForTTS = await getAndParseHtml(summaryHtmlBodyLLM, false);
        const ttsResponse = await ttsService.generateAudio(plainTextForTTS);

        if (ttsResponse.success && ttsResponse.audioBlob) {
            const normalizedAudioBlob = await normalizeAudioOffscreen(ttsResponse.audioBlob);
            const audioBuffer = await normalizedAudioBlob.arrayBuffer();
            audioMediaItem = {
                origin: 'internal',
                format: 'audio',
                access: 'private',
                lrl: `/media/audio_summary_${Date.now()}.wav`,
                url: null,
                title: summaryPageDef.title,
                mimeType: 'audio/wav'
            };

            const links = await getLinksFromHtml(summaryHtmlBodyLLM);
            const alignmentResponse = await ttsService.getAlignmentForExistingAudio(audioBuffer, plainTextForTTS);
            
            if (alignmentResponse.success && alignmentResponse.wordTimestamps && links.length > 0) {
                const sourceOfTruthText = await getAndParseHtml(summaryHtmlBodyLLM, true);
                const totalAudioDuration = alignmentResponse.wordTimestamps[alignmentResponse.wordTimestamps.length - 1]?.end || 0;

                links.forEach(link => {
                    const markedLinkText = `*${link.text}*`;
                    const charIndex = sourceOfTruthText.indexOf(markedLinkText);
                    const linkedItem = validatedExternalLinks.find(ext => ext.url === link.href);

                    if (charIndex !== -1 && linkedItem) {
                        const proportionalPosition = charIndex / sourceOfTruthText.length;
                        const startTime = proportionalPosition * totalAudioDuration;
                        
                        const momentIndex = moments.length;
                        moments.push({
                            id: `moment_${momentIndex}`,
                            type: "mediaTimestamp",
                            sourceUrl: audioMediaItem.lrl,
                            timestamp: parseFloat(startTime.toFixed(2))
                        });
                        linkedItem.revealedByMoment = momentIndex;
                    }
                });
            }
            const indexedDbKey = sanitizeForFileName(audioMediaItem.lrl);
            await indexedDbStorage.saveGeneratedContent(imageId, indexedDbKey, [{ name: 'audio.wav', content: audioBuffer, contentType: 'audio/wav' }]);
            logger.log('PacketProcessor:FromTab', 'Successfully created media item for TTS audio and saved to IndexedDB.');
        } else {
            logger.warn('PacketProcessor:FromTab', 'Failed to generate audio from TTS service.', ttsResponse?.error);
        }

        summaryPageDef.contentB64 = arrayBufferToBase64(new TextEncoder().encode(enhanceHtml(summaryHtmlBodyLLM, topic, summaryPageDef.title)));
        sendStencilProgressNotification(imageId, 'generate_summary', 'completed', 'Summary generated', 70, topic);

        const finalSourceContent = [summaryPageDef];
        if (audioMediaItem) finalSourceContent.push(audioMediaItem);
        finalSourceContent.push(...validatedExternalLinks, sourcePageContentItem);
        
        const packetImage = { 
            id: imageId, 
            topic, 
            created: new Date().toISOString(), 
            sourceContent: finalSourceContent,
            moments: moments
        };
        
        await storage.savePacketImage(packetImage);
        logger.log('PacketProcessor:FromTab', 'Packet Image saved successfully', { imageId });
        sendStencilProgressNotification(imageId, 'local_save_final', 'completed', 'Packet ready in Library', 100, topic);

        sendProgressNotification('packet_image_created', { image: packetImage });
        return { success: true, imageId: imageId };

    } catch (error) {
        logger.error('PacketProcessor:processCreatePacketRequestFromTab', `Error creating packet from tab ${initiatorTabId}`, error);
        sendProgressNotification('packet_creation_failed', { imageId: imageId, error: error.message, topic: analysisResult?.topic });
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
    
    sendProgressNotification('packet_image_deleted', { imageId: imageId });
    
    return {
        success: errors.length === 0,
        errors: errors
    };
}

export async function processRepublishRequest(data, initiatorTabId = null) {
    const { instanceId, url } = data;
    if (!instanceId || !url) return { success: false, error: "Instance ID and URL are required." };

    logger.log('PacketProcessor:processRepublishRequest', `Republishing ${url} for instance ${instanceId}`);
    sendProgressNotification('packet_instance_updated', { instance: { instanceId, status: 'republishing_page', url }});


    try {
        const instance = await storage.getPacketInstance(instanceId);
        if (!instance) throw new Error(`Instance ${instanceId} not found.`);
        if (!instance.imageId) throw new Error(`Image ID missing from instance ${instanceId}.`);

        const packetImage = await storage.getPacketImage(instance.imageId);
        if (!packetImage) throw new Error(`Packet Image ${instance.imageId} not found.`);

        const sourceContentItem = packetImage.sourceContent.find(item => item.lrl === url);
        if (!sourceContentItem) throw new Error(`Internal item with LRL ${url} not found in packet image.`);
        
        if (!sourceContentItem.contentB64) {
            throw new Error(`Cannot republish: Base64 content for ${url} not found in PacketImage.`);
        }

        const decodedContent = new TextDecoder().decode(base64Decode(sourceContentItem.contentB64));
        
        if (!(await cloudStorage.initialize())) {
             throw new Error("Cloud storage not initialized. Cannot republish.");
        }

        const instanceItem = instance.contents.find(item => item.lrl === url);
        if (!instanceItem) throw new Error(`Could not find published item in instance for LRL ${url}`);

        const cloudPath = instanceItem.url;
        const contentType = sourceContentItem.contentType || 'text/html';

        const uploadResult = await cloudStorage.uploadFile(cloudPath, decodedContent, contentType, 'private');
        if (!uploadResult || !uploadResult.success) {
            throw new Error(uploadResult.error || `Failed to republish ${cloudPath} to cloud.`);
        }
        
        delete instance.status;
        await storage.savePacketInstance(instance);
        await ruleManager.addOrUpdatePacketRules(instance);

        logger.log('PacketProcessor:republish', `${url} republished for instance ${instanceId}.`);
        sendProgressNotification('packet_instance_updated', { instance: instance, source: 'republish_complete' });
        return { success: true, instance: instance, message: `${sourceContentItem.title} republished.` };

    } catch (error) {
        logger.error('PacketProcessor:republish', `Error republishing ${url} for ${instanceId}`, error);
        const instanceWithError = await storage.getPacketInstance(instanceId);
        if (instanceWithError) {
            delete instanceWithError.status;
            sendProgressNotification('packet_instance_updated', { instance: instanceWithError, source: 'republish_failed' });
        }
        return { success: false, error: error.message };
    }
}

export async function processGenerateCustomPageRequest(data) {
    const { prompt, context } = data;
    if (!prompt) {
        return { success: false, error: 'A prompt is required.' };
    }

    try {
        logger.log("PacketProcessor:CustomPage", "Starting initial page generation.");
        const generationResult = await llmService.callLLM('custom_page', { prompt, context });
        if (!generationResult.success || !generationResult.data) {
            throw new Error(generationResult.error || "LLM service failed to generate page.");
        }
        const initialHtml = generationResult.data;
        logger.log("PacketProcessor:CustomPage", "Initial page generated. Starting modification pass.");

        const modificationResult = await llmService.callLLM('modify_html_for_completion', { htmlContent: initialHtml });
        if (!modificationResult.success || !modificationResult.data) {
            logger.warn("PacketProcessor:CustomPage", "Modification pass failed. Using initial HTML.", modificationResult.error);
        }
        const finalHtml = modificationResult.data || initialHtml;
        
        const contentB64 = arrayBufferToBase64(new TextEncoder().encode(finalHtml));
        const titleMatch = finalHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
        const pageTitle = titleMatch ? titleMatch[1] : (prompt.substring(0, 50) + (prompt.length > 50 ? '...' : ''));

        const isInteractive = finalHtml.includes("notifyExtensionOnCompletion()");

        const newContentItem = {
            origin: 'internal',
            format: 'html',
            access: 'private',
            lrl: `/pages/custom_${sanitizeForFileName(pageTitle)}_${Date.now()}.html`,
            url: null,
            title: pageTitle,
            contentType: 'text/html',
            contentB64: contentB64,
            interactionBasedCompletion: isInteractive
        };

        logger.log("PacketProcessor:CustomPage", "Custom page processing complete.", { pageTitle, isInteractive });
        return { success: true, newItem: newContentItem };

    } catch (error) {
        logger.error("PacketProcessor:CustomPage", "Error generating custom page", error);
        return { success: false, error: error.message };
    }
}

export async function processImproveDraftAudio(data) {
    const { draftId, mediaUrl } = data;
    if (!draftId || !mediaUrl) {
        return { success: false, error: "Missing draftId or mediaUrl for audio improvement." };
    }

    try {
        const indexedDbKey = sanitizeForFileName(mediaUrl);
        const audioContent = await indexedDbStorage.getGeneratedContent(draftId, indexedDbKey);
        if (!audioContent || audioContent.length === 0) {
            throw new Error(`Audio content not found in IndexedDB for url: ${mediaUrl}`);
        }
        
        const originalBlob = new Blob([audioContent[0].content], { type: audioContent[0].contentType });
        const normalizedBlob = await normalizeAudioOffscreen(originalBlob);
        
        const updatedBuffer = await normalizedBlob.arrayBuffer();

        await indexedDbStorage.saveGeneratedContent(draftId, indexedDbKey, [{
            name: 'audio.wav',
            content: updatedBuffer,
            contentType: 'audio/wav'
        }]);

        logger.log("PacketProcessor:processImproveDraftAudio", "Successfully improved and saved audio.", { draftId, mediaUrl });
        return { success: true };

    } catch (error) {
        logger.error("PacketProcessor:processImproveDraftAudio", "Error during audio improvement", error);
        return { success: false, error: error.message };
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
        
        const imageForExport = JSON.parse(JSON.stringify(packetImage));

        for (const contentItem of imageForExport.sourceContent) {
            if (contentItem.format === 'audio') {
                const indexedDbKey = sanitizeForFileName(contentItem.lrl);
                const mediaContent = await indexedDbStorage.getGeneratedContent(imageId, indexedDbKey);
                if (mediaContent && mediaContent[0] && mediaContent[0].content) {
                    contentItem.contentB64 = arrayBufferToBase64(mediaContent[0].content);
                }
            }
        }

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