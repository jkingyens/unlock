// ext/background-modules/message-handlers.js

import {
    logger,
    storage,
    packetUtils,
    shouldUseTabGroups,
    setPacketContext,
    getPacketContext,
    clearPacketContext,
    MPI_PARAMS,
    CONFIG,
    base64Encode // This is the fix
} from '../utils.js';
import * as tabGroupHandler from './tab-group-handler.js';
import * as sidebarHandler from './sidebar-handler.js';
import { deduplicateUrlInGroup } from './tab-group-handler.js';
import cloudStorage from '../cloud-storage.js';
import llmService from '../llm_service.js';

import {
    processCreatePacketRequest,
    processCreatePacketRequestFromTab,
    processGenerateCustomPageRequest, // New Import
    processRepublishRequest,
    processDeletePacketsRequest,
    publishImageForSharing,
    importImageFromUrl,
    instantiatePacket,
    processDeletePacketImageRequest,
    enhanceHtml
} from './packet-processor.js';

import { interimContextMap } from '../background.js';
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
            packetUrl: context?.packetUrl,
            currentUrl: tabData?.url || context?.currentUrl,
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
    const { packetId: instanceId, url, clickedUrl } = data;
    const targetCanonicalUrl = clickedUrl || url;
    let resultingTabId = null;
    logger.log('MessageHandler:handleOpenContent', 'Processing request', { instanceId, targetCanonicalUrl });
    if (!instanceId || !targetCanonicalUrl) { sendResponse({ success: false, error: 'Missing instanceId or targetCanonicalUrl' }); return; }

    try {
        const instance = await storage.getPacketInstance(instanceId);
        if (!instance) throw new Error(`Packet instance ${instanceId} not found`);

        const contentItem = instance.contents.find(item => item.url === targetCanonicalUrl);
        let finalUrlToOpen;
        let packetUrlForContext = targetCanonicalUrl;

        if (contentItem && contentItem.type === 'generated') {
            if (contentItem.publishContext) {
                finalUrlToOpen = cloudStorage.constructPublicUrl(targetCanonicalUrl, contentItem.publishContext);
            } else {
                finalUrlToOpen = cloudStorage.getPublicUrl(targetCanonicalUrl);
                logger.warn('MessageHandler:handleOpenContent', `Legacy packet item missing publishContext. Using active settings to construct URL for ${targetCanonicalUrl}. This may fail if settings have changed.`);
            }

            if (!finalUrlToOpen) {
                logger.error('MessageHandler:handleOpenContent', `Failed to construct canonical public URL for S3 key ${targetCanonicalUrl}. Cannot open tab.`);
                throw new Error(`Could not determine public URL for S3 key ${targetCanonicalUrl}.`);
            }
            logger.log('MessageHandler:handleOpenContent', `Opening canonical URL (will be redirected by DNR): ${finalUrlToOpen}`);
        } else {
            finalUrlToOpen = targetCanonicalUrl;
            logger.log('MessageHandler:handleOpenContent', `Target ${targetCanonicalUrl} is external. Opening directly.`);
        }

        let existingTab = null;
        try {
            const allTabs = await chrome.tabs.query({});
            for (const tab of allTabs) {
                const context = await getPacketContext(tab.id);
                if (context && context.instanceId === instanceId && context.packetUrl === packetUrlForContext) {
                    existingTab = tab;
                    logger.log('MessageHandler:handleOpenContent', `Found existing tab ${tab.id} via context lookup for canonical URL: ${packetUrlForContext}.`);
                    break;
                }
            }
        } catch (e) { logger.error('MessageHandler:handleOpenContent', 'Error during tab lookup', e); }

        const useTabGroups = await shouldUseTabGroups();

        let targetTab = null;
        if (existingTab) {
            logger.log('MessageHandler:handleOpenContent', 'Found existing tab, activating and updating URL.', { tabId: existingTab.id });
            targetTab = await chrome.tabs.update(existingTab.id, { url: finalUrlToOpen, active: true });
            if (targetTab?.windowId) await chrome.windows.update(targetTab.windowId, { focused: true });
            resultingTabId = existingTab.id;
            await setPacketContext(resultingTabId, instanceId, packetUrlForContext, finalUrlToOpen);
        } else {
            logger.log('MessageHandler:handleOpenContent', 'Creating new tab.');
            targetTab = await chrome.tabs.create({ url: finalUrlToOpen, active: true });
            if (!targetTab || typeof targetTab.id !== 'number') throw new Error('Tab creation failed or did not return a valid ID.');
            resultingTabId = targetTab.id;

            interimContextMap.set(resultingTabId, {
                instanceId: instanceId,
                packetUrl: packetUrlForContext
            });
            logger.log(`MessageHandler:handleOpenContent`, `Stored interim context in MAP for new Tab ${resultingTabId}`);

            const updatedBrowserState = await storage.getPacketBrowserState(instanceId);
            const stateToSave = updatedBrowserState || { instanceId, tabGroupId: null, activeTabIds: [], lastActiveUrl: null };
            if (!stateToSave.activeTabIds.includes(resultingTabId)) {
                 stateToSave.activeTabIds.push(resultingTabId);
            }
            stateToSave.lastActiveUrl = packetUrlForContext;
            await storage.savePacketBrowserState(stateToSave);

            if (targetTab?.windowId) await chrome.windows.update(targetTab.windowId, { focused: true });
            await setPacketContext(resultingTabId, instanceId, packetUrlForContext, finalUrlToOpen);
        }

        if (useTabGroups) {
            await tabGroupHandler.ensureTabInGroup(resultingTabId, instanceId);

            const finalBrowserState = await storage.getPacketBrowserState(instanceId);
            const groupId = finalBrowserState?.tabGroupId;

            if (groupId) {
                // A group exists (it may have been just created), so trigger the focus logic.
                logger.log('MessageHandler:handleOpenContent', `A group (${groupId}) exists for this packet. Triggering focus logic.`);
                await tabGroupHandler.handleFocusTabGroup({ focusedGroupId: groupId });

                // Continue with other group management tasks
                await deduplicateUrlInGroup(groupId, instanceId, resultingTabId);
                await tabGroupHandler.orderTabsInGroup(groupId, instance);
            }
        }
        sendResponse({ success: true, result: { packetId: instanceId, tabId: resultingTabId, openedUrl: finalUrlToOpen } });
    } catch (error) {
        logger.error('MessageHandler:handleOpenContent', 'Error opening content', {instanceId, targetCanonicalUrl, error});
        if (resultingTabId && interimContextMap.has(resultingTabId)) {
             interimContextMap.delete(resultingTabId);
        }
        try { sendResponse({ success: false, error: error.message || 'Unknown error' }); } catch (e) { /* ignore */ }
    }
}



// --- Instance State Management ---
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
    const useTabGroups = await shouldUseTabGroups();
    if (!useTabGroups) { sendResponse({ success: false, error: 'Tab Groups feature is disabled in settings.' }); return; }
    if (!instanceId) { sendResponse({ success: false, error: 'Missing instanceId' }); return; }
    logger.log('MessageHandler:handleReorderPacketTabs', 'Reordering tabs for instance', instanceId);
    try {
        const [instance, browserState] = await Promise.all([ storage.getPacketInstance(instanceId), storage.getPacketBrowserState(instanceId) ]);
        if (!instance) { sendResponse({ success: false, error: 'Packet instance not found' }); return; }
        if (!browserState?.tabGroupId) { sendResponse({ success: true, message: 'Packet instance has no associated group.' }); return; }
        const groupId = browserState.tabGroupId;
        try { await chrome.tabGroups.get(groupId); }
        catch (error) {
            logger.warn('MessageHandler:handleReorderPacketTabs', `Group ${groupId} for instance ${instanceId} no longer exists. Clearing from state.`);
            const currentState = await storage.getPacketBrowserState(instanceId);
            if(currentState && currentState.tabGroupId === groupId) {
                currentState.tabGroupId = null;
                await storage.savePacketBrowserState(currentState);
            }
            sendResponse({ success: false, error: 'Associated group no longer exists' }); return;
        }
        const result = await tabGroupHandler.orderTabsInGroup(groupId, instance);
        sendResponse({ success: result, error: result ? undefined : 'Failed to reorder tabs' });
    } catch (error) {
        logger.error('MessageHandler:handleReorderPacketTabs', 'Error', error);
        sendResponse({ success: false, error: error.message || 'Unknown error' });
    }
}

async function handleSidebarReady(sender, sendResponse) {
    logger.log('MessageHandler:handleSidebarReady', 'Sidebar ready message received.');
    if (sidebarHandler && typeof sidebarHandler.handleSidebarReady === 'function') {
        await sidebarHandler.handleSidebarReady(sender, sendResponse);
    } else {
         logger.warn('MessageHandler:handleSidebarReady', 'Sidebar handler module or function not found. Basic acknowledgement.');
         sendResponse({ success: true, message: "Readiness acknowledged by basic handler." });
    }
}


// --- Main Message Router ---
export function handleMessage(message, sender, sendResponse) {
    let isAsync = false;
    const noisyActions = ['get_context_for_tab', 'get_current_tab_context', 'get_page_details_from_dom'];
    if (!noisyActions.includes(message.action)) {
        logger.log('MessageHandler', `Received action: ${message.action}`, { data: message.data, senderTab: sender.tab?.id, senderUrl: sender.url, senderId: sender.id });
    }

    switch (message.action) {
        case 'get_page_details_from_dom':
            handleGetPageDetailsFromDOM(sender, sendResponse);
            isAsync = true;
            break;
        case 'navigate_to_view':
            // This is handled by the sidebar's listener, but we can acknowledge it here.
            sendResponse({ success: true });
            break;
        case 'generate_custom_page':
            processGenerateCustomPageRequest(message.data)
                .then(sendResponse)
                .catch(err => sendResponse({ success: false, error: err.message }));
            isAsync = true;
            break;
        case 'delete_packet_image':
            processDeletePacketImageRequest(message.data)
                .then(sendResponse).catch(err => sendResponse({success: false, error: err.message}));
            isAsync = true;
            break;
        case 'save_packet_image':
            (async () => {
                const imageToSave = message.data?.image;
                if (!imageToSave || !imageToSave.id || !imageToSave.topic) {
                    sendResponse({ success: false, error: 'Invalid PacketImage object provided.'});
                    return;
                }
                try {
                    await storage.savePacketImage(imageToSave);
                    chrome.runtime.sendMessage({ action: 'packet_image_created', data: { image: imageToSave } });
                    sendResponse({ success: true, imageId: imageToSave.id });
                } catch (error) {
                    logger.error("MessageHandler:save_packet_image", "Failed to save image", error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            isAsync = true;
            break;
        case 'initiate_packet_creation_from_tab':
            (async () => {
                try {
                    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (!activeTab || typeof activeTab.id !== 'number') {
                        throw new Error("Could not find the current active tab.");
                    }
                    const result = await processCreatePacketRequestFromTab(activeTab.id);
                    sendResponse(result);
                } catch (err) {
                    logger.error("MessageHandler", "Error handling packet creation from tab", err);
                    sendResponse({ success: false, error: err.message });
                }
            })();
            isAsync = true;
            break;
        case 'initiate_packet_creation':
             processCreatePacketRequest(message.data, sender.tab?.id)
                .then(sendResponse).catch(err => sendResponse({success: false, error: err.message}));
            isAsync = true;
            break;
        case 'instantiate_packet':
            (async () => {
                const { imageId } = message.data;
                if (!imageId) {
                    sendResponse({ success: false, error: 'imageId is required to instantiate a packet.' });
                    return;
                }
                const newInstanceId = `inst_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
                const result = await instantiatePacket(imageId, newInstanceId, sender.tab?.id);
                if (result.success) {
                    chrome.runtime.sendMessage({ action: 'packet_instance_created', data: { instance: result.instance, source: 'inbox_start' } });
                }
                sendResponse(result);
            })();
            isAsync = true;
            break;
        case 'republish_page':
            processRepublishRequest(message.data, sender.tab?.id)
                 .then(sendResponse).catch(err => sendResponse({success: false, error: err.message}));
            isAsync = true;
            break;
        case 'delete_packets':
            processDeletePacketsRequest(message.data, sender.tab?.id)
                 .then(sendResponse).catch(err => sendResponse({success: false, error: err.message}));
            isAsync = true;
            break;
        case 'mark_url_visited': handleMarkUrlVisited(message.data, sendResponse); isAsync = true; break;
        case "open_content": handleOpenContent(message.data, sender, sendResponse); isAsync = true; break;
        case "get_context_for_tab": handleGetContextForTab(message.data, sender, sendResponse); isAsync = true; break;
        case "get_current_tab_context": handleGetCurrentTabContext(message.data, sender, sendResponse); isAsync = true; break;
        case "remove_tab_groups":
            (async () => {
                if (!(await shouldUseTabGroups())) sendResponse({ success: false, error: 'Tab Groups feature is disabled.' });
                else tabGroupHandler.handleRemoveTabGroups(message.data, sendResponse);
            })();
            isAsync = true; break;
        case "focus_tab_group":
            (async () => {
                if (!(await shouldUseTabGroups())) sendResponse({ success: false, error: 'Tab Groups feature is disabled.' });
                else tabGroupHandler.handleFocusTabGroup(message.data).then(sendResponse);
            })();
            isAsync = true; break;
        case 'page_interaction_complete':
            (async () => {
                if (!sender.tab || typeof sender.tab.id !== 'number') {
                    sendResponse({ success: false, error: 'Message must be sent from a tab.' });
                    return;
                }
                const tabId = sender.tab.id;
                const context = await getPacketContext(tabId);

                if (!context || !context.instanceId || !context.packetUrl) {
                    sendResponse({ success: false, error: 'No packet context found for this tab.' });
                    return;
                }

                const { instanceId, packetUrl } = context;
                logger.log('MessageHandler', `Received 'page_interaction_complete' from tab ${tabId}`, { context });
                
                const visitResult = await packetUtils.markUrlAsVisited(instanceId, packetUrl);

                if (visitResult.success && visitResult.modified) {
                    const updatedInstance = visitResult.instance || await storage.getPacketInstance(instanceId);
                    if (updatedInstance) {
                        sidebarHandler.notifySidebar('packet_instance_updated', { instance: updatedInstance, source: 'page_interaction_complete' });
                        await checkAndPromptForCompletion('MessageHandler:page_interaction_complete', visitResult, instanceId);
                    }
                }
                sendResponse({ success: visitResult.success, error: visitResult.error });
            })();
            isAsync = true;
            break;
        case "reorder_packet_tabs":
             handleReorderPacketTabs(message.data, sendResponse); isAsync = true; break;
        case "reorder_all_tabs":
            (async () => {
                if (!(await shouldUseTabGroups())) sendResponse({ success: false, error: 'Tab Groups feature is disabled.' });
                else tabGroupHandler.handleReorderAllTabs(sendResponse);
            })();
            isAsync = true; break;
        case 'theme_preference_updated':
             try { chrome.runtime.sendMessage({ action: 'theme_preference_updated', data: {} }); } catch(e){ /* ignore */ }
             break;
        case 'sidebar_ready':
            handleSidebarReady(sender, sendResponse);
            isAsync = true;
            break;
        case 'prepare_sidebar_navigation':
            const targetView = message.data?.targetView;
            if (targetView) {
                 logger.log('MessageHandler', `Storing pending sidebar view: ${targetView}`);
                 storage.setSession({ [PENDING_VIEW_KEY]: targetView })
                      .then(success => sendResponse({ success }))
                      .catch(err => {
                           logger.error('MessageHandler', 'Failed to set session storage for pending view', err);
                           sendResponse({ success: false, error: err.message });
                      });
                 isAsync = true;
            } else {
                 logger.warn('MessageHandler', 'Missing targetView for prepare_sidebar_navigation');
                 sendResponse({ success: false, error: 'Missing targetView in data' });
            }
            break;
        case 'publish_image_for_sharing':
             publishImageForSharing(message.data?.imageId)
                 .then(sendResponse).catch(err => sendResponse({success: false, error: err.message}));
            isAsync = true;
            break;
        case 'import_image_from_url':
             importImageFromUrl(message.data?.url)
                 .then(sendResponse).catch(err => sendResponse({success: false, error: err.message}));
             isAsync = true;
            break;
        default:
            logger.log('MessageHandler', 'Unknown action received', message.action);
            sendResponse({success: false, error: `Unknown action: ${message.action}`})
            break;
    }
    return isAsync;
}