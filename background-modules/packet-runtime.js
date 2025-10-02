// ext/background-modules/packet-runtime.js
// FINAL FIX: The reconcileTab method has been corrected to intelligently update
// the canonicalPacketUrl even during a grace period. This ensures that navigations
// originating from within a packet (like a summary page) that lead to another
// packet item correctly transition the context, allowing the duplicate-squashing
// logic to function as intended.

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
        await ruleManager.addOrUpdatePacketRules(this.instance);
    }

   async reconcileTab(tabId, url, details) {
        console.log(`[DEBUG_LOG 1/3] reconcileTab START for url: ${url}`, {
            tabId: tabId,
            transitionType: details.transitionType,
            transitionQualifiers: details.transitionQualifiers
        });

        logger.log(this.logPrefix, `Reconciling navigation for tab ${tabId} to url: ${url}`);
        let currentContext = await getPacketContext(tabId);
        const newItemInPacket = packetUtils.isUrlInPacket(url, this.instance, { returnItem: true });

        if (!currentContext || currentContext.instanceId !== this.instance.instanceId) {
            const isUserInitiated = ['link', 'typed', 'form_submit', 'reload'].includes(details.transitionType);
            if (newItemInPacket && isUserInitiated) {
                logger.log(this.logPrefix, `Adopting tab ${tabId} into packet.`);
                const canonicalIdentifier = newItemInPacket.url || newItemInPacket.lrl;
                await setPacketContext(tabId, this.instance.instanceId, canonicalIdentifier, url);
                currentContext = await getPacketContext(tabId);
            } else {
                console.log(`[DEBUG_LOG 2/3] reconcileTab DECISION: No current context and not a user-initiated navigation into the packet. Bailing out.`);
                return;
            }
        }
        
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

        console.log(`[DEBUG_LOG 2/3] reconcileTab STATE`, {
            currentContext: currentContext,
            newItemInPacket: newItemInPacket ? (newItemInPacket.url || newItemInPacket.lrl) : null,
            inGracePeriod: inGracePeriod,
            isRedirect: isRedirect,
        });

        if (newItemInPacket) {
            const canonicalIdentifier = newItemInPacket.url || newItemInPacket.lrl;
            if (canonicalIdentifier !== currentContext.canonicalPacketUrl) {
                const allTabs = await chrome.tabs.query({});
                for (const tab of allTabs) {
                    if (tab.id !== tabId) {
                        const otherContext = await getPacketContext(tab.id);
                        if (otherContext?.instanceId === this.instance.instanceId && otherContext?.canonicalPacketUrl === canonicalIdentifier) {
                            logger.log(this.logPrefix, `Found duplicate tab ${tab.id} for "${newItemInPacket.title}". Squashing it.`);
                            try { await chrome.tabs.remove(tab.id); } catch (e) {}
                            break; 
                        }
                    }
                }
            }
            console.log(`[DEBUG_LOG 3/3] reconcileTab DECISION: Stamping context because newItemInPacket is TRUE. Canonical ID: ${canonicalIdentifier}`);
            await setPacketContext(tabId, this.instance.instanceId, canonicalIdentifier, url);
            if (inGracePeriod) { await storage.removeSession(gracePeriodKey); } 

        } else if (isRedirect) {
            logger.log(this.logPrefix, `Redirect detected for tab ${tabId}. Preserving context and updating browser URL.`);
            if (currentContext) {
                console.log(`[DEBUG_LOG 3/3] reconcileTab DECISION: Preserving context because isRedirect is TRUE.`);
                await setPacketContext(tabId, currentContext.instanceId, currentContext.canonicalPacketUrl, url);
            }
        } else if (!inGracePeriod) {
            logger.log(this.logPrefix, `Tab ${tabId} navigated outside the packet. Clearing context.`);
            console.log(`[DEBUG_LOG 3/3] reconcileTab DECISION: Clearing context because newItemInPacket is FALSE and not in grace period.`);
            await clearPacketContext(tabId);
            if (await shouldUseTabGroups()) {
                await tabGroupHandler.ejectTabFromGroup(tabId, this.instance.instanceId);
            }
        } else {
             console.log(`[DEBUG_LOG 3/3] reconcileTab DECISION: No action taken. In grace period but not a redirect or a new packet item.`);
        }

        const finalContext = await getPacketContext(tabId);
        if (finalContext) {
            const gracePeriodKey = `grace_period_${tabId}`;
            await storage.setSession({ [gracePeriodKey]: Date.now() });
            setTimeout(() => storage.removeSession(gracePeriodKey), 1500);

            await this._updateBrowserState(tabId, url);
            const itemForVisitTimer = this.orderedContent.find(i => i.url === finalContext.canonicalPacketUrl || i.lrl === finalContext.canonicalPacketUrl);
            if (itemForVisitTimer && !itemForVisitTimer.interactionBasedCompletion) {
                startVisitTimer(tabId, this.instance.instanceId, finalContext.canonicalPacketUrl, this.logPrefix);
            }

            let momentTripped = false;
            console.log(`[DEBUG_LOG 4/4] Checking for visit moments. Current canonical identifier: ${finalContext.canonicalPacketUrl}`);
            (this.instance.moments || []).forEach((moment, index) => {
                console.log(`[DEBUG_LOG 4/4]   - Comparing with moment #${index} (${moment.type}) for source: ${moment.sourceUrl}`);
                if (moment.type === 'visit' && moment.sourceUrl === finalContext.canonicalPacketUrl && (!this.instance.momentsTripped || this.instance.momentsTripped[index] === 0)) {
                    if (!this.instance.momentsTripped) {
                        this.instance.momentsTripped = Array((this.instance.moments || []).length).fill(0);
                    }
                    this.instance.momentsTripped[index] = 1;
                    momentTripped = true;
                    logger.log(this.logPrefix, `Tripped 'visit' moment for URL/LRL: ${moment.sourceUrl}`);
                }
            });

            if (momentTripped) {
                await storage.savePacketInstance(this.instance);
                if (activeMediaPlayback.instanceId === this.instance.instanceId) {
                    activeMediaPlayback.instance = this.instance;
                }
                sidebarHandler.notifySidebar('packet_instance_updated', {
                    instance: this.instance,
                    source: 'moment_trip'
                });
            }
        }
    }
    
    async openOrFocusContent(targetUrl) {
        if (openingContent.has(targetUrl)) { return { success: true, message: 'Open already in progress.' }; }
        openingContent.add(targetUrl);
        try {
            const allTabs = await chrome.tabs.query({});
            for (const tab of allTabs) {
                const context = await getPacketContext(tab.id);
                if (context && context.instanceId === this.instance.instanceId && context.canonicalPacketUrl === targetUrl) {
                    await chrome.tabs.update(tab.id, { active: true });
                    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
                    return { success: true, message: 'Focused existing tab.' };
                }
            }
            const contentItem = this.orderedContent.find(item => item.url === targetUrl || item.lrl === targetUrl);
            if (!contentItem) throw new Error(`Content item not found for URL/LRL: ${targetUrl}`);
            
            let finalUrlToOpen;
            const canonicalIdentifier = contentItem.url || contentItem.lrl;

            if (contentItem.format === 'pdf' && contentItem.origin === 'internal' && contentItem.lrl) {
                const cachedContent = await indexedDbStorage.getGeneratedContent(this.instance.instanceId, sanitizeForFileName(contentItem.lrl));
                if (!cachedContent || !cachedContent[0]?.content) throw new Error(`PDF content for ${contentItem.lrl} is not cached.`);
                const contentB64 = arrayBufferToBase64(cachedContent[0].content);
                await setupOffscreenDocument();
                const offscreenResponse = await chrome.runtime.sendMessage({
                    target: 'offscreen', type: 'create-blob-url-from-buffer',
                    data: { bufferB64: contentB64, type: 'application/pdf' }
                });
                if (!offscreenResponse?.success) throw new Error(offscreenResponse.error || 'Failed to create blob URL.');
                finalUrlToOpen = offscreenResponse.blobUrl;
            } else if (contentItem.origin === 'internal' && contentItem.publishContext) {
                finalUrlToOpen = cloudStorage.constructPublicUrl(canonicalIdentifier, contentItem.publishContext);
            } else {
                finalUrlToOpen = canonicalIdentifier;
            }
            const newTab = await chrome.tabs.create({ url: finalUrlToOpen, active: true });
            const trustedIntent = {
                instanceId: this.instance.instanceId,
                canonicalPacketUrl: canonicalIdentifier
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
            await tabGroupHandler.handleRemoveTabGroups({ groupIds: [browserState.tabGroupId] }, () => {});
        }
        await ruleManager.removePacketRules(this.instance.instanceId);
        if (await cloudStorage.initialize()) {
            for (const item of this.orderedContent) {
                if (item.origin === 'internal' && item.published && item.url) {
                    await cloudStorage.deleteFile(item.url).catch(e => {});
                }
            }
        }
        await storage.deletePacketBrowserState(this.instance.instanceId);
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
        }
    }
}

export default PacketRuntime;