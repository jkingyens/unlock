// ext/background-modules/message-handlers.js
// REVISED: Implements 'debug_run_remote_agent' with Component Model interface (imports/run).
// REVISED: 'perform_llm_check' uses Chrome's built-in AI with v140+ compatible options.
// REVISED: Local 'ensureOffscreenDocument' prevents circular dependency issues.
// REVISED: Robust Regex for patching WASM paths in JCO bundles.

import {
    logger,
    storage,
    packetUtils,
    shouldUseTabGroups,
    shouldShowOverlay,
    setPacketContext,
    getPacketContext,
    clearPacketContext,
    CONFIG,
    arrayBufferToBase64,
    base64Decode,
    indexedDbStorage,
    sanitizeForFileName
} from '../utils.js';
import * as tabGroupHandler from './tab-group-handler.js';
import * as sidebarHandler from './sidebar-handler.js';
import cloudStorage from '../cloud-storage.js';
import llmService from '../llm_service.js';
import * as ruleManager from './rule-manager.js';
import PacketRuntime from './packet-runtime.js';

import {
    instantiatePacket,
    publishImageForSharing,
    importImageFromUrl,
    processDeletePacketImageRequest
} from './packet-processor.js';

import {
    generateDraftPacketFromTab,
    processCreatePacketRequestFromTab,
    processCreatePacketRequest,
    enhanceHtml
} from './create-utils.js';

// [FIX] Removed 'setupOffscreenDocument' from import to prevent circular dependency
import {
    setMediaPlaybackState,
    controlAudioInOffscreen,
    activeMediaPlayback,
    resetActiveMediaPlayback,
    notifyUIsOfStateChange,
    saveCurrentTime,
    stopAndClearActiveAudio,
    notifyOffscreenSidebarState,
    waitForRestoration
} from '../background.js';

import { checkAndPromptForCompletion, startVisitTimer } from './navigation-handler.js';

const PENDING_VIEW_KEY = 'pendingSidebarView';

// --- Local Offscreen Setup (Breaks Circular Dependency) ---
let creatingOffscreenDocument = null;
async function ensureOffscreenDocument() {
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
    });

    if (existingContexts.length > 0) {
        return;
    }

    if (creatingOffscreenDocument) {
        await creatingOffscreenDocument;
    } else {
        creatingOffscreenDocument = chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['DOM_PARSER', 'BLOBS', 'AUDIO_PLAYBACK', 'WORKERS'],
            justification: 'Parse HTML, process audio, and run sandboxed agents.',
        });
        await creatingOffscreenDocument;
        creatingOffscreenDocument = null;
    }
}

// --- Helper to Sync Global Media State ---
function syncGlobalMediaState(instance) {
    if (activeMediaPlayback && activeMediaPlayback.instanceId === instance.instanceId) {
        activeMediaPlayback.instance = instance;
    }
}

async function handleOpenContent(data, sender, sendResponse) {
    const { instance, url: clickedUrl } = data;
    if (!instance || !instance.instanceId || !clickedUrl) {
        return sendResponse({ success: false, error: 'Missing instance data or target URL' });
    }
    try {
        const urlToOpen = packetUtils.renderPacketUrl(clickedUrl, instance.variables);
        const runtime = new PacketRuntime(instance);
        const result = await runtime.openOrFocusContent(urlToOpen);
        sendResponse(result);
    } catch (error) {
        logger.error('MessageHandler:handleOpenContent', 'Error creating runtime or opening content', error);
        sendResponse({ success: false, error: error.message });
    }
}

async function processDeletePacketsRequest(data) {
    const { packetIds } = data;
    if (!Array.isArray(packetIds) || packetIds.length === 0) {
        return { success: false, error: "No packet IDs provided for deletion." };
    }
    logger.log('MessageHandler:delete', 'Processing delete request via runtime for packets:', packetIds);
    let deletedCount = 0;
    let errors = [];

    for (const instanceId of packetIds) {
        try {
            const instance = await storage.getPacketInstance(instanceId);
            if (!instance) {
                logger.warn('MessageHandler:delete', `Instance ${instanceId} not found, cleaning up any stale artifacts.`);
                await storage.deletePacketBrowserState(instanceId).catch(() => { });
                await ruleManager.removePacketRules(instanceId);
                continue;
            }

            const runtime = new PacketRuntime(instance);
            await runtime.delete();

            await storage.deletePacketInstance(instanceId);

            sidebarHandler.notifySidebar('packet_instance_deleted', { packetId: instanceId, source: 'user_action' });
            deletedCount++;
        } catch (error) {
            logger.error('MessageHandler:delete', `Error deleting packet ${instanceId}`, error);
            errors.push({ instanceId, error: error.message });
        }
    }

    const result = {
        success: errors.length === 0, deletedCount, totalRequested: packetIds.length, errors,
        message: errors.length > 0 ? `${deletedCount} deleted, ${errors.length} failed.` : `${deletedCount} packet(s) deleted successfully.`
    };

    sidebarHandler.notifySidebar('packet_deletion_complete', result);
    return result;
}

function sendProgressNotification(action, data) {
    sidebarHandler.notifySidebar(action, data);
}

function injectInterceptorScript(htmlContent) {
    if (!htmlContent || typeof htmlContent !== 'string') return '';
    const interceptorUrl = chrome.runtime.getURL('page_interceptor.js');
    const scriptTag = `<script src="${interceptorUrl}"></script>`;
    const bodyEndIndex = htmlContent.toLowerCase().lastIndexOf('</body>');
    if (bodyEndIndex !== -1) {
        return htmlContent.slice(0, bodyEndIndex) + scriptTag + htmlContent.slice(bodyEndIndex);
    }
    return htmlContent + scriptTag;
}

async function handleGetContextForTab(data, sender, sendResponse) {
    const { tabId } = data;
    if (typeof tabId !== 'number') {
        sendResponse({ success: false, error: 'Invalid tabId' });
        return;
    }
    try {
        const context = await getPacketContext(tabId);
        const instanceId = context?.instanceId || null;
        let instanceData = null;
        let tabData = null;

        try { tabData = await chrome.tabs.get(tabId); } catch (tabError) { /* ignore */ }

        if (instanceId) {
            try {
                instanceData = await storage.getPacketInstance(instanceId);
                if (!instanceData) {
                    await clearPacketContext(tabId);
                }
            } catch (instanceError) {
                await clearPacketContext(tabId);
            }
        }

        const responseData = {
            success: true, tabId: tabId, instanceId: instanceData ? instanceId : null,
            instance: instanceData, packetUrl: context?.canonicalPacketUrl,
            currentUrl: tabData?.url || context?.currentBrowserUrl, title: tabData?.title || ''
        };
        sendResponse(responseData);
    } catch (error) {
        sendResponse({ success: false, error: error.message, tabId: tabId });
    }
}

async function handleGetCurrentTabContext(data, sender, sendResponse) {
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || tabs.length === 0) {
            sendResponse({ success: true, tabId: null, instanceId: null, instance: null, packetUrl: null, currentUrl: null, title: null });
            return;
        }
        const activeTab = tabs[0];
        await handleGetContextForTab({ tabId: activeTab.id }, sender, sendResponse);
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
}

async function handleGetPageDetailsFromDOM(sender, sendResponse) {
    try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab || typeof activeTab.id !== 'number') throw new Error("Could not find the current active tab.");
        if (!activeTab.url || activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('chrome-extension://')) {
            throw new Error("Cannot access content of special browser pages.");
        }
        const injectionResults = await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            func: () => ({ title: document.title, description: document.querySelector("meta[name='description']")?.content || '' }),
        });
        if (!injectionResults || injectionResults.length === 0) throw new Error("Script injection failed.");
        sendResponse({ success: true, ...injectionResults[0].result });
    } catch (error) {
        sendResponse({ success: false, title: '', description: '', error: error.message });
    }
}

async function handleMarkUrlVisited(data, sendResponse) {
    const { packetId: instanceId, url } = data;
    if (!instanceId || !url) return sendResponse({ success: false, error: 'Missing instanceId or url' });
    try {
        const instance = await storage.getPacketInstance(instanceId);
        if (!instance) return sendResponse({ success: false, error: 'Instance not found.' });

        const result = await packetUtils.markUrlAsVisited(instance, url);

        if (result.success && !result.alreadyVisited && !result.notTrackable) {
            await storage.savePacketInstance(result.instance);
            syncGlobalMediaState(result.instance);
            sidebarHandler.notifySidebar('url_visited', { packetId: instanceId, url });
        }
        sendResponse({ success: result.success, error: result.error });
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
}

async function handleReorderPacketTabs(data, sendResponse) {
    const { packetId: instanceId } = data;
    if (!(await shouldUseTabGroups())) { return sendResponse({ success: false, error: 'Tab Groups feature is disabled in settings.' }); }
    if (!instanceId) { return sendResponse({ success: false, error: 'Missing instanceId' }); }
    try {
        const [instance, browserState] = await Promise.all([storage.getPacketInstance(instanceId), storage.getPacketBrowserState(instanceId)]);
        if (!instance) return sendResponse({ success: false, error: 'Packet instance not found' });
        if (!browserState?.tabGroupId) return sendResponse({ success: true, message: 'Packet instance has no associated group.' });
        const result = await tabGroupHandler.orderTabsInGroup(browserState.tabGroupId, instance);
        sendResponse({ success: result });
    } catch (error) {
        sendResponse({ success: false, error: error.message || 'Unknown error' });
    }
}

async function handleSidebarReady(data, sender, sendResponse) {
    if (sidebarHandler && typeof sidebarHandler.handleSidebarReady === 'function') {
        await sidebarHandler.handleSidebarReady(data, sender, sendResponse);
    } else {
        sendResponse({ success: true, message: "Readiness acknowledged." });
    }
}

function findMediaItemInInstance(instance, url) {
    return instance?.contents?.find(item => item.url === url && item.format === 'audio');
}

async function ensureMediaIsCached(instanceId, url, lrl) {
    const indexedDbKey = sanitizeForFileName(lrl);
    const cachedAudio = await indexedDbStorage.getGeneratedContent(instanceId, indexedDbKey);
    if (cachedAudio?.[0]?.content) return { success: true, wasCached: true, content: cachedAudio[0].content };

    const instance = await storage.getPacketInstance(instanceId);
    const mediaItem = findMediaItemInInstance(instance, url);
    if (!mediaItem) throw new Error(`Media item with url ${url} not found in instance.`);
    const downloadResult = await cloudStorage.downloadFile(url);
    if (!downloadResult.success) throw new Error(`Failed to download audio: ${downloadResult.error}`);
    const audioBuffer = downloadResult.content;
    await indexedDbStorage.saveGeneratedContent(instanceId, indexedDbKey, [{
        name: lrl.split('/').pop(), content: audioBuffer, contentType: mediaItem.mimeType
    }]);
    return { success: true, wasCached: false, content: audioBuffer };
}

async function handlePlaybackActionRequest(data, sender, sendResponse) {
    const { intent, instanceId, url, lrl } = data;
    try {
        switch (intent) {
            case 'play':
                if (!instanceId || !url || !lrl) throw new Error('instanceId, url, and lrl required for play intent.');
                if (activeMediaPlayback.isPlaying && (activeMediaPlayback.instanceId !== instanceId || activeMediaPlayback.url !== url)) {
                    await saveCurrentTime(activeMediaPlayback.instanceId, activeMediaPlayback.url);
                    await controlAudioInOffscreen('stop', {});
                }
                const instance = await storage.getPacketInstance(instanceId);
                if (!instance) throw new Error(`Could not find instance ${instanceId}.`);
                const mediaItem = findMediaItemInInstance(instance, url);
                if (!mediaItem) throw new Error(`Could not find audio track with url ${url} in packet.`);
                const cacheResult = await ensureMediaIsCached(instanceId, url, lrl);
                const audioB64 = await arrayBufferToBase64(cacheResult.content);
                const startTime = mediaItem.currentTime || 0;

                const playResult = await controlAudioInOffscreen('play', { audioB64, mimeType: mediaItem.mimeType, url: url, instanceId, startTime });

                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                await setMediaPlaybackState({
                    isPlaying: playResult.isPlaying,
                    url, lrl, instanceId, title: instance.title, tabId: activeTab?.id,
                    currentTime: startTime, duration: mediaItem.duration || 0, instance: instance, lastTrippedMoment: null,
                });
                break;
            case 'pause': case 'toggle':
                if (!activeMediaPlayback.url || !activeMediaPlayback.instance) {
                    return sendResponse({ success: true, message: "No active media." });
                }

                const toggleResult = await controlAudioInOffscreen(intent, {});
                if (!toggleResult.isPlaying) {
                    await saveCurrentTime(activeMediaPlayback.instanceId, activeMediaPlayback.url, toggleResult.currentTime);
                }
                await setMediaPlaybackState({ isPlaying: toggleResult.isPlaying });
                break;
            case 'stop':
                if (activeMediaPlayback.url) await resetActiveMediaPlayback();
                break;
            default:
                throw new Error(`Unknown playback intent: ${intent}`);
        }
        sendResponse({ success: true });
    } catch (err) {
        sendResponse({ success: false, error: err.message });
    }
}

async function ensureHtmlIsCached(instanceId, url, lrl) {
    const indexedDbKey = sanitizeForFileName(lrl);
    const cachedHtml = await indexedDbStorage.getGeneratedContent(instanceId, indexedDbKey);
    if (cachedHtml?.[0]?.content) return { success: true, wasCached: true, content: cachedHtml[0].content };
    const instance = await storage.getPacketInstance(instanceId);
    const htmlItem = instance.contents.find(item => item.url === url && item.format === 'html');
    if (!htmlItem) throw new Error(`HTML item with url ${url} not found.`);
    const downloadResult = await cloudStorage.downloadFile(url);
    if (!downloadResult.success) throw new Error(`Failed to download HTML: ${downloadResult.error}`);
    const htmlBuffer = downloadResult.content;
    await indexedDbStorage.saveGeneratedContent(instanceId, indexedDbKey, [{
        name: lrl.split('/').pop(), content: htmlBuffer, contentType: htmlItem.mimeType
    }]);
    await ruleManager.addOrUpdatePacketRules(instance);
    return { success: true, wasCached: false, content: htmlBuffer };
}

async function ensurePdfIsCached(instanceId, url, lrl) {
    const indexedDbKey = sanitizeForFileName(lrl);
    const cachedPdf = await indexedDbStorage.getGeneratedContent(instanceId, indexedDbKey);
    if (cachedPdf?.[0]?.content) return { success: true, wasCached: true, content: cachedPdf[0].content };
    const instance = await storage.getPacketInstance(instanceId);
    const pdfItem = instance.contents.find(item => item.url === url && item.format === 'pdf');
    if (!pdfItem) throw new Error(`PDF item with url ${url} not found.`);
    const downloadResult = await cloudStorage.downloadFile(url);
    if (!downloadResult.success) throw new Error(`Failed to download PDF: ${downloadResult.error}`);
    const pdfBuffer = downloadResult.content;
    await indexedDbStorage.saveGeneratedContent(instanceId, indexedDbKey, [{
        name: lrl.split('/').pop(), content: pdfBuffer, contentType: pdfItem.mimeType || 'application/pdf'
    }]);
    return { success: true, wasCached: false, content: pdfBuffer };
}

async function handleSavePacketOutput(data, sender, sendResponse) {
    const { instanceId, lrl, capturedData, outputDescription, outputContentType } = data;
    if (!instanceId || !lrl || !capturedData) {
        return sendResponse({ success: false, error: 'Missing required data for saving packet output.' });
    }

    try {
        const instance = await storage.getPacketInstance(instanceId);
        if (!instance) {
            throw new Error(`Instance ${instanceId} not found.`);
        }

        if (!Array.isArray(instance.packetOutputs)) {
            instance.packetOutputs = [];
        }

        instance.packetOutputs.push({
            sourceLrl: lrl,
            capturedData: capturedData,
            outputDescription: outputDescription,
            outputContentType: outputContentType
        });

        if (!Array.isArray(instance.visitedUrls)) {
            instance.visitedUrls = [];
        }
        if (!instance.visitedUrls.includes(lrl)) {
            instance.visitedUrls.push(lrl);
        }

        await storage.savePacketInstance(instance);

        syncGlobalMediaState(instance);

        sidebarHandler.notifySidebar('packet_instance_updated', { instance });
        sendResponse({ success: true });

    } catch (error) {
        logger.error('MessageHandler:handleSavePacketOutput', 'Error saving packet output', error);
        sendResponse({ success: false, error: error.message });
    }
}

async function handleProposeSettingsUpdate(data, sender, sendResponse) {
    const { instance } = data;
    if (!instance || !instance.packetOutputs || instance.packetOutputs.length === 0) {
        return sendResponse({ success: true, proposedChanges: null });
    }

    try {
        const currentSettings = await storage.getSettings();
        const simplifiedOutputs = instance.packetOutputs.map(o => ({
            description: o.outputDescription,
            data: o.capturedData,
            contentType: o.outputContentType
        }));

        const systemPrompt = `Analyze these outputs and propose settings changes.`;
        const userPrompt = JSON.stringify(simplifiedOutputs);

        const result = await llmService.callLLM('propose_settings_changes', { system: systemPrompt, user: userPrompt });

        if (result.success) {
            try {
                const proposedChanges = typeof result.data === 'string' ? JSON.parse(result.data) : result.data;
                if (Array.isArray(proposedChanges) && proposedChanges.length > 0) {
                    sendResponse({ success: true, proposedChanges });
                } else {
                    sendResponse({ success: true, proposedChanges: null });
                }
            } catch (e) {
                throw new Error("LLM returned invalid JSON.");
            }
        } else {
            throw new Error(result.error || "LLM call failed.");
        }

    } catch (error) {
        logger.error('MessageHandler', 'Error proposing settings update', error);
        sendResponse({ success: false, error: error.message });
    }
    return true;
}

async function handleApplyProposedSettings(data, sender, sendResponse) {
    const { proposedChanges } = data;
    if (!proposedChanges || !Array.isArray(proposedChanges) || proposedChanges.length === 0) {
        return sendResponse({ success: false, error: 'No changes to apply.' });
    }

    try {
        const currentSettings = await storage.getSettings();
        proposedChanges.forEach(change => {
            if (change.operation === 'add' && change.path === 'llmModels') {
                const exists = currentSettings.llmModels.some(m => m.apiKey === change.value.apiKey && m.apiKey !== '');
                if (!exists) {
                    currentSettings.llmModels.push(change.value);
                }
            }
        });
        await storage.saveSettings(currentSettings);
        sendResponse({ success: true });
    } catch (error) {
        logger.error('MessageHandler', 'Error applying proposed settings', error);
        sendResponse({ success: false, error: error.message });
    }
}

async function handleCreateFromCodebase(data, sender, sendResponse) {
    const { prompt } = data;
    const imageId = `img_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    try {
        sendProgressNotification('packet_creation_progress', { imageId, status: 'active', text: 'Querying AI...', progressPercent: 25, title: prompt });

        const codebase = await getCodebase();
        const result = await llmService.callLLM('create_packet_from_codebase', { userPrompt: prompt, codebase });

        if (result.success && result.data) {
            const packetImage = result.data;

            packetImage.id = imageId;
            packetImage.created = new Date().toISOString();

            if (!packetImage.title || !Array.isArray(packetImage.sourceContent)) {
                throw new Error("LLM returned invalid packet structure.");
            }

            for (const item of packetImage.sourceContent) {
                if (item.origin === 'internal' && item.content) {
                    const contentBuffer = new TextEncoder().encode(item.content);
                    const indexedDbKey = sanitizeForFileName(item.lrl);
                    await indexedDbStorage.saveGeneratedContent(imageId, indexedDbKey, [{
                        name: item.lrl.split('/').pop(),
                        content: contentBuffer,
                        contentType: item.contentType || 'text/html'
                    }]);
                    delete item.content;
                }
            }

            await storage.savePacketImage(packetImage);
            sendProgressNotification('packet_image_created', { image: packetImage });
            sendResponse({ success: true, image: packetImage });
        } else {
            throw new Error(result.error || "LLM failed to generate a valid packet.");
        }
    } catch (error) {
        logger.error('MessageHandler:handleCreateFromCodebase', 'Error creating packet from codebase', error);
        sendProgressNotification('packet_creation_failed', { imageId, error: error.message });
        sendResponse({ success: false, error: error.message });
    }
}

async function getCodebase() {
    const manifest = await chrome.runtime.getManifest();
    let codebase = '';
    const filePaths = new Set([
        'background.js', 'manifest.json', 'sidebar.html', 'popup.html', 'offscreen.html', 'preview.html',
        'cli.js', 'cloud-storage.js', 'llm_service.js', 'tts_service.js', 'utils.js', 'page_interceptor.js',
        'popup.js', 'popup_actions.js', 'sidebar.js', 'offscreen.js', 'preview.js', 'selector.js', 'overlay.js',

        'background-modules/create-utils.js', 'background-modules/message-handlers.js', 'background-modules/navigation-handler.js',
        'background-modules/packet-processor.js', 'background-modules/packet-runtime.js', 'background-modules/rule-manager.js',
        'background-modules/sidebar-handler.js', 'background-modules/tab-group-handler.js',

        'sidebar-modules/create-view.js', 'sidebar-modules/detail-view.js', 'sidebar-modules/dialog-handler.js',
        'sidebar-modules/dom-references.js', 'sidebar-modules/root-view.js', 'sidebar-modules/settings-view.js',

        'sidebar.css', 'popup.css', 'overlay.css', 'selector.css', 'generated_page_style.css', 'help_style.css',

        'readme.md', 'LICENSE', 'package.json'
    ]);

    if (manifest.web_accessible_resources) {
        manifest.web_accessible_resources.forEach(resource => {
            resource.resources.forEach(path => filePaths.add(path));
        });
    }

    for (const filePath of filePaths) {
        try {
            if (filePath.endsWith('.png') || filePath.endsWith('.svg') || filePath.endsWith('.json')) {
                if (filePath.endsWith('package.json') || filePath.endsWith('manifest.json')) {
                } else {
                    continue;
                }
            }
            const url = chrome.runtime.getURL(filePath);
            const response = await fetch(url);
            if (response.ok) {
                const content = await response.text();
                codebase += `// File: ${filePath}\n\n${content}\n\n---\n\n`;
            }
        } catch (error) {
        }
    }
    return codebase;
}


const actionHandlers = {
    'debug_run_remote_agent': async (data, sender, sendResponse) => {
        try {
            await ensureOffscreenDocument();

            const agentJsPath = 'agents/agent.js';
            const responseJs = await fetch(chrome.runtime.getURL(agentJsPath));
            if (!responseJs.ok) throw new Error(`Failed to load JS: ${agentJsPath}`);
            const agentCode = await responseJs.text();

            // Handle different message structures (flat vs nested data)
            const payload = data || {};
            const userScript = payload.userCode || payload.code || "console.log('No user code provided'); 'Default Result'";

            const response = await chrome.runtime.sendMessage({
                target: 'offscreen',
                type: 'execute_remote_agent',
                data: {
                    code: agentCode,
                    args: { code: userScript }
                }
            });

            sendResponse(response);
        } catch (error) {
            console.error("Remote Agent Error:", error);
            sendResponse({ success: false, error: error.message });
        }
    },

    'perform_llm_check': async (data, sender, sendResponse) => {
        try {
            if (!self.ai || !self.ai.languageModel) throw new Error("Chrome AI not available");
            const { available } = await self.ai.languageModel.capabilities();
            if (available === 'no') throw new Error("Gemini Nano not available");

            const options = { expectedOutputLanguages: ['en'] };
            const session = await self.ai.languageModel.create(options);
            const result = await session.prompt(data.prompt);
            if (session.destroy) session.destroy();
            sendResponse({ success: true, data: result });
        } catch (e) {
            sendResponse({ success: false, error: e.message });
        }
    },

    'remote_agent_complete': (data, sender, sendResponse) => {
        sidebarHandler.notifySidebar('remote_agent_result', data);
        sendResponse({ success: true });
    },

    // --- Existing Handlers ---

    'create_from_codebase': handleCreateFromCodebase,
    'save_packet_output': handleSavePacketOutput,
    'activate_selector_tool': async (data, sender, sendResponse) => {
        const { toolType, sourceUrl } = data;
        const allTabs = await chrome.tabs.query({ url: sourceUrl });
        let targetTab = allTabs.length > 0 ? allTabs[0] : null;

        if (targetTab) {
            try {
                await chrome.tabs.sendMessage(targetTab.id, { action: 'activate_selector_tool', data: { toolType } });
                sendResponse({ success: true });
            } catch (e) {
                sendResponse({ success: false, error: 'Tab not ready to receive message.' });
            }
        } else {
            sendResponse({ success: false, error: 'Could not find the target tab.' });
        }
    },
    'deactivate_selector_tool': async (data, sender, sendResponse) => {
        const { sourceUrl } = data;
        const allTabs = await chrome.tabs.query({ url: sourceUrl });
        for (const tab of allTabs) {
            try {
                await chrome.tabs.sendMessage(tab.id, { action: 'deactivate_selector_tool' });
            } catch (e) { /* Tab might not be ready */ }
        }
        sendResponse({ success: true });
    },
    'deactivate_selector_tool_global': async (data, sender, sendResponse) => {
        const allTabs = await chrome.tabs.query({});
        for (const tab of allTabs) {
            try {
                await chrome.tabs.sendMessage(tab.id, { action: 'deactivate_selector_tool' });
            } catch (e) { /* Tab might not be ready or have the content script */ }
        }
        sidebarHandler.notifySidebar('deactivate_all_interactive_cards');
        sendResponse({ success: true });
    },
    'content_script_data_captured': (data, sender, sendResponse) => {
        sidebarHandler.notifySidebar('data_captured_from_content', data);
        sendResponse({ success: true });
    },
    'prepare_in_packet_navigation': async (data, sender, sendResponse) => {
        const tabId = sender.tab?.id;
        const destinationUrl = data?.destinationUrl;

        if (tabId && destinationUrl) {
            const currentContext = await getPacketContext(tabId);
            if (currentContext?.instanceId) {
                const instance = await storage.getPacketInstance(currentContext.instanceId);
                const targetItem = packetUtils.isUrlInPacket(destinationUrl, instance, { returnItem: true });

                if (targetItem) {
                    const trustedIntent = {
                        instanceId: currentContext.instanceId,
                        canonicalPacketUrl: targetItem.url
                    };
                    await storage.setSession({ [`trusted_intent_${tabId}`]: trustedIntent });
                    logger.log(`MessageHandler`, `Set trusted intent for tab ${tabId} to navigate to ${targetItem.url}`);
                }
            }
        }
        sendResponse({ success: true });
    },
    'debug_clear_all_data': async (data, sender, sendResponse) => {
        try {
            await storage.clearAllPacketData();
            sendResponse({ success: true });
        } catch (error) { sendResponse({ success: false, error: error.message }); }
    },
    'debug_clear_instance_caches': async (data, sender, sendResponse) => {
        try {
            await indexedDbStorage.clearInstanceCacheEntries();
            sendResponse({ success: true });
        } catch (error) { sendResponse({ success: false, error: error.message }); }
    },
    'sidebar_opened': async (data, sender, sendResponse) => {
        await storage.setSession({ isSidebarOpen: true });
        notifyOffscreenSidebarState(true);
        await notifyUIsOfStateChange({ isSidebarOpen: true });
        sendResponse({ success: true });
    },
    'sidebar_closed': async (data, sender, sendResponse) => {
        await storage.setSession({ isSidebarOpen: false });
        notifyOffscreenSidebarState(false);
        await notifyUIsOfStateChange({ isSidebarOpen: false, animate: true });
        sendResponse({ success: true });
    },
    'is_current_tab_packetizable': async (data, sender, sendResponse) => {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.url?.startsWith('http')) return sendResponse({ success: true, isPacketizable: false });
            sendResponse({ success: true, isPacketizable: true });
        } catch (error) { sendResponse({ success: false, error: error.message }); }
    },
    'create_draft_from_tab': (data, sender, sendResponse) => {
        sendResponse({ success: true });
        (async () => {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab) throw new Error("No active tab found.");
                const result = await generateDraftPacketFromTab(tab.id);
                sidebarHandler.notifySidebar(result.success ? 'draft_packet_created' : 'packet_creation_failed', result.success ? { draft: result.draft } : { error: result.error });
            } catch (error) {
                sidebarHandler.notifySidebar('packet_creation_failed', { error: error.message });
            }
        })();
        return true;
    },
    'get_initial_sidebar_context': handleGetCurrentTabContext,
    'request_playback_action': handlePlaybackActionRequest,
    'get_playback_state': async (data, sender, sendResponse) => {
        const { isSidebarOpen } = await storage.getSession({ isSidebarOpen: false });
        const overlayEnabled = await shouldShowOverlay();
        sendResponse({
            ...activeMediaPlayback,
            momentsTripped: activeMediaPlayback.instance?.momentsTripped || [],
            isVisible: !!activeMediaPlayback.url && !isSidebarOpen && overlayEnabled,
            animate: false
        });
    },
    'open_sidebar_and_navigate': (data, sender, sendResponse) => {
        sendResponse({ success: true });
    },
    'audio_time_update': async (data) => {
        if (!activeMediaPlayback.instance || activeMediaPlayback.url !== data.url || !activeMediaPlayback.isPlaying) return;
        activeMediaPlayback.currentTime = data.currentTime;
        activeMediaPlayback.duration = data.duration;

        const instance = activeMediaPlayback.instance;

        let momentTripped = false;
        (instance.moments || []).forEach((moment, index) => {
            if (moment.type === 'mediaTimestamp' && moment.sourceUrl === activeMediaPlayback.lrl &&
                data.currentTime >= moment.timestamp && instance.momentsTripped[index] === 0) {
                instance.momentsTripped[index] = 1;
                momentTripped = true;
                const revealedItem = instance.contents.find(item => item.revealedByMoments?.includes(index));
                if (revealedItem) {
                    const momentId = `moment_${Date.now()}`;
                    activeMediaPlayback.lastTrippedMoment = { id: momentId, title: revealedItem.title, url: revealedItem.url };
                    notifyUIsOfStateChange({ animateMomentMention: true });
                    setTimeout(() => {
                        if (activeMediaPlayback.lastTrippedMoment?.id === momentId) {
                            activeMediaPlayback.lastTrippedMoment = null;
                            notifyUIsOfStateChange({ animate: true });
                        }
                    }, 5000);
                }
            }
        });

        if (momentTripped) {
            await storage.savePacketInstance(instance);
        }

        const mediaItem = findMediaItemInInstance(instance, data.url);
        if (mediaItem) {
            mediaItem.currentTime = data.currentTime;
            mediaItem.duration = data.duration;
        }

        sidebarHandler.notifySidebar('playback_state_updated', { ...activeMediaPlayback });
    },
    'overlay_setting_updated': (d, s, r) => { notifyUIsOfStateChange().then(() => r({ success: true })); },
    'generate_packet_title': (data, sender, sendResponse) => {
        (async () => {
            try {
                const result = await llmService.callLLM('generate_packet_title', data, { providerType: 'chrome-ai-gemini-nano' });
                sendResponse(result.success ? { success: true, title: result.data } : { success: false, error: result.error });
            } catch (error) { sendResponse({ success: false, error: error.message }); }
        })();
        return true;
    },
    'get_draft_item_for_preview': async (data, sender, sendResponse) => {
        const { rlr } = data;
        const draftPacket = (await storage.getSession('draftPacketForPreview'))?.draftPacketForPreview;
        if (draftPacket && rlr) {
            const item = draftPacket.sourceContent.find(i => i.lrl === rlr);
            const storedContent = await indexedDbStorage.getGeneratedContent(draftPacket.id, sanitizeForFileName(rlr));
            if (item && storedContent?.[0]?.content) {
                let htmlContent = new TextDecoder().decode(storedContent[0].content);
                sendResponse({ success: true, htmlContent: injectInterceptorScript(htmlContent), title: item.title });
            } else { sendResponse({ success: false, error: 'Item content not found.' }); }
        } else { sendResponse({ success: false, error: 'Draft packet or RLR not found.' }); }
    },
    'get_cached_html_content': async (data, sender, sendResponse) => {
        const { instanceId, lrl } = data;
        if (instanceId && lrl) {
            const storedContent = await indexedDbStorage.getGeneratedContent(instanceId, sanitizeForFileName(lrl));
            if (storedContent?.[0]?.content) {
                let htmlContent = new TextDecoder().decode(storedContent[0].content);
                const instance = await storage.getPacketInstance(instanceId);
                const item = instance.contents.find(i => i.lrl === lrl);
                sendResponse({ success: true, htmlContent: injectInterceptorScript(htmlContent), title: item?.title });
            } else { sendResponse({ success: false, error: 'Cached content not found.' }); }
        } else { sendResponse({ success: false, error: 'Missing instanceId or lrl.' }); }
    },
    'get_presigned_url': async (data, sender, sendResponse) => {
        const { s3Key, instanceId } = data;
        const instance = await storage.getPacketInstance(instanceId);
        const contentItem = instance.contents.find(item => item.url === s3Key);
        if (contentItem?.publishContext) {
            const url = await cloudStorage.generatePresignedGetUrl(s3Key, 3600, contentItem.publishContext);
            sendResponse({ success: true, url });
        } else { sendResponse({ success: false, error: 'Could not find content item or context.' }); }
    },
    'get_page_details_from_dom': handleGetPageDetailsFromDOM,
    'sync_draft_group': (data, s, r) => tabGroupHandler.syncDraftGroup(data.desiredUrls).then(r),
    'focus_or_create_draft_tab': (data, s, r) => tabGroupHandler.focusOrCreateDraftTab(data.url).then(r),
    'cleanup_draft_group': (d, s, r) => tabGroupHandler.cleanupDraftGroup().then(r),
    'delete_packet_image': (data, s, r) => processDeletePacketImageRequest(data).then(r),
    'save_packet_image': async (data, sender, sendResponse) => {
        await storage.savePacketImage(data.image);
        sidebarHandler.notifySidebar('packet_image_created', { image: data.image });
        sendResponse({ success: true, imageId: data.image.id });
    },
    'initiate_packet_creation_from_tab': (data, s, r) => processCreatePacketRequestFromTab(s.tab.id).then(r),
    'initiate_packet_creation': (data, s, r) => processCreatePacketRequest(data, s.tab?.id).then(r),
    'instantiate_packet': async (data, sender, sendResponse) => {
        const result = await instantiatePacket(data.imageId, data.instanceId, sender.tab?.id);
        if (result.success) {
            sidebarHandler.notifySidebar('packet_instance_created', { instance: result.instance });
        }
        sendResponse(result);
    },
    'delete_packets': (data, s, r) => processDeletePacketsRequest(data).then(r),
    'mark_url_visited': handleMarkUrlVisited,
    'media_playback_complete': async (data, sender, sendResponse) => {
        await saveCurrentTime(data.instanceId, data.url, 0, true);
        activeMediaPlayback.isPlaying = false;
        const visitResult = await packetUtils.markUrlAsVisited(activeMediaPlayback.instance, data.url);
        if (visitResult.success && visitResult.modified) {
            await storage.savePacketInstance(visitResult.instance);
            activeMediaPlayback.instance = visitResult.instance;
            await notifyUIsOfStateChange({ showVisitedAnimation: true });
            await checkAndPromptForCompletion('MessageHandler', visitResult, data.instanceId);
        }
        sendResponse(visitResult);
    },
    'open_content': handleOpenContent,
    'open_content_from_preview': async (data, sender, sendResponse) => {
        const { instanceId, url } = data;
        if (!instanceId || !url) {
            return sendResponse({ success: false, error: 'Missing instanceId or URL for preview navigation.' });
        }
        try {
            const instance = await storage.getPacketInstance(instanceId);
            if (!instance) {
                throw new Error(`Instance ${instanceId} not found.`);
            }
            return handleOpenContent({ instance, url }, sender, sendResponse);
        } catch (error) {
            sendResponse({ success: false, error: error.message });
        }
    },
    'open_and_close_preview': async (data, sender, sendResponse) => {
        const { url, instanceId } = data;
        const tabId = sender.tab?.id;
        if (!tabId || !instanceId || !url) return sendResponse({ success: false, error: 'Missing required data.' });
        try {
            const instance = await storage.getPacketInstance(instanceId);
            if (!instance) throw new Error(`Instance ${instanceId} not found.`);
            await handleOpenContent({ instance, url }, sender, () => { });
            await chrome.tabs.remove(tabId);
            sendResponse({ success: true });
        } catch (error) { sendResponse({ success: false, error: error.message }); }
    },
    'open_content_from_overlay': async (data, sender, sendResponse) => {
        const { url } = data;
        const { instanceId } = activeMediaPlayback;
        if (!instanceId || !url) return sendResponse({ success: false, error: 'Missing active instance or URL.' });
        try {
            const instance = await storage.getPacketInstance(instanceId);
            if (!instance) throw new Error(`Instance ${instanceId} not found.`);
            return handleOpenContent({ instance, url }, sender, sendResponse);
        } catch (error) {
            sendResponse({ success: false, error: error.message });
        }
    },
    'get_context_for_tab': handleGetContextForTab,
    'get_current_tab_context': handleGetCurrentTabContext,
    'set_media_playback_state': (data, s, r) => { setMediaPlaybackState({}, data).then(() => r({ success: true })); },
    'page_interaction_complete': async (data, sender, sendResponse) => {
        const context = await getPacketContext(sender.tab.id);
        if (context?.instanceId && context?.canonicalPacketUrl) {
            const instance = await storage.getPacketInstance(context.instanceId);
            const visitResult = await packetUtils.markUrlAsVisited(instance, context.canonicalPacketUrl);
            if (visitResult.success && visitResult.modified) {
                await storage.savePacketInstance(visitResult.instance);
                syncGlobalMediaState(visitResult.instance);
                sidebarHandler.notifySidebar('packet_instance_updated', { instance: visitResult.instance });
                await checkAndPromptForCompletion('MessageHandler', visitResult, context.instanceId);
            }
            sendResponse(visitResult);
        } else { sendResponse({ success: false, error: 'No packet context for this tab.' }); }
    },
    'remove_tab_groups': (data, s, r) => tabGroupHandler.handleRemoveTabGroups(data, r),
    'reorder_packet_tabs': handleReorderPacketTabs,
    'theme_preference_updated': () => sidebarHandler.notifySidebar('theme_preference_updated'),
    'sidebar_ready': handleSidebarReady,
    'prepare_sidebar_navigation': (data, s, r) => { storage.setSession({ [PENDING_VIEW_KEY]: data }).then(success => r({ success })); },
    'publish_image_for_sharing': (data, s, r) => publishImageForSharing(data.imageId).then(r),
    'import_image_from_url': (data, s, r) => importImageFromUrl(data.url).then(r),
    'debug_dump_idb': (d, s, r) => { indexedDbStorage.debugDumpIndexedDb(); r({ success: true }); },
    'ensure_media_is_cached': async (data, sender, sendResponse) => {
        const { instanceId, url, lrl } = data;
        try {
            await ensureMediaIsCached(instanceId, url, lrl);
            sidebarHandler.notifySidebar('media_cache_populated', { instanceId, lrl });
            sendResponse({ success: true });
        } catch (error) { sendResponse({ success: false, error: error.message }); }
    },
    'ensure_html_is_cached': async (data, sender, sendResponse) => {
        const { instanceId, url, lrl } = data;
        try {
            await ensureHtmlIsCached(instanceId, url, lrl);
            sidebarHandler.notifySidebar('html_cache_populated', { instanceId, lrl });
            sendResponse({ success: true });
        } catch (error) { sendResponse({ success: false, error: error.message }); }
    },
    'ensure_pdf_is_cached': async (data, sender, sendResponse) => {
        const { instanceId, url, lrl } = data;
        try {
            await ensurePdfIsCached(instanceId, url, lrl);
            sidebarHandler.notifySidebar('pdf_cache_populated', { instanceId, lrl });
            sendResponse({ success: true });
        } catch (error) { sendResponse({ success: false, error: error.message }); }
    },
    'request_rule_refresh': async (d, s, r) => { await ruleManager.refreshAllRules(); r({ success: true }); },
    'propose_settings_update_from_packet': (data, s, r) => handleProposeSettingsUpdate(data, s, r),
    'apply_proposed_settings': (data, s, r) => handleApplyProposedSettings(data, s, r),
    'expand_tab_group_for_instance': (data, s, r) => tabGroupHandler.setGroupCollapsedState(data.instanceId, false).then(r),
    'collapse_tab_group_for_instance': (data, s, r) => tabGroupHandler.setGroupCollapsedState(data.instanceId, true).then(r),
};

export function handleMessage(message, sender, sendResponse) {
    const handler = actionHandlers[message.action];
    if (handler) {
        waitForRestoration().then(() => {
            return Promise.resolve(handler(message.data, sender, sendResponse));
        }).catch(err => {
            logger.error("MessageHandler", `Error in action ${message.action}:`, err);
            try { sendResponse({ success: false, error: err.message }); } catch (e) { }
        });

        return true;
    }
    return false;
}