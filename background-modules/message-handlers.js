// ext/background-modules/message-handlers.js
// REVISED: The handleOpenContent function now uses chrome.storage.session to create a
// "trusted intent" token for newly created tabs. This is the first step in eliminating
// the race condition between tab creation and the first navigation event.

import {
    logger,
    storage,
    packetUtils,
    shouldUseTabGroups,
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
    processImproveDraftAudio
} from './packet-processor.js';

import {
    setMediaPlaybackState,
    controlAudioInOffscreen,
    activeMediaPlayback,
    resetActiveMediaPlayback
} from '../background.js';
import { checkAndPromptForCompletion } from './navigation-handler.js';

const PENDING_VIEW_KEY = 'pendingSidebarView';

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

    try {
        if (!instance) throw new Error(`Packet instance ${instanceId} not found`);

        let existingTab = null;
        const allTabs = await chrome.tabs.query({});
        for (const tab of allTabs) {
            const context = await getPacketContext(tab.id);
            if (context && context.instanceId === instanceId && context.canonicalPacketUrl === targetCanonicalUrl) {
                existingTab = tab;
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

        if (existingTab) {
            await chrome.tabs.update(existingTab.id, { url: finalUrlToOpen, active: true });
            if (existingTab.windowId) await chrome.windows.update(existingTab.windowId, { focused: true });
        } else {
            const newTab = await chrome.tabs.create({ url: finalUrlToOpen, active: false });
            if (!newTab || typeof newTab.id !== 'number') throw new Error('Tab creation failed.');
            
            const trustedIntent = {
                instanceId: instanceId,
                canonicalPacketUrl: targetCanonicalUrl,
            };
            await storage.setSession({ [`trusted_intent_${newTab.id}`]: trustedIntent });
            
            await chrome.tabs.update(newTab.id, { active: true });
            
            logger.log(`MessageHandler:handleOpenContent`, `Set trusted intent token for new Tab ${newTab.id}.`);
        }
        
        sendResponse({ success: true });
    } catch (error) {
        logger.error('MessageHandler:handleOpenContent', 'Error opening content', {instanceId, targetCanonicalUrl, error});
        sendResponse({ success: false, error: error.message || 'Unknown error' });
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

async function handlePlaybackActionRequest(data, sender, sendResponse) {
    const { intent, instanceId, pageId } = data;
    const currentState = { ...activeMediaPlayback };
    try {
        switch (intent) {
            case 'play':
                if (!instanceId || !pageId) throw new Error('instanceId and pageId required for play intent.');
                const instance = await storage.getPacketInstance(instanceId);
                if (!instance) throw new Error(`Could not find instance ${instanceId}.`);
                let contentItem;
                instance.contents.forEach(item => {
                    if (item.pageId === pageId) contentItem = item;
                    else if (item.type === 'alternative') {
                        const alt = item.alternatives.find(a => a.pageId === pageId);
                        if (alt) contentItem = alt;
                    }
                });
                if (!contentItem) throw new Error(`Could not find track ${pageId} in packet.`);
                const cachedAudio = await indexedDbStorage.getGeneratedContent(instance.imageId, pageId);
                if (!cachedAudio || !cachedAudio[0]?.content) throw new Error("Could not find cached audio data.");

                const audioB64 = arrayBufferToBase64(cachedAudio[0].content);
                await controlAudioInOffscreen('play', { audioB64, mimeType: contentItem.mimeType, pageId, instanceId });
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

                await setMediaPlaybackState({
                    isPlaying: true,
                    pageId,
                    instanceId,
                    topic: instance.topic,
                    tabId: activeTab ? activeTab.id : null,
                    currentTime: 0,
                    duration: 0,
                    mentionedMediaLinks: [],
                    lastMentionedLink: null
                }, { source: 'play_intent' });
                break;

            case 'pause':
            case 'toggle':
                if (!currentState.pageId) throw new Error('No active media to toggle/pause.');
                await controlAudioInOffscreen(intent, {});
                await setMediaPlaybackState({ isPlaying: intent === 'toggle' ? !currentState.isPlaying : false });
                break;
            case 'stop':
                if (currentState.pageId) {
                    await controlAudioInOffscreen('stop', {});
                    await resetActiveMediaPlayback();
                }
                break;
            default:
                throw new Error(`Unknown playback intent: ${intent}`);
        }
        sendResponse({ success: true });
    } catch (err) {
        sendResponse({ success: false, error: err.message });
    }
}

const actionHandlers = {
    'request_playback_action': handlePlaybackActionRequest,
    'get_playback_state': async (data, sender, sendResponse) => {
        try {
            const hasActiveTrack = !!activeMediaPlayback.pageId;
            const { isSidebarOpen } = await storage.getSession({ isSidebarOpen: false });
            const isVisible = hasActiveTrack && !isSidebarOpen;
    
            const fullState = {
                ...activeMediaPlayback,
                isVisible: isVisible,
                animate: false,
                animateLinkMention: false
            };
            sendResponse(fullState);
        } catch (e) {
            logger.error('MessageHandler:get_playback_state', 'Error constructing full state', e);
            sendResponse({ ...activeMediaPlayback, isVisible: false });
        }
    },
    'open_sidebar_and_navigate': async (data, sender, sendResponse) => {
        const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
        if (tab) {
            await chrome.sidePanel.open({ windowId: tab.windowId });
            chrome.runtime.sendMessage({ action: 'navigate_to_view', data });
        }
        sendResponse({ success: true });
    },
    'audio_time_update': (data) => {
        if (activeMediaPlayback.pageId === data.pageId) {
            setMediaPlaybackState({ currentTime: data.currentTime, duration: data.duration }, { source: 'time_update' });
        }
    },
    'improve_draft_audio': (data, sender, sendResponse) => processImproveDraftAudio(data).then(sendResponse),
    'generate_timestamps_for_packet_items': (data, sender, sendResponse) => processGenerateTimestampsRequest(data).then(sendResponse),
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
        await handlePlaybackActionRequest({ data: { intent: 'stop' } }, sender, () => {});
        const visitResult = await packetUtils.markPageIdAsVisited(data.instanceId, data.pageId);
        if (visitResult.success && visitResult.modified) {
            sidebarHandler.notifySidebar('packet_instance_updated', { instance: visitResult.instance });
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
                // Check if a response has already been sent to avoid errors.
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