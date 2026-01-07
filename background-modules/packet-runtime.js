// ext/background-modules/packet-runtime.js
// REVISED: Updated to await arrayBufferToBase64 for memory safety when opening PDFs.

import {
    logger,
    storage,
    packetUtils,
    shouldUseTabGroups,
    getPacketContext,
    setPacketContext,
    clearPacketContext,
    arrayBufferToBase64,
    indexedDbStorage,
    sanitizeForFileName
} from '../utils.js';
import * as tabGroupHandler from './tab-group-handler.js';
import * as ruleManager from './rule-manager.js';
import cloudStorage from '../cloud-storage.js';
import { startVisitTimer } from './navigation-handler.js';
import * as sidebarHandler from './sidebar-handler.js';
import { activeMediaPlayback, setupOffscreenDocument } from '../background.js';

const openingContent = new Set();

class PacketRuntime {
    constructor(instance) {
        if (!instance || !instance.instanceId) {
            throw new Error("Cannot instantiate PacketRuntime without a valid instance object.");
        }
        this.instance = instance;
        this.orderedContent = instance.contents || [];
        this.logPrefix = `[PacketRuntime Instance ${this.instance.instanceId}]`;
    }

    async start() {
        if (this.instance.completed) {
            logger.log(this.logPrefix, 'Packet already completed. Skipping agent execution.');
            return;
        }

        await ruleManager.addOrUpdatePacketRules(this.instance);

        // Check for JS Module Agents (Pre-transpiled)
        const moduleItem = this.orderedContent.find(item => item.format === 'module');
        if (moduleItem) {
            logger.log(this.logPrefix, 'Found JS Module Agent, initializing...', moduleItem);
            try {
                await setupOffscreenDocument();
                let agentCode = moduleItem.content || '';

                // If content is base64 (unlikely for module but possible if generic), decode it?
                // But typically 'module' format implies text content in 'content' field.
                // If it uses contentB64, we decode.
                if (!agentCode && moduleItem.contentB64) {
                    const bin = Uint8Array.from(atob(moduleItem.contentB64), c => c.charCodeAt(0));
                    agentCode = new TextDecoder().decode(bin);
                }

                if (agentCode) {
                    chrome.runtime.sendMessage({
                        target: 'offscreen',
                        type: 'execute_js_agent',
                        data: {
                            instanceId: this.instance.instanceId,
                            code: agentCode,
                            args: { code: 'init' }
                        }
                    });
                }
            } catch (e) {
                logger.error(this.logPrefix, 'Failed to launch JS Agent:', e);
            }
            return;
        }

        // Check for Wasm Agents to execute
        const wasmItem = this.orderedContent.find(item => item.format === 'wasm');
        if (wasmItem) {
            // [Compatibility Check]
            // Default to 'v1' if not specified. Current runtime supports 'v1'.
            // In the future, this list will grow: ['v1', 'v2', 'v3']
            const SUPPORTED_WORLDS = ['v1'];
            const packetWorldVersion = wasmItem.worldVersion || 'v1';

            if (!SUPPORTED_WORLDS.includes(packetWorldVersion)) {
                logger.warn(this.logPrefix, `Packet requires world '${packetWorldVersion}' but extension supports [${SUPPORTED_WORLDS.join(', ')}].`);
                // TODO: Show a user-facing notification "Update Extension to run this packet"
                // For now, we log and skip to prevent crash.
                return;
            }

            logger.log(this.logPrefix, 'Found Wasm Packet Module, initializing...', wasmItem);
            try {
                // Ensure offscreen is ready
                await setupOffscreenDocument();

                let agentUrl;
                let isBlob = false;

                // 1. Try to load from IndexedDB (Embedded Content)
                if (wasmItem.origin === 'internal' && wasmItem.lrl) {
                    const cachedContent = await indexedDbStorage.getGeneratedContent(this.instance.instanceId, sanitizeForFileName(wasmItem.lrl));
                    if (cachedContent && cachedContent[0]?.content) {
                        logger.log(this.logPrefix, 'Loading Raw Wasm from IndexedDB cache...');
                        const contentB64 = await arrayBufferToBase64(cachedContent[0].content);

                        // Pass B64 directly to offscreen (JCO is there)
                        agentUrl = contentB64;
                        isBlob = false; // It's raw data
                    } else {
                        // Extension asset
                        const response = await fetch(chrome.runtime.getURL(wasmItem.lrl));
                        const buffer = await response.arrayBuffer();
                        agentUrl = await arrayBufferToBase64(buffer);
                    }
                } else if (wasmItem.url) {
                    // External URL - fetch it
                    const response = await fetch(wasmItem.url);
                    const buffer = await response.arrayBuffer();
                    agentUrl = await arrayBufferToBase64(buffer);
                }

                if (agentUrl) {
                    logger.log(this.logPrefix, 'Transpiling and Executing w/ Universal Loader...');
                    // Send directly to Offscreen (which now hosts the Compiler)
                    chrome.runtime.sendMessage({
                        target: 'offscreen',
                        type: 'execute_raw_wasm',
                        data: {
                            instanceId: this.instance.instanceId,
                            wasmB64: agentUrl,
                            args: { code: 'init' } // Optional init args
                        }
                    }, (response) => {
                        if (chrome.runtime.lastError) {
                            logger.error(this.logPrefix, 'Message Error (offscreen):', chrome.runtime.lastError.message);
                            return;
                        }
                        if (!response) {
                            logger.error(this.logPrefix, 'Failed to start Wasm Agent: No response received (undefined).');
                            return;
                        }
                        if (!response.success) {
                            logger.error(this.logPrefix, 'Failed to start Wasm Agent:', response.error || 'Unknown Error');
                        } else {
                            logger.log(this.logPrefix, 'Wasm Agent started successfully.');
                        }
                    });
                }
            } catch (err) {
                logger.error(this.logPrefix, 'Error executing Wasm packet:', err);
            }
        }
    }

    async reconcileTab(tabId, url, details) {
        logger.log(this.logPrefix, `Reconciling navigation for tab ${tabId} to url: ${url}`);

        const currentContext = await getPacketContext(tabId);

        // --- STRICT CONTEXT CHECK ---
        // If the tab is not already associated with this packet instance, ignore it.
        if (!currentContext || currentContext.instanceId !== this.instance.instanceId) {
            return;
        }

        // Check if the new URL is a defined item in this packet
        const newItemInPacket = packetUtils.isUrlInPacket(url, this.instance, { returnItem: true });

        const gracePeriodKey = `grace_period_${tabId}`;
        const graceData = await storage.getSession(gracePeriodKey);
        const gracePeriodStart = graceData ? graceData[gracePeriodKey] : null;
        let inGracePeriod = false;

        if (gracePeriodStart) {
            const GRACE_PERIOD_MS = 1500;
            if (Date.now() - gracePeriodStart < GRACE_PERIOD_MS) {
                inGracePeriod = true;
            } else {
                await storage.removeSession(gracePeriodKey);
            }
        }

        const isRedirect = details.transitionQualifiers?.includes('server_redirect') || details.transitionQualifiers?.includes('client_redirect');

        if (newItemInPacket) {
            // Case 1: User navigated to another valid item within the packet.
            if (newItemInPacket.url !== currentContext.canonicalPacketUrl) {
                // Check for duplicates in other tabs and squash them if necessary
                const allTabs = await chrome.tabs.query({});
                for (const tab of allTabs) {
                    if (tab.id !== tabId) {
                        const otherContext = await getPacketContext(tab.id);
                        if (otherContext?.instanceId === this.instance.instanceId && otherContext?.canonicalPacketUrl === newItemInPacket.url) {
                            try { await chrome.tabs.remove(tab.id); } catch (e) { }
                            break;
                        }
                    }
                }
            }
            await setPacketContext(tabId, this.instance.instanceId, newItemInPacket.url, url);
            if (inGracePeriod) { await storage.removeSession(gracePeriodKey); }

        } else if (isRedirect) {
            // Case 2: The page redirected. Keep context.
            logger.log(this.logPrefix, `Redirect detected for tab ${tabId}. Preserving context.`);
            await setPacketContext(tabId, currentContext.instanceId, currentContext.canonicalPacketUrl, url);

        } else if (!inGracePeriod) {
            // Case 3: User left the packet.
            logger.log(this.logPrefix, `Tab ${tabId} navigated outside the packet. Clearing context.`);
            await clearPacketContext(tabId);
            if (await shouldUseTabGroups()) {
                await tabGroupHandler.ejectTabFromGroup(tabId, this.instance.instanceId);
            }
        }

        // If we still have a valid context, ensure state is consistent
        const finalContext = await getPacketContext(tabId);
        if (finalContext) {
            // Refresh grace period for subsequent fast navigations
            await storage.setSession({ [gracePeriodKey]: Date.now() });
            setTimeout(() => storage.removeSession(gracePeriodKey), 1500);

            await this._updateBrowserState(tabId, url);

            const itemForVisitTimer = this.orderedContent.find(i => i.url === finalContext.canonicalPacketUrl);
            // [FIX] Wasm/Module agents manage their own completion via Quest API.
            // Do NOT start visit timer for them.
            if (itemForVisitTimer && !itemForVisitTimer.interactionBasedCompletion && itemForVisitTimer.format !== 'wasm' && itemForVisitTimer.format !== 'module') {
                startVisitTimer(tabId, this.instance.instanceId, itemForVisitTimer.url, this.logPrefix);
            }

            // Handle "Moments" (triggers based on visiting specific pages)
            if (itemForVisitTimer) {
                let momentTripped = false;
                // Use either LRL or URL to identify the item for moment checking.
                const itemIdentifier = itemForVisitTimer.lrl || itemForVisitTimer.url;

                (this.instance.moments || []).forEach((moment, index) => {
                    if (moment.type === 'visit' && moment.sourceUrl === itemIdentifier && this.instance.momentsTripped[index] === 0) {
                        this.instance.momentsTripped[index] = 1;
                        momentTripped = true;
                    }
                });

                if (momentTripped) {
                    await storage.savePacketInstance(this.instance);
                    if (activeMediaPlayback.instanceId === this.instance.instanceId) {
                        activeMediaPlayback.instance = this.instance;
                    }
                    sidebarHandler.notifySidebar('packet_instance_updated', {
                        instance: this.instance,
                        source: 'moment_tripped'
                    });
                }
            }
        }
    }

    async openOrFocusContent(targetUrl) {
        // Ensure grouping is active since the user explicitly requested this content
        await tabGroupHandler.reactivateGroup(this.instance.instanceId);

        if (openingContent.has(targetUrl)) { return { success: true, message: 'Open already in progress.' }; }
        openingContent.add(targetUrl);
        try {
            // 1. Try to find an existing tab with this context
            const allTabs = await chrome.tabs.query({});
            for (const tab of allTabs) {
                const context = await getPacketContext(tab.id);
                if (context && context.instanceId === this.instance.instanceId && context.canonicalPacketUrl === targetUrl) {
                    await chrome.tabs.update(tab.id, { active: true });
                    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
                    return { success: true, message: 'Focused existing tab.' };
                }
            }

            // 2. If not found, prepare to open a new one
            const contentItem = this.orderedContent.find(item => item.url === targetUrl);
            if (!contentItem) throw new Error(`Content item not found for URL: ${targetUrl}`);

            let finalUrlToOpen;
            if (contentItem.format === 'pdf' && contentItem.origin === 'internal' && contentItem.lrl) {
                const cachedContent = await indexedDbStorage.getGeneratedContent(this.instance.instanceId, sanitizeForFileName(contentItem.lrl));
                if (!cachedContent || !cachedContent[0]?.content) throw new Error(`PDF content for ${contentItem.lrl} is not cached.`);

                // [FIX] Await the async conversion
                const contentB64 = await arrayBufferToBase64(cachedContent[0].content);

                await setupOffscreenDocument();
                const offscreenResponse = await chrome.runtime.sendMessage({
                    target: 'offscreen', type: 'create-blob-url-from-buffer',
                    data: { bufferB64: contentB64, type: 'application/pdf' }
                });
                if (!offscreenResponse?.success) throw new Error(offscreenResponse.error || 'Failed to create blob URL.');
                finalUrlToOpen = offscreenResponse.blobUrl;
            } else if (contentItem.origin === 'internal' && contentItem.publishContext) {
                finalUrlToOpen = cloudStorage.constructPublicUrl(targetUrl, contentItem.publishContext);
            } else {
                finalUrlToOpen = targetUrl;
            }

            // 3. Create the tab and set the "Trusted Intent"
            const newTab = await chrome.tabs.create({ url: finalUrlToOpen, active: true });
            const trustedIntent = {
                instanceId: this.instance.instanceId,
                canonicalPacketUrl: targetUrl
            };
            await storage.setSession({ [`trusted_intent_${newTab.id}`]: trustedIntent });

            return { success: true, tabId: newTab.id };
        } catch (error) {
            return { success: false, error: error.message };
        } finally {
            openingContent.delete(targetUrl);
        }
    }

    async delete() {
        const browserState = await storage.getPacketBrowserState(this.instance.instanceId);
        if (browserState?.tabGroupId) {
            await tabGroupHandler.handleRemoveTabGroups({ groupIds: [browserState.tabGroupId] }, () => { });
        }
        await ruleManager.removePacketRules(this.instance.instanceId);
        if (await cloudStorage.initialize()) {
            for (const item of this.orderedContent) {
                if (item.origin === 'internal' && item.published && item.url) {
                    await cloudStorage.deleteFile(item.url).catch(e => { });
                }
            }
        }
        await storage.deletePacketBrowserState(this.instance.instanceId);
    }

    async sendNavigationEvent(url) {
        // Only valid if we have a Wasm/JS agent running
        const agentItem = this.orderedContent.find(item => item.format === 'wasm' || item.format === 'module');
        if (!agentItem) return;

        logger.log(this.logPrefix, `Dispatching Navigation Event to Agent: ${url}`);

        chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'dispatch_navigate', // Handled by offscreen.js -> forwards to sandbox
            data: { url }
        }, (response) => {
            if (chrome.runtime.lastError) {
                // Ignore, offscreen might not be ready or agent not listening
            }
        });
    }

    async _updateBrowserState(tabId, currentUrl) {
        const browserState = await storage.getPacketBrowserState(this.instance.instanceId) || { instanceId: this.instance.instanceId, tabGroupId: null, activeTabIds: [], lastActiveUrl: null };
        let stateModified = false;
        if (browserState.lastActiveUrl !== currentUrl) {
            browserState.lastActiveUrl = currentUrl;
            stateModified = true;
        }
        if (!browserState.activeTabIds.includes(tabId)) {
            browserState.activeTabIds.push(tabId);
            stateModified = true;
        }
        if (await shouldUseTabGroups()) {
            const ensuredGroupId = await tabGroupHandler.ensureTabInGroup(tabId, this.instance);
            if (ensuredGroupId !== null && browserState.tabGroupId !== ensuredGroupId) {
                browserState.tabGroupId = ensuredGroupId;
                stateModified = true;
            }
            if (browserState.tabGroupId) {
                await tabGroupHandler.orderTabsInGroup(browserState.tabGroupId, this.instance);
            }
        }
        if (stateModified) {
            await storage.savePacketBrowserState(browserState);
            // Notify the agent about the navigation/state update
            this.sendNavigationEvent(currentUrl);
        }
    }
}

export default PacketRuntime;