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
        const newItemInPacket = packetUtils.isUrlInPacket(url, this.instance, { returnItem: true });
        
        if (newItemInPacket) {
            // If we found a match, capture any variables.
            if (newItemInPacket.capturedParams) {
                if (!this.instance.variables) this.instance.variables = {};
                Object.assign(this.instance.variables, newItemInPacket.capturedParams);
                await storage.savePacketInstance(this.instance);
            }

            // The canonical URL is always the template from the definition.
            const canonicalUrl = newItemInPacket.url || newItemInPacket.lrl;

            // Squash duplicate tabs by checking for the CANONICAL url.
            const allTabs = await chrome.tabs.query({});
            for (const tab of allTabs) {
                if (tab.id !== tabId) {
                    const otherContext = await getPacketContext(tab.id);
                    if (otherContext?.instanceId === this.instance.instanceId && otherContext?.canonicalPacketUrl === canonicalUrl) {
                        try { await chrome.tabs.remove(tab.id); } catch (e) {}
                        break; 
                    }
                }
            }
            
            // Set the context with the canonical URL.
            await setPacketContext(tabId, this.instance.instanceId, canonicalUrl, url);
            
            // Trigger visit timer with the canonical URL.
            startVisitTimer(tabId, this.instance.instanceId, canonicalUrl, this.logPrefix);
            
            // --- START OF FIX ---
            // This was the missing piece. We need to update the browser state
            // (which includes creating the tab group) whenever we reconcile a tab.
            await this._updateBrowserState(tabId, canonicalUrl);
            // --- END OF FIX ---

        } else {
            // If no match, check if we're in a grace period (from a redirect).
            const gracePeriodKey = `grace_period_${tabId}`;
            const graceData = await storage.getSession(gracePeriodKey);
            if (!graceData[gracePeriodKey]) {
                // No grace period, so clear the context.
                await clearPacketContext(tabId);
            }
        }
        // Set a brief grace period to handle redirects.
        const gracePeriodKey = `grace_period_${tabId}`;
        await storage.setSession({ [gracePeriodKey]: Date.now() });
        setTimeout(() => storage.removeSession(gracePeriodKey), 250);
    }
    
    async openOrFocusContent(targetUrl) {
        // Find an open tab by checking if its CURRENT BROWSER URL matches the RENDERED target URL.
        const renderedTargetUrl = packetUtils.renderPacketUrl(targetUrl, this.instance.variables);
        const allTabs = await chrome.tabs.query({});
        for (const tab of allTabs) {
            const context = await getPacketContext(tab.id);
            if (context && context.instanceId === this.instance.instanceId && context.currentBrowserUrl === renderedTargetUrl) {
                await chrome.tabs.update(tab.id, { active: true });
                if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
                return { success: true, message: 'Focused existing tab.' };
            }
        }

        // If no tab is found, create a new one with the rendered URL.
        const newTab = await chrome.tabs.create({ url: renderedTargetUrl, active: true });
        
        // Set a trusted intent using the CANONICAL (template) URL.
        const trustedIntent = {
            instanceId: this.instance.instanceId,
            canonicalPacketUrl: targetUrl
        };
        await storage.setSession({ [`trusted_intent_${newTab.id}`]: trustedIntent });
        return { success: true, tabId: newTab.id };
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