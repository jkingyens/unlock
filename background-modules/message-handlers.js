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
    indexedDbStorage,
    sanitizeForFileName
} from '../utils.js';
import * as tabGroupHandler from './tab-group-handler.js';
import * as sidebarHandler from './sidebar-handler.js';
import cloudStorage from '../cloud-storage.js';
import llmService from '../llm_service.js';
import * as ruleManager from './rule-manager.js';

import {
    instantiatePacket,
    processDeletePacketsRequest,
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


import {
    setMediaPlaybackState,
    controlAudioInOffscreen,
    activeMediaPlayback,
    resetActiveMediaPlayback,
    notifyUIsOfStateChange,
    saveCurrentTime,
    setupOffscreenDocument
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
        sendResponse({ success: true, message: 'Open already in progress.' });
        return;
    }

    openingContent.add(targetCanonicalUrl); // Acquire lock

    try {
        const allTabs = await chrome.tabs.query({});
        for (const tab of allTabs) {
            const context = await getPacketContext(tab.id);
            if (context && context.instanceId === instanceId && context.canonicalPacketUrl === targetCanonicalUrl) {
                await chrome.tabs.update(tab.id, { active: true });
                if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
                sendResponse({ success: true, message: 'Focused existing tab.' });
                return;
            }
        }
        
        let finalUrlToOpen = targetCanonicalUrl;
        
        const contentItem = instance.contents?.find(item => item.url === targetCanonicalUrl);
        
        if (contentItem && contentItem.origin === 'internal' && contentItem.publishContext) {
            finalUrlToOpen = cloudStorage.constructPublicUrl(targetCanonicalUrl, contentItem.publishContext);
        }

        const newTab = await chrome.tabs.create({ url: 'about:blank', active: false });
        if (!newTab || typeof newTab.id !== 'number') throw new Error('Tab creation failed.');
        
        const trustedIntent = {
            instanceId: instanceId,
            canonicalPacketUrl: targetCanonicalUrl,
        };
        await storage.setSession({ [`trusted_intent_${newTab.id}`]: trustedIntent });

        await chrome.tabs.update(newTab.id, { url: finalUrlToOpen, active: true });
        
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
          const instance = await storage.getPacketInstance(instanceId);
          if (!instance) return sendResponse({ success: false, error: 'Instance not found.' });
          const result = await packetUtils.markUrlAsVisited(instance, url);
          if (result.success && !result.alreadyVisited && !result.notTrackable) {
               await storage.savePacketInstance(result.instance);
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

function findMediaItemInInstance(instance, url) {
    if (!instance || !instance.contents || !url) return null;
    return instance.contents.find(item => item.url === url && item.format === 'audio');
}

async function ensureMediaIsCached(instanceId, url, lrl) {
    const indexedDbKey = sanitizeForFileName(lrl);
    const cachedAudio = await indexedDbStorage.getGeneratedContent(instanceId, indexedDbKey);
    
    if (cachedAudio && cachedAudio[0]?.content) {
        logger.log("CacheHelper", `Cache HIT for ${lrl} in instance ${instanceId}`);
        return { success: true, wasCached: true, content: cachedAudio[0].content };
    }

    logger.log("CacheHelper", `Cache MISS for ${lrl}. Fetching from cloud: ${url}`);
    const instance = await storage.getPacketInstance(instanceId);
    const mediaItem = findMediaItemInInstance(instance, url);
    if (!mediaItem) {
        throw new Error(`Media item with url ${url} not found in instance.`);
    }

    const downloadResult = await cloudStorage.downloadFile(url);
    if (!downloadResult.success) {
        throw new Error(`Failed to download audio from cloud: ${downloadResult.error}`);
    }

    const audioBuffer = await downloadResult.content.arrayBuffer();
    await indexedDbStorage.saveGeneratedContent(instanceId, indexedDbKey, [{
        name: lrl.split('/').pop(),
        content: audioBuffer,
        contentType: mediaItem.mimeType
    }]);
    
    logger.log("CacheHelper", `Successfully fetched and cached ${lrl} for instance ${instanceId}`);
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
                const audioB64 = arrayBufferToBase64(cacheResult.content);

                const startTime = mediaItem.currentTime || 0;
                await controlAudioInOffscreen('play', { audioB64, mimeType: mediaItem.mimeType, url: url, instanceId, startTime });

                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                await setMediaPlaybackState({
                    isPlaying: true,
                    url: url,
                    lrl: lrl,
                    instanceId: instanceId,
                    title: instance.title,
                    tabId: activeTab ? activeTab.id : null,
                    currentTime: startTime,
                    duration: mediaItem.duration || 0,
                    instance: instance,
                    lastTrippedMoment: null,
                });
                break;
            
            case 'pause':
            case 'toggle':
                if (!activeMediaPlayback.url || !activeMediaPlayback.instance) {
                    return sendResponse({ success: true, message: "No active media to toggle/pause." });
                }
                await controlAudioInOffscreen(intent, {});
                const isNowPlaying = intent === 'toggle' ? !activeMediaPlayback.isPlaying : false;
                
                if (!isNowPlaying) {
                    await saveCurrentTime(activeMediaPlayback.instanceId, activeMediaPlayback.url, activeMediaPlayback.currentTime);
                }
                await setMediaPlaybackState({ isPlaying: isNowPlaying });
                break;
            
            case 'stop':
                if (activeMediaPlayback.url) {
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

export async function ensureHtmlIsCached(instanceId, url, lrl) {
    const indexedDbKey = sanitizeForFileName(lrl);
    const cachedHtml = await indexedDbStorage.getGeneratedContent(instanceId, indexedDbKey);

    if (cachedHtml && cachedHtml[0]?.content) {
        logger.log("CacheHelper", `Cache HIT for HTML ${lrl} in instance ${instanceId}`);
        return { success: true, wasCached: true, content: cachedHtml[0].content };
    }

    logger.log("CacheHelper", `Cache MISS for HTML ${lrl}. Fetching from cloud: ${url}`);
    const instance = await storage.getPacketInstance(instanceId);
    const htmlItem = instance.contents.find(item => item.url === url && item.format === 'html');
    if (!htmlItem) {
        throw new Error(`HTML item with url ${url} not found in instance.`);
    }

    const downloadResult = await cloudStorage.downloadFile(url);
    if (!downloadResult.success) {
        throw new Error(`Failed to download HTML from cloud: ${downloadResult.error}`);
    }

    const htmlBuffer = await downloadResult.content.arrayBuffer();
    await indexedDbStorage.saveGeneratedContent(instanceId, indexedDbKey, [{
        name: lrl.split('/').pop(),
        content: htmlBuffer,
        contentType: htmlItem.mimeType
    }]);

    logger.log("CacheHelper", `Successfully fetched and cached HTML ${lrl} for instance ${instanceId}. Refreshing rules.`);
    await ruleManager.addOrUpdatePacketRules(instance);
    
    return { success: true, wasCached: false, content: htmlBuffer };
}

const actionHandlers = {
    'debug_clear_all_data': async (data, sender, sendResponse) => {
        try {
            await storage.clearAllPacketData();
            sendResponse({ success: true });
        } catch (error) {
            logger.error('MessageHandler:debug_clear_all_data', 'Failed to clear all data', error);
            sendResponse({ success: false, error: error.message });
        }
    },
    'sidebar_opened': async (data, sender, sendResponse) => {
        await storage.setSession({ isSidebarOpen: true });
        await notifyUIsOfStateChange({ isSidebarOpen: true });
        sendResponse({ success: true });
    },
    'sidebar_closed': async (data, sender, sendResponse) => {
        await storage.setSession({ isSidebarOpen: false });
        await notifyUIsOfStateChange({ isSidebarOpen: false, animate: true });
        sendResponse({ success: true });
    },
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
    'get_initial_sidebar_context': async (data, sender, sendResponse) => {
        try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!activeTab) {
                return sendResponse({ success: true, instanceId: null, instance: null });
            }

            let context_to_send = {};
            const tabContext = await getPacketContext(activeTab.id);

            if (tabContext && tabContext.instanceId) {
                // Tier 1: Tab context takes precedence
                context_to_send = {
                    instanceId: tabContext.instanceId,
                    instance: await storage.getPacketInstance(tabContext.instanceId),
                    packetUrl: tabContext.canonicalPacketUrl,
                    currentUrl: tabContext.currentBrowserUrl,
                };
            } else if (activeMediaPlayback.url && activeMediaPlayback.instance) {
                // Tier 2: Fallback to active media context
                context_to_send = {
                    instanceId: activeMediaPlayback.instanceId,
                    instance: activeMediaPlayback.instance,
                    packetUrl: null,
                    currentUrl: activeTab.url,
                };
            } else {
                // Default: No context
                context_to_send = { instanceId: null, instance: null };
            }
            sendResponse({ success: true, ...context_to_send });
        } catch (error) {
            logger.error('MessageHandler:get_initial_sidebar_context', 'Error getting initial context', error);
            sendResponse({ success: false, error: error.message });
        }
    },
    'request_playback_action': handlePlaybackActionRequest,
    'get_playback_state': async (data, sender, sendResponse) => {
        const instance = activeMediaPlayback.instance;
        const { isSidebarOpen } = await storage.getSession({ isSidebarOpen: false });
        const overlayEnabled = await shouldShowOverlay();

        const state = {
            ...activeMediaPlayback,
            momentsTripped: instance?.momentsTripped || [],
            isVisible: !!activeMediaPlayback.url && !isSidebarOpen && overlayEnabled,
            animate: false
        };
        sendResponse(state);
    },
    'open_sidebar_and_navigate': async (data, sender, sendResponse) => {
        sendResponse({ success: true, message: "User should open side panel via action icon." });
    },
    'debug_clear_instance_caches': async (data, sender, sendResponse) => {
        try {
            await indexedDbStorage.clearInstanceCacheEntries();
            sendResponse({ success: true });
        } catch (error) {
            logger.error('MessageHandler:debug_clear_instance_caches', 'Failed to clear instance caches', error);
            sendResponse({ success: false, error: error.message });
        }
    },
    'audio_time_update': async (data) => {
        if (!activeMediaPlayback.instance || activeMediaPlayback.url !== data.url || !activeMediaPlayback.isPlaying) {
            return;
        }

        activeMediaPlayback.currentTime = data.currentTime;
        activeMediaPlayback.duration = data.duration;

        const instance = activeMediaPlayback.instance;
        let animateMomentMention = false;
        
        if (Array.isArray(instance.moments)) {
            let momentTripped = false;
            instance.moments.forEach((moment, index) => {
                if (moment.type === 'mediaTimestamp' && 
                    moment.sourceUrl === activeMediaPlayback.lrl &&
                    data.currentTime >= moment.timestamp &&
                    instance.momentsTripped[index] === 0) {
                    
                    logger.log('MomentLogger:Media', `Tripping Moment #${index} for instance ${instance.instanceId}`, { 
                        currentTime: data.currentTime, 
                        requiredTimestamp: moment.timestamp 
                    });

                    instance.momentsTripped[index] = 1;
                    momentTripped = true;
                    
                    const revealedItem = instance.contents.find(item => 
                        (Array.isArray(item.revealedByMoments) && item.revealedByMoments.includes(index)) ||
                        item.revealedByMoment === index
                    );

                    if (revealedItem) {
                        activeMediaPlayback.lastTrippedMoment = {
                            title: revealedItem.title,
                            url: revealedItem.url
                        };
                        animateMomentMention = true;
                    }
                }
            });
            if (momentTripped) {
                await storage.savePacketInstance(instance);
            }
        }
        
        const mediaItem = findMediaItemInInstance(instance, data.url);
        if (mediaItem) {
            mediaItem.currentTime = data.currentTime;
            mediaItem.duration = data.duration;
        }
        
        await notifyUIsOfStateChange({ animateMomentMention });
       
        if (animateMomentMention) {
            activeMediaPlayback.lastTrippedMoment = null;
        }
    },
    'overlay_setting_updated': async (data, sender, sendResponse) => {
        await notifyUIsOfStateChange();
        sendResponse({success: true});
    },
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
        const { rlr } = data;
        const sessionData = await storage.getSession('draftPacketForPreview');
        const draftPacket = sessionData?.draftPacketForPreview;
        
        if (draftPacket && rlr) {
            const item = draftPacket.sourceContent.find(i => i.lrl === rlr);
            const indexedDbKey = sanitizeForFileName(rlr);
            const storedContent = await indexedDbStorage.getGeneratedContent(draftPacket.id, indexedDbKey);
            
            if (item && storedContent && storedContent[0]?.content) {
                const htmlContent = new TextDecoder().decode(storedContent[0].content);
                sendResponse({ success: true, htmlContent, title: item.title });
            } else {
                sendResponse({ success: false, error: 'Item content not found in IndexedDB.' });
            }
        } else {
            sendResponse({ success: false, error: 'Draft packet or RLR not found.' });
        }
    },
    'get_cached_html_content': async (data, sender, sendResponse) => {
        const { instanceId, lrl } = data;
        if (instanceId && lrl) {
            const indexedDbKey = sanitizeForFileName(lrl);
            const storedContent = await indexedDbStorage.getGeneratedContent(instanceId, indexedDbKey);

            if (storedContent && storedContent[0]?.content) {
                const htmlContent = new TextDecoder().decode(storedContent[0].content);
                const instance = await storage.getPacketInstance(instanceId);
                const item = instance.contents.find(i => i.lrl === lrl);
                sendResponse({ success: true, htmlContent, title: item?.title || 'Cached Page' });
            } else {
                sendResponse({ success: false, error: 'Cached content not found.' });
            }
        } else {
            sendResponse({ success: false, error: 'Missing instanceId or lrl.' });
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
    'delete_packet_image': (data, sender, sendResponse) => processDeletePacketImageRequest(data).then(sendResponse),
    'save_packet_image': async (data, sender, sendResponse) => {
        await storage.savePacketImage(data.image);
        chrome.runtime.sendMessage({ action: 'packet_image_created', data: { image: data.image } });
        sendResponse({ success: true, imageId: data.image.id });
    },
    'initiate_packet_creation_from_tab': (data, sender, sendResponse) => processCreatePacketRequestFromTab(sender.tab.id).then(sendResponse),
    'initiate_packet_creation': (data, sender, sendResponse) => processCreatePacketRequest(data, sender.tab?.id).then(sendResponse),
    'instantiate_packet': async (data, sender, sendResponse) => {
        const result = await instantiatePacket(data.imageId, data.instanceId, sender.tab?.id);
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
        const liveInstance = activeMediaPlayback.instance;
        await saveCurrentTime(data.instanceId, data.url, 0, true);
        activeMediaPlayback.isPlaying = false;
        
        const visitResult = await packetUtils.markUrlAsVisited(liveInstance, data.url);
        
        if (visitResult.success && visitResult.modified) {
            await storage.savePacketInstance(visitResult.instance);
            await notifyUIsOfStateChange({ showVisitedAnimation: true });
            await checkAndPromptForCompletion('MessageHandler', visitResult, data.instanceId);
        }
        sendResponse(visitResult);
    },
    'open_content': handleOpenContent,
    'open_and_close_preview': async (data, sender, sendResponse) => {
        const { url, instanceId } = data;
        const tabId = sender.tab?.id;
        
        if (!tabId || !instanceId || !url) {
            return sendResponse({ success: false, error: 'Missing required data from preview page.' });
        }
        try {
            const instance = await storage.getPacketInstance(instanceId);
            if (!instance) {
                throw new Error(`Instance ${instanceId} not found.`);
            }
            // Reuse the existing handler to open the new tab
            await handleOpenContent({ instance, url }, sender, () => {});
            
            // Now, close the original preview tab
            await chrome.tabs.remove(tabId);
            sendResponse({ success: true });
        } catch (error) {
            logger.error('MessageHandler:open_and_close_preview', 'Error during preview transition', error);
            sendResponse({ success: false, error: error.message });
        }
    },
    'open_content_from_overlay': async (data, sender, sendResponse) => {
        const { url } = data;
        const { instanceId } = activeMediaPlayback;
        if (!instanceId || !url) {
            return sendResponse({ success: false, error: 'Missing active instance or URL.' });
        }
        try {
            const instance = await storage.getPacketInstance(instanceId);
            if (!instance) {
                throw new Error(`Instance ${instanceId} not found.`);
            }
            return handleOpenContent({ instance, url }, sender, sendResponse);
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
            const instance = await storage.getPacketInstance(context.instanceId);
            const visitResult = await packetUtils.markUrlAsVisited(instance, context.canonicalPacketUrl);
            if (visitResult.success && visitResult.modified) {
                await storage.savePacketInstance(visitResult.instance);
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
    'import_image_from_url': (data, sender, sendResponse) => importImageFromUrl(data.url).then(sendResponse),
    'debug_dump_idb': (data, sender, sendResponse) => {
        indexedDbStorage.debugDumpIndexedDb();
        sendResponse({ success: true });
    },
    'ensure_media_is_cached': async (data, sender, sendResponse) => {
        const { instanceId, url, lrl } = data;
        try {
            await ensureMediaIsCached(instanceId, url, lrl);
            sidebarHandler.notifySidebar('media_cache_populated', { instanceId, lrl });
            sendResponse({ success: true });
        } catch (error) {
            logger.error("MessageHandler:ensure_media_is_cached", "Failed to cache media", error);
            sendResponse({ success: false, error: error.message });
        }
    },
    'ensure_html_is_cached': async (data, sender, sendResponse) => {
        const { instanceId, url, lrl } = data;
        try {
            await ensureHtmlIsCached(instanceId, url, lrl);
            sidebarHandler.notifySidebar('html_cache_populated', { instanceId, lrl });
            sendResponse({ success: true });
        } catch (error) {
            logger.error("MessageHandler:ensure_html_is_cached", "Failed to cache HTML", error);
            sendResponse({ success: false, error: error.message });
        }
    },
    'request_rule_refresh': async (data, sender, sendResponse) => {
        await ruleManager.refreshAllRules();
        sendResponse({ success: true });
    },
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