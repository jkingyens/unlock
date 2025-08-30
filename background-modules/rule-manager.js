// ext/background-modules/rule-manager.js
// Manages redirect rules for the declarativeNetRequest API to handle private S3 content.
// REVISED: Implemented an integer-based hashing function for rule IDs to conform to the
// declarativeNetRequest API, which requires integer IDs >= 1.

import { logger, storage } from '../utils.js';
import cloudStorage from '../cloud-storage.js';

const RULE_ID_PREFIX = 'pkt_'; // No longer used in the ID itself, but good for context.
const RULE_PRIORITY = 1;

/**
 * Creates a deterministic 32-bit integer hash from a string.
 * This is used to generate a unique, stable integer ID for a rule.
 * @param {string} str The input string (e.g., "instanceId_pageId").
 * @returns {number} A positive integer hash of the string.
 */
function hashStringToInt(str) {
    let hash = 0;
    if (str.length === 0) return 1; // Return a default valid ID for empty string
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32bit integer
    }
    // The API requires the ID to be >= 1. We'll take the absolute value and add 1
    // to ensure the ID is always valid and positive.
    return Math.abs(hash) + 1;
}

/**
 * Generates a unique integer rule ID for a specific piece of generated content.
 * @param {string} instanceId - The ID of the packet instance.
 * @param {string} pageId - The pageId of the generated content.
 * @returns {number} The unique, positive integer rule ID.
 */
function getRuleId(instanceId, pageId) {
    const uniqueString = `${instanceId}_${pageId}`;
    return hashStringToInt(uniqueString);
}

/**
 * Gets all currently active redirect rules managed by this extension.
 * Uses session rules which are cleared on browser restart.
 * @returns {Promise<Array<chrome.declarativeNetRequest.Rule>>}
 */
async function getSessionRules() {
    try {
        return await chrome.declarativeNetRequest.getSessionRules();
    } catch (e) {
        logger.error('RuleManager:getSessionRules', 'Failed to get session rules.', e);
        return [];
    }
}

/**
 * Creates or updates all necessary redirect rules for a given packet instance.
 * It generates new pre-signed URLs for each generated content item and sets up
 * a redirect from the canonical, non-signed URL to the new pre-signed URL.
 *
 * @param {object} instance - The PacketInstance object.
 * @returns {Promise<{success: boolean, rulesCreated: number, error?: string}>}
 */
export async function addOrUpdatePacketRules(instance) {
    if (!instance || !instance.instanceId || !Array.isArray(instance.contents)) {
        logger.warn('RuleManager:addOrUpdate', 'Invalid or missing instance data provided.');
        return { success: false, rulesCreated: 0, error: 'Invalid instance data.' };
    }

    const privateContentItems = instance.contents.filter(item =>
        item.access === 'private' && item.published && item.url && item.pageId && item.publishContext
    );

    if (privateContentItems.length === 0) {
        logger.log('RuleManager:addOrUpdate', `No published private content with context to create rules for in instance ${instance.instanceId}.`);
        await removePacketRules(instance.instanceId);
        return { success: true, rulesCreated: 0 };
    }

    const newRules = [];
    const ruleIdsToRemove = [];

    for (const item of privateContentItems) {
        ruleIdsToRemove.push(getRuleId(instance.instanceId, item.pageId));
    }

    for (const item of privateContentItems) {
        const s3Key = item.url;
        const canonicalUrl = cloudStorage.constructPublicUrl(s3Key, item.publishContext);
        if (!canonicalUrl) {
            logger.warn('RuleManager:addOrUpdate', `Could not get canonical URL for S3 key: ${s3Key}. Skipping rule creation.`);
            continue;
        }

        let presignedUrl;
        // If the page requires an interaction event, inject the extensionId as a signed query parameter.
        if (item.interactionBasedCompletion === true) {
            const extraParams = { extensionId: chrome.runtime.id };
            presignedUrl = await cloudStorage.generatePresignedGetUrl(s3Key, 3600, item.publishContext, extraParams);
        } else {
            presignedUrl = await cloudStorage.generatePresignedGetUrl(s3Key, 3600, item.publishContext);
        }

        if (!presignedUrl) {
            logger.warn('RuleManager:addOrUpdate', `Failed to generate pre-signed URL for S3 key: ${s3Key}. Skipping rule creation.`);
            continue;
        }

        const newRule = {
            id: getRuleId(instance.instanceId, item.pageId),
            priority: RULE_PRIORITY,
            action: {
                type: 'redirect',
                redirect: { url: presignedUrl }
            },
            condition: {
                urlFilter: canonicalUrl.split('?')[0],
                resourceTypes: ['main_frame']
            }
        };
        newRules.push(newRule);
    }

    try {
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: ruleIdsToRemove,
            addRules: newRules
        });
        logger.log('RuleManager:addOrUpdate', `Successfully updated ${newRules.length} rules for instance ${instance.instanceId}.`);
        return { success: true, rulesCreated: newRules.length };
    } catch (e) {
        logger.error('RuleManager:addOrUpdate', 'Failed to update session rules.', { instanceId: instance.instanceId, error: e });
        return { success: false, rulesCreated: 0, error: e.message };
    }
}

/**
 * Removes all redirect rules associated with a specific packet instance.
 * @param {string} instanceId - The ID of the packet instance to remove rules for.
 * @returns {Promise<{success: boolean, rulesRemoved: number}>}
 */
export async function removePacketRules(instanceId) {
    if (!instanceId) return { success: false, rulesRemoved: 0 };
    const instance = await storage.getPacketInstance(instanceId);
    const ruleIdsToRemove = [];
    if (instance && instance.contents) {
        instance.contents.forEach(item => {
            if (item.access === 'private' && item.pageId) {
                ruleIdsToRemove.push(getRuleId(instanceId, item.pageId));
            }
        });
    }

    if (ruleIdsToRemove.length === 0) {
        logger.log('RuleManager:remove', `No rules to remove for instance ${instanceId} (or instance not found).`);
        return { success: true, rulesRemoved: 0 };
    }

    try {
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: ruleIdsToRemove
        });
        logger.log('RuleManager:remove', `Successfully removed ${ruleIdsToRemove.length} rules for instance ${instanceId}.`);
        return { success: true, rulesRemoved: ruleIdsToRemove.length };
    } catch (e) {
        logger.error('RuleManager:remove', 'Failed to remove session rules.', { instanceId, error: e });
        return { success: false, rulesRemoved: 0, error: e.message };
    }
}

/**
 * Refreshes redirect rules for all existing packet instances.
 * This is intended to be called periodically by an alarm to handle expiring pre-signed URLs.
 * It also cleans up any orphaned rules for instances that no longer exist.
 * @returns {Promise<void>}
 */
export async function refreshAllRules() {
    logger.log('RuleManager:refreshAll', 'Starting periodic refresh of all redirect rules...');
    try {
        const [allInstances, existingRules] = await Promise.all([
            storage.getPacketInstances(),
            getSessionRules()
        ]);
        const allInstanceIds = new Set(Object.keys(allInstances));
        const ruleIdsForExistingInstances = new Set();

        // 1. Refresh rules for all existing instances and collect their rule IDs
        for (const instanceId in allInstances) {
            await addOrUpdatePacketRules(allInstances[instanceId]);
            allInstances[instanceId].contents.forEach(item => {
                if(item.access === 'private' && item.pageId) {
                    ruleIdsForExistingInstances.add(getRuleId(instanceId, item.pageId));
                }
            });
        }

        // 2. Clean up orphaned rules
        const orphanedRuleIds = existingRules
            .map(rule => rule.id)
            .filter(id => !ruleIdsForExistingInstances.has(id));

        if (orphanedRuleIds.length > 0) {
            logger.log('RuleManager:refreshAll', `Found ${orphanedRuleIds.length} orphaned rules to remove.`);
            await chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: orphanedRuleIds
            });
        }
        logger.log('RuleManager:refreshAll', 'Rule refresh process complete.');
    } catch (error) {
        logger.error('RuleManager:refreshAll', 'Critical error during rule refresh process.', error);
    }
}