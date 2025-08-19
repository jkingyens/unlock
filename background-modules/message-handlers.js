// ext/background-modules/message-handlers.js
// REVISED: The handlePlaybackActionRequest function now gracefully handles
// 'toggle' and 'pause' intents when no media is active, preventing errors.

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
    indexedDbStorage
} from '../utils.js';
import * as tabGroupHandler from './tab-group-handler.js';
import * as sidebarHandler from './sidebar-handler.js';
import cloudStorage from '../cloud-storage.js';
import llmService from '../llm_service.js';

import {
    processCreatePacketRequest,
    processCreatePacketRequestFromTab,
    processGenerateCustomPageRequest,
    processRepublishRequest,
    processDeletePacketsRequest,
    publishImageForSharing,
    importImageFromUrl,
    instantiatePacket,
    processDeletePacketImageRequest,
    enhanceHtml,
    processGenerateTimestampsRequest,
    processImproveDraftAudio,
    generateDraftPacketFromTab
} from './packet-processor.js';

import {
    setMediaPlaybackState,
    controlAudioInOffscreen,
    activeMediaPlayback,
    resetActiveMediaPlayback,
    notifyUIsOfStateChange,
    saveCurrentTime
} from '../background.js';
import { checkAndPromptForCompletion } from './navigation-handler.js';

const PENDING_VIEW_KEY = 'pendingSidebarView';
const openingContent = new Set(); // Lock to prevent opening multiple tabs for the same URL

let saveInstanceDebounceTimer = null;
function debouncedSaveInstance(instance) {
    clearTimeout(saveInstanceDebounceTimer);
    saveInstanceDebounceTimer = setTimeout(() => {
        storage.savePacketInstance(instance);
    }, 1000); // Save after 1 second of inactivity
}


// --- Context Request Handlers ---
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
                      logger.warn('MessageHandler:handleGetContextForTab', `Instance ${instanceId} not found but context existed. Clearing context.`);
                      await clearPacketContext(tabId);
                 }
             } catch (instanceError) {
                  logger.error('MessageHandler:handleGetContextForTab', `Failed fetching instance ${instanceId}`, instanceError);
                  await clearPacketContext(tabId);
             }
        }

        const responseData = {
            success: true,
            tabId: tabId,
            instanceId: instanceData ? instanceId : null,
            instance: instanceData,
            packetUrl: context?.canonicalPacketUrl,
            currentUrl: tabData?.url || context?.currentBrowserUrl,
            title: tabData?.title || ''
        };
        sendResponse(responseData);
    } catch (error) {
        logger.error('MessageHandler:handleGetContextForTab', 'Error fetching context', { tabId, error });
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
          logger.error('MessageHandler:handleGetCurrentTabContext', 'Error getting current tab context', error);
          sendResponse({ success: false, error: error.message });
     }
}

async function handleGetPageDetailsFromDOM(sender, sendResponse) {
    try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab || typeof activeTab.id !== 'number') {
            throw new Error("Could not find the current active tab.");
        }

        if (!activeTab.url || activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('chrome-extension://')) {
             throw new Error("Cannot access content of special browser pages.");
        }

        const injectionResults = await chrome.scripting.executeScript({
            target: { tabId: activeTab.id },
            func: () => {
                const title = document.title;
                const descriptionMeta = document.querySelector("meta[name='description']");
                const description = descriptionMeta ? descriptionMeta.content : '';
                return { title, description };
            },
        });

        if (!injectionResults || injectionResults.length === 0) {
            throw new Error("Script injection failed or returned no results.");
        }
        
        sendResponse({ success: true, ...injectionResults[0].result });

    } catch (error) {
        logger.error('MessageHandler:handleGetPageDetailsFromDOM', 'Error injecting script or getting page details', error);
        sendResponse({ success: false, title: '', description: '', error: error.message });
    }
}

async function handleOpenContent(data, sender, sendResponse) {
    const { instance, url: clickedUrl } = data;
    const instanceId = instance?.instanceId;
    const targetCanonicalUrl = clickedUrl;

    if (!instance || !instanceId || !targetCanonicalUrl) {
        sendResponse({ success: false, error: 'Missing instance data or targetCanonicalUrl' });
        return;
    }
    
    if (openingContent.has(targetCanonicalUrl)) {
        logger.log('MessageHandler:handleOpenContent', `Lock active for ${targetCanonicalUrl}. Focusing existing tab if possible.`);
        try {
            const allTabs = await chrome.tabs.query({});
            for (const tab of allTabs) {
                const context = await getPacketContext(tab.id);
                if (context && context.instanceId === instanceId && context.canonicalPacketUrl === targetCanonicalUrl) {
                    await chrome.tabs.update(tab.id, { active: true });
                    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
                    break;
                }
            }
        } catch (e) { /* Ignore errors during focus attempt */ }
        sendResponse({ success: true, message: 'Open already in progress.' });
        return;
    }

    openingContent.add(targetCanonicalUrl); // Acquire lock

    try {
        let targetTab = null;
        const allTabs = await chrome.tabs.query({});
        for (const tab of allTabs) {
            const context = await getPacketContext(tab.id);
            if (context && context.instanceId === instanceId && context.canonicalPacketUrl === targetCanonicalUrl) {
                targetTab = tab;
                break;
            }
        }
        
        const contentItem = instance.contents.find(item => item.url === targetCanonicalUrl);
        let finalUrlToOpen;

        if (contentItem && (contentItem.type === 'generated' || contentItem.type === 'media')) {
            if (contentItem.publishContext) {
                finalUrlToOpen = cloudStorage.constructPublicUrl(targetCanonicalUrl, contentItem.publishContext);
            } else {
                finalUrlToOpen = cloudStorage.getPublicUrl(targetCanonicalUrl);
            }
            if (!finalUrlToOpen) throw new Error(`Could not determine public URL for S3 key ${targetCanonicalUrl}.`);
        } else {
            finalUrlToOpen = targetCanonicalUrl;
        }

        const trustedIntent = {
            instanceId: instanceId,
            canonicalPacketUrl: targetCanonicalUrl,
        };

        if (targetTab) {
            await storage.setSession({ [`trusted_intent_${targetTab.id}`]: trustedIntent });
            await chrome.tabs.update(targetTab.id, { url: finalUrlToOpen, active: true });
            if (targetTab.windowId) await chrome.windows.update(targetTab.windowId, { focused: true });
        } else {
            const newTab = await chrome.tabs.create({ url: finalUrlToOpen, active: false });
            if (!newTab || typeof newTab.id !== 'number') throw new Error('Tab creation failed.');
            await storage.setSession({ [`trusted_intent_${newTab.id}`]: trustedIntent });
            await chrome.tabs.update(newTab.id, { active: true });
        }
        
        sendResponse({ success: true });
    } catch (error) {
        logger.error('MessageHandler:handleOpenContent', 'Error opening content', {instanceId, targetCanonicalUrl, error});
        sendResponse({ success: false, error: error.message || 'Unknown error' });
    } finally {
        openingContent.delete(targetCanonicalUrl); // Release lock
    }
}

async function handleMarkUrlVisited(data, sendResponse) {
     const { packetId: instanceId, url } = data;
     if (!instanceId || !url) return sendResponse({ success: false, error: 'Missing instanceId or url' });
     try {
          const result = await packetUtils.markUrlAsVisited(instanceId, url);
          if (result.success && !result.alreadyVisited && !result.notTrackable) {
               try { chrome.runtime.sendMessage({ action: 'url_visited', data: { packetId: instanceId, url } }); } catch (e) { /* ignore */ }
          }
          sendResponse({ success: result.success, error: result.error });
     } catch (error) {
          logger.error('MessageHandler:handleMarkUrlVisited', 'Error', error);
          sendResponse({ success: false, error: error.message });
     }
}

async function handleReorderPacketTabs(data, sendResponse) {
    const { packetId: instanceId } = data;
    if (!(await shouldUseTabGroups())) { sendResponse({ success: false, error: 'Tab Groups feature is disabled in settings.' }); return; }
    if (!instanceId) { sendResponse({ success: false, error: 'Missing instanceId' }); return; }
    try {
        const [instance, browserState] = await Promise.all([ storage.getPacketInstance(instanceId), storage.getPacketBrowserState(instanceId) ]);
        if (!instance) { sendResponse({ success: false, error: 'Packet instance not found' }); return; }
        if (!browserState?.tabGroupId) { sendResponse({ success: true, message: 'Packet instance has no associated group.' }); return; }
        const result = await tabGroupHandler.orderTabsInGroup(browserState.tabGroupId, instance);
        sendResponse({ success: result });
    } catch (error) {
        sendResponse({ success: false, error: error.message || 'Unknown error' });
    }
}

async function handleSidebarReady(data, sender, sendResponse) {
    logger.log('SidebarHandler:handleSidebarReady', 'Ready message received from sidebar UI');
    if (sidebarHandler && typeof sidebarHandler.handleSidebarReady === 'function') {
        await sidebarHandler.handleSidebarReady(data, sender, sendResponse);
    } else {
         sendResponse({ success: true, message: "Readiness acknowledged." });
    }
}

function findMediaItemInInstance(instance, pageId) {
    if (!instance || !instance.contents || !pageId) return null;
    for (const item of instance.contents) {
        if (item.pageId === pageId) return item;
        if (item.type === 'alternative' && item.alternatives) {
            const found = item.alternatives.find(alt => alt.pageId === pageId);
            if (found) return found;
        }
    }
    return null;
}

function calculateLastMentionedLink(instance, mediaItem) {
    if (!instance || !mediaItem || !mediaItem.timestamps || typeof mediaItem.currentTime !== 'number') {
        return null;
    }
    let lastMentionedTimestamp = null;
    mediaItem.timestamps.forEach(ts => {
        if (mediaItem.currentTime >= ts.startTime) {
            if (!lastMentionedTimestamp || ts.startTime > lastMentionedTimestamp.startTime) {
                lastMentionedTimestamp = ts;
            }
        }
    });
    const linkItem = lastMentionedTimestamp ? instance.contents.find(i => i.url === lastMentionedTimestamp.url) : null;
    return linkItem ? { url: linkItem.url, title: linkItem.title } : null;
}


async function handlePlaybackActionRequest(data, sender, sendResponse) {
    const { intent, instanceId, pageId } = data;
    try {
        switch (intent) {
            case 'play':
                if (!instanceId || !pageId) throw new Error('instanceId and pageId required for play intent.');

                if (activeMediaPlayback.isPlaying && (activeMediaPlayback.instanceId !== instanceId || activeMediaPlayback.pageId !== pageId)) {
                    await saveCurrentTime(activeMediaPlayback.instanceId, activeMediaPlayback.pageId);
                    await controlAudioInOffscreen('stop', {});
                }

                const instance = await storage.getPacketInstance(instanceId);
                if (!instance) throw new Error(`Could not find instance ${instanceId}.`);

                const mediaItem = findMediaItemInInstance(instance, pageId);
                if (!mediaItem) throw new Error(`Could not find track ${pageId} in packet.`);

                const cachedAudio = await indexedDbStorage.getGeneratedContent(instance.imageId, pageId);
                if (!cachedAudio || !cachedAudio[0]?.content) throw new Error("Could not find cached audio data.");

                const audioB64 = arrayBufferToBase64(cachedAudio[0].content);
                const startTime = mediaItem.currentTime || 0;

                await controlAudioInOffscreen('play', { audioB64, mimeType: mediaItem.mimeType, pageId, instanceId, startTime });

                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                activeMediaPlayback.isPlaying = true;
                activeMediaPlayback.pageId = pageId;
                activeMediaPlayback.instanceId = instanceId;
                activeMediaPlayback.topic = instance.topic;
                activeMediaPlayback.tabId = activeTab ? activeTab.id : null;
                activeMediaPlayback.currentTime = startTime; 
                activeMediaPlayback.lastMentionedLink = null;
                activeMediaPlayback.duration = mediaItem.duration || 0;
                await storage.setSession({ [CONFIG.STORAGE_KEYS.ACTIVE_MEDIA_KEY]: activeMediaPlayback });
                await notifyUIsOfStateChange(instance);
                break;
            // --- START OF THE FIX ---
            case 'pause':
            case 'toggle':
                if (!activeMediaPlayback.pageId) {
                    // If there's no active media, just succeed without doing anything.
                    return sendResponse({ success: true, message: "No active media to toggle/pause." });
                }
                await controlAudioInOffscreen(intent, {});
                activeMediaPlayback.isPlaying = intent === 'toggle' ? !activeMediaPlayback.isPlaying : false;

                if (!activeMediaPlayback.isPlaying) {
                     await saveCurrentTime(activeMediaPlayback.instanceId, activeMediaPlayback.pageId);
                }

                await storage.setSession({ [CONFIG.STORAGE_KEYS.ACTIVE_MEDIA_KEY]: activeMediaPlayback });
                await notifyUIsOfStateChange();
                break;
            // --- END OF THE FIX ---
            case 'stop':
                if (activeMediaPlayback.pageId) {
                    await resetActiveMediaPlayback();
                }
                break;
            default:
                throw new Error(`Unknown playback intent: ${intent}`);
        }
        sendResponse({ success: true });
    } catch (err) {
        logger.error("MessageHandler:handlePlaybackActionRequest", `Error handling intent '${intent}'`, err);
        sendResponse({ success: false, error: err.message });
    }
}

const actionHandlers = {
    'is_current_tab_packetizable': async (data, sender, sendResponse) => {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab || !tab.url || !tab.url.startsWith('http')) {
                return sendResponse({ success: true, isPacketizable: false, reason: 'Invalid tab or URL.' });
            }
            sendResponse({ success: true, isPacketizable: true });
        } catch (error) {
            sendResponse({ success: false, error: error.message });
        }
    },
    'create_draft_from_tab': (data, sender, sendResponse) => {
        sendResponse({ success: true, message: "Draft creation initiated." });
        (async () => {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab) throw new Error("No active tab found.");
                const result = await generateDraftPacketFromTab(tab.id);
                if (result.success) {
                    sidebarHandler.notifySidebar('draft_packet_created', { draft: result.draft });
                } else {
                    sidebarHandler.notifySidebar('packet_creation_failed', { error: result.error });
                }
            } catch (error) {
                sidebarHandler.notifySidebar('packet_creation_failed', { error: error.message });
            }
        })();
        return true;
    },
    'request_playback_action': handlePlaybackActionRequest,
    'get_playback_state': async (data, sender, sendResponse) => {
        const instance = activeMediaPlayback.instanceId ? await storage.getPacketInstance(activeMediaPlayback.instanceId) : null;
        if (instance) {
            const mediaItem = findMediaItemInInstance(instance, activeMediaPlayback.pageId);
            const { isSidebarOpen } = await storage.getSession({ isSidebarOpen: false });
            const overlayEnabled = await shouldShowOverlay();

            sendResponse({
                ...activeMediaPlayback,
                currentTime: activeMediaPlayback.currentTime || 0,
                duration: activeMediaPlayback.duration || 0,
                mentionedMediaLinks: instance.mentionedMediaLinks || [],
                lastMentionedLink: calculateLastMentionedLink(instance, { ...mediaItem, currentTime: activeMediaPlayback.currentTime }),
                isVisible: !!activeMediaPlayback.pageId && !isSidebarOpen && overlayEnabled,
                animate: false
            });
        } else {
            sendResponse({ ...activeMediaPlayback, isVisible: false, currentTime: 0, duration: 0, mentionedMediaLinks: [], lastMentionedLink: null });
        }
    },
    'open_sidebar_and_navigate': async (data, sender, sendResponse) => {
        // This action is now a no-op to prevent gesture errors.
        // The user should click the extension icon to open the side panel.
        sendResponse({ success: true, message: "User should open side panel via action icon." });
    },
    'audio_time_update': async (data) => {
        if (activeMediaPlayback.pageId !== data.pageId || !activeMediaPlayback.isPlaying) return;

        activeMediaPlayback.currentTime = data.currentTime;
        activeMediaPlayback.duration = data.duration;

        const instance = await storage.getPacketInstance(activeMediaPlayback.instanceId);
        if (!instance) return;

        const mediaItem = findMediaItemInInstance(instance, data.pageId);
        if (!mediaItem) return;

        const tempMediaItemForCalc = { ...mediaItem, currentTime: data.currentTime };
        const newMentionedLink = calculateLastMentionedLink(instance, tempMediaItemForCalc);

        const animateLinkMention = newMentionedLink && (!activeMediaPlayback.lastMentionedLink || newMentionedLink.url !== activeMediaPlayback.lastMentionedLink.url);

        activeMediaPlayback.lastMentionedLink = newMentionedLink;
        
        const mentionedUrls = new Set(instance.mentionedMediaLinks || []);
        if (mediaItem.timestamps) {
            mediaItem.timestamps.forEach(ts => {
                if (data.currentTime >= ts.startTime) {
                    mentionedUrls.add(ts.url);
                }
            });
        }
        instance.mentionedMediaLinks = Array.from(mentionedUrls);
        mediaItem.currentTime = data.currentTime;
        mediaItem.duration = data.duration;
        
        debouncedSaveInstance(instance);

        await notifyUIsOfStateChange(instance, { animateLinkMention });
        
        if (animateLinkMention) {
            const { isSidebarOpen } = await storage.getSession({ isSidebarOpen: false });
            if (!isSidebarOpen) {
                await actionHandlers.request_playback_action({ intent: 'pause' }, {}, () => {});
            }
        }
    },
    'overlay_setting_updated': async (data, sender, sendResponse) => {
        await notifyUIsOfStateChange();
        sendResponse({success: true});
    },
    'improve_draft_audio': (data, sender, sendResponse) => processImproveDraftAudio(data).then(sendResponse),
    'generate_timestamps_for_packet_items': (data, sender, sendResponse) => processGenerateTimestampsRequest(data).then(sendResponse),
    'generate_packet_title': (data, sender, sendResponse) => {
        (async () => {
            try {
                const nanoConfig = {
                    providerType: 'chrome-ai-gemini-nano',
                    modelName: 'gemini-nano'
                };
                const result = await llmService.callLLM('generate_packet_title', data, nanoConfig);
                if (result.success) {
                    sendResponse({ success: true, title: result.data });
                } else {
                    sendResponse({ success: false, error: result.error });
                }
            } catch (error) {
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true; // Indicate that the response will be sent asynchronously
    },
    'get_draft_item_for_preview': async (data, sender, sendResponse) => {
        const { pageId } = data;
        const sessionData = await storage.getSession('draftPacketForPreview');
        const draftPacket = sessionData?.draftPacketForPreview;
        const item = draftPacket?.sourceContent.flatMap(c => c.type === 'alternative' ? c.alternatives : c).find(i => i.pageId === pageId);
        if (item?.contentB64) {
            const htmlContent = new TextDecoder().decode(base64Decode(item.contentB64));
            sendResponse({ success: true, htmlContent, title: item.title });
        } else {
            sendResponse({ success: false, error: 'Item not found or has no content.' });
        }
    },
    'get_presigned_url': async (data, sender, sendResponse) => {
        const { s3Key, instanceId } = data;
        const instance = await storage.getPacketInstance(instanceId);
        const contentItem = instance.contents.find(item => item.url === s3Key);
        if (contentItem?.publishContext) {
            const url = await cloudStorage.generatePresignedGetUrl(s3Key, 3600, contentItem.publishContext);
            sendResponse({ success: true, url });
        } else {
            sendResponse({ success: false, error: 'Could not find content item or publish context.' });
        }
    },
    'get_page_details_from_dom': handleGetPageDetailsFromDOM,
    'sync_draft_group': (data, sender, sendResponse) => tabGroupHandler.syncDraftGroup(data.desiredUrls).then(sendResponse),
    'focus_or_create_draft_tab': (data, sender, sendResponse) => tabGroupHandler.focusOrCreateDraftTab(data.url).then(sendResponse),
    'cleanup_draft_group': (data, sender, sendResponse) => tabGroupHandler.cleanupDraftGroup().then(sendResponse),
    'generate_custom_page': (data, sender, sendResponse) => processGenerateCustomPageRequest(data).then(sendResponse),
    'delete_packet_image': (data, sender, sendResponse) => processDeletePacketImageRequest(data).then(sendResponse),
    'save_packet_image': async (data, sender, sendResponse) => {
        await storage.savePacketImage(data.image);
        chrome.runtime.sendMessage({ action: 'packet_image_created', data: { image: data.image } });
        sendResponse({ success: true, imageId: data.image.id });
    },
    'initiate_packet_creation_from_tab': (data, sender, sendResponse) => processCreatePacketRequestFromTab(sender.tab.id).then(sendResponse),
    'initiate_packet_creation': (data, sender, sendResponse) => processCreatePacketRequest(data, sender.tab?.id).then(sendResponse),
    'instantiate_packet': async (data, sender, sendResponse) => {
        const newInstanceId = `inst_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        const result = await instantiatePacket(data.imageId, newInstanceId, sender.tab?.id);
        if (result.success) {
            chrome.runtime.sendMessage({ action: 'packet_instance_created', data: { instance: result.instance } });
        }
        sendResponse(result);
    },
    'delete_packets': async (data, sender, sendResponse) => {
        clearTimeout(saveInstanceDebounceTimer);
        saveInstanceDebounceTimer = null;

        if (data?.packetIds && activeMediaPlayback.instanceId) {
            if (data.packetIds.includes(activeMediaPlayback.instanceId)) {
                await resetActiveMediaPlayback();
            }
        }
        const result = await processDeletePacketsRequest(data);
        sendResponse(result);
    },
    'mark_url_visited': handleMarkUrlVisited,
    'media_playback_complete': async (data, sender, sendResponse) => {
        await saveCurrentTime(data.instanceId, data.pageId, 0, true);
        activeMediaPlayback.isPlaying = false;
        const visitResult = await packetUtils.markPageIdAsVisited(data.instanceId, data.pageId);
        if (visitResult.success && visitResult.modified) {
            await notifyUIsOfStateChange(visitResult.instance, { showVisitedAnimation: true });
            await checkAndPromptForCompletion('MessageHandler', visitResult, data.instanceId);
        }
        sendResponse(visitResult);
    },
    'open_content': handleOpenContent,
    'open_content_from_overlay': async (data, sender, sendResponse) => {
        const { url } = data;
        const { instanceId } = activeMediaPlayback;
        if (!instanceId || !url) {
            return sendResponse({ success: false, error: 'Missing active instance or URL.' });
        }
        try {
            await setMediaPlaybackState({}, { animate: false, source: 'overlay_link_click' });
            const instance = await storage.getPacketInstance(instanceId);
            if (!instance) { throw new Error(`Instance ${instanceId} not found.`); }
            await handleOpenContent({ instance, url }, sender, sendResponse);
        } catch (error) {
            logger.error('MessageHandler:open_content_from_overlay', 'Error opening content', error);
            sendResponse({ success: false, error: error.message });
        }
    },
    'get_context_for_tab': handleGetContextForTab,
    'get_current_tab_context': handleGetCurrentTabContext,
    'set_media_playback_state': (data, sender, sendResponse) => {
        setMediaPlaybackState({}, data).then(() => sendResponse({ success: true }));
    },
    'page_interaction_complete': async (data, sender, sendResponse) => {
        const context = await getPacketContext(sender.tab.id);
        if (context?.instanceId && context?.canonicalPacketUrl) {
            const visitResult = await packetUtils.markUrlAsVisited(context.instanceId, context.canonicalPacketUrl);
            if (visitResult.success && visitResult.modified) {
                sidebarHandler.notifySidebar('packet_instance_updated', { instance: visitResult.instance });
                await checkAndPromptForCompletion('MessageHandler', visitResult, context.instanceId);
            }
            sendResponse(visitResult);
        } else {
            sendResponse({ success: false, error: 'No packet context found for this tab.' });
        }
    },
    'remove_tab_groups': (data, sender, sendResponse) => tabGroupHandler.handleRemoveTabGroups(data, sendResponse),
    'reorder_packet_tabs': handleReorderPacketTabs,
    'theme_preference_updated': () => chrome.runtime.sendMessage({ action: 'theme_preference_updated' }),
    'sidebar_ready': handleSidebarReady,
    'prepare_sidebar_navigation': (data, sender, sendResponse) => {
        storage.setSession({ [PENDING_VIEW_KEY]: data }).then(success => sendResponse({ success }));
    },
    'publish_image_for_sharing': (data, sender, sendResponse) => publishImageForSharing(data.imageId).then(sendResponse),
    'import_image_from_url': (data, sender, sendResponse) => importImageFromUrl(data.url).then(sendResponse)
};

export function handleMessage(message, sender, sendResponse) {
    const handler = actionHandlers[message.action];
    if (handler) {
        Promise.resolve(handler(message.data, sender, sendResponse))
            .catch(err => {
                logger.error("MessageHandler", `Error in action ${message.action}:`, err);
                try {
                    sendResponse({ success: false, error: err.message });
                } catch (e) {
                    // This error is expected if a response was already sent.
                }
            });
        return true; // Indicates async response
    } else {
        logger.warn("MessageHandler", "Unknown action received", message.action);
        sendResponse({ success: false, error: `Unknown action: ${message.action}` });
        return false;
    }
}