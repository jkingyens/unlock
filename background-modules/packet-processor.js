// ext/background-modules/packet-processor.js
// Manages the data lifecycle of packet instances. This module is now refactored
// to delegate all browser-state management (rules, tabs) to the new
// PacketRuntime API, focusing solely on data creation, cloud interaction, and deletion from storage.
// REVISED: Updated to await arrayBufferToBase64 for memory safety.

import {
    logger,
    storage,
    indexedDbStorage,
    arrayBufferToBase64,
    base64Decode,
    sanitizeForFileName,
} from '../utils.js';
import cloudStorage from '../cloud-storage.js';
import PacketRuntime from './packet-runtime.js'; 
import * as sidebarHandler from './sidebar-handler.js'; 
import * as ruleManager from './rule-manager.js'; // Ensure ruleManager is imported for delete cleanup

// --- Helper to send progress notifications ---
function sendProgressNotification(action, data) {
    sidebarHandler.notifySidebar(action, data);
}

function sendInstantiationProgress(instanceId, progress, text, title) {
    const data = {
        instanceId: instanceId,
        progressPercent: progress,
        text: text,
        title: title
    };
    sendProgressNotification('packet_instantiation_progress', data);
}


// --- Main Processing Functions ---

export async function instantiatePacket(imageId, preGeneratedInstanceId, initiatorTabId = null) {
    const instanceId = preGeneratedInstanceId;
    logger.log('PacketProcessor:instantiatePacket', 'Starting INSTANCE data creation', { imageId, instanceId });

    try {
        const [packetImage, settings] = await Promise.all([
            storage.getPacketImage(imageId),
            storage.getSettings()
        ]);

        if (!packetImage) throw new Error(`Packet Image ${imageId} not found.`);

        sendInstantiationProgress(instanceId, 5, "Preparing...", packetImage.title);

        if (settings.quickCopyEnabled) {
            const internalContentToCopy = packetImage.sourceContent.filter(item => item.origin === 'internal');
            for (const item of internalContentToCopy) {
                if (!item.lrl) continue;
                const sourceDbKey = sanitizeForFileName(item.lrl);
                const sourceContent = await indexedDbStorage.getGeneratedContent(imageId, sourceDbKey);
                if (sourceContent) {
                    await indexedDbStorage.saveGeneratedContent(instanceId, sourceDbKey, sourceContent);
                }
            }
        }

        const internalContentToUpload = packetImage.sourceContent.filter(item => item.origin === 'internal' && item.format !== 'interactive-input');
        const totalFilesToUpload = internalContentToUpload.length;
        let filesUploaded = 0;
        let activeCloudConfig = null;

        if (totalFilesToUpload > 0) {
            activeCloudConfig = await storage.getActiveCloudStorageConfig();
            if (!activeCloudConfig) throw new Error("Packet requires content publishing, but no cloud storage is configured.");
            if (!(await cloudStorage.initialize())) throw new Error("Cloud storage failed to initialize for publishing.");
        }

        sendInstantiationProgress(instanceId, 10, "Configuration checked", packetImage.title);

        const packetInstanceContents = JSON.parse(JSON.stringify(packetImage.sourceContent));
        
        for (const item of packetInstanceContents) {
            if (item.origin === 'internal') {
                if (item.format === 'interactive-input') {
                    continue;
                }

                const lrl = item.lrl;
                if (!lrl) continue;
                
                const indexedDbKey = sanitizeForFileName(lrl);
                const contentSourceId = settings.quickCopyEnabled ? instanceId : imageId;
                const storedContent = await indexedDbStorage.getGeneratedContent(contentSourceId, indexedDbKey);
                
                if (!storedContent || !storedContent[0]?.content) {
                    throw new Error(`Cannot instantiate: Content for ${lrl} is missing.`);
                }

                const contentToUpload = storedContent[0].content;
                let contentType = storedContent[0]?.contentType || item.contentType || item.mimeType || 'application/octet-stream';
                const cloudPath = `packets/${instanceId}${lrl.startsWith('/') ? lrl : '/' + lrl}`;
                const uploadResult = await cloudStorage.uploadFile(cloudPath, contentToUpload, contentType, 'private');
                
                if (uploadResult.success) {
                    filesUploaded++;
                    const progress = 10 + Math.round((filesUploaded / totalFilesToUpload) * 85);
                    sendInstantiationProgress(instanceId, progress, `Uploading ${filesUploaded}/${totalFilesToUpload}...`, packetImage.title);

                    item.url = uploadResult.fileName; 
                    item.published = true;
                    item.publishContext = {
                        storageConfigId: activeCloudConfig.id,
                        provider: activeCloudConfig.provider,
                        region: activeCloudConfig.region,
                        bucket: activeCloudConfig.bucket
                    };
                } else {
                    throw new Error(`Failed to publish ${lrl}: ${uploadResult.error}`);
                }
            }
        }

        const validUrls = new Set(packetInstanceContents.map(item => item.url).filter(Boolean));
        const validLrls = new Set(packetInstanceContents.map(item => item.lrl).filter(Boolean));
        
        const filteredMoments = (packetImage.moments || []).filter(moment => 
            moment.sourceUrl.startsWith('/') ? validLrls.has(moment.sourceUrl) : validUrls.has(moment.sourceUrl)
        );
        const filteredCheckpoints = (packetImage.checkpoints || []).filter(checkpoint => checkpoint.requiredItems.every(item => validUrls.has(item.url)));
        
        const packetInstance = {
            instanceId: instanceId,
            imageId: imageId,
            title: packetImage.title,
            created: packetImage.created,
            instantiated: new Date().toISOString(),
            contents: packetInstanceContents,
            visitedUrls: [],
            moments: filteredMoments,
            momentsTripped: Array(filteredMoments.length).fill(0),
            checkpoints: filteredCheckpoints,
            checkpointsTripped: Array(filteredCheckpoints.length).fill(0)
        };

        await storage.savePacketInstance(packetInstance);
        
        const runtime = new PacketRuntime(packetInstance);
        await runtime.start();
        
        sendInstantiationProgress(instanceId, 100, "Complete", packetImage.title);
        logger.log('PacketProcessor:instantiatePacket', 'Packet instance data created and runtime started.', { instanceId });

        return { success: true, instanceId: instanceId, instance: packetInstance };

    } catch (error) {
        logger.error('PacketProcessor:instantiatePacket', 'Error during instantiation', { imageId, instanceId, error });
        sendProgressNotification('packet_creation_failed', { instanceId: instanceId, error: error.message });
        
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
                logger.warn('PacketProcessor:delete', `Instance ${instanceId} not found, cleaning up any stale artifacts.`);
                await storage.deletePacketBrowserState(instanceId).catch(()=>{});
                await ruleManager.removePacketRules(instanceId);
                continue;
            }

            const runtime = new PacketRuntime(instance);
            await runtime.delete();
            
            await storage.deletePacketInstance(instanceId);

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

export async function processDeletePacketImageRequest(data) {
    const { imageId } = data;
    if (!imageId) {
        return { success: false, error: "Image ID is required for deletion." };
    }
    let errors = [];
    try {
        await storage.deletePacketImage(imageId);
    } catch (error) {
        logger.error('PacketProcessor:deleteImage', `Error deleting packet image ${imageId}`, error);
        errors.push(error.message);
    }
    try {
        await indexedDbStorage.deleteGeneratedContentForImage(imageId);
    } catch (error) {
        logger.error('PacketProcessor:deleteImage', `Error deleting IDB content for image ${imageId}`, error);
        errors.push(error.message);
    }
    sendProgressNotification('packet_image_deleted', { imageId: imageId });
    return { success: errors.length === 0, errors: errors };
}

export async function importImageFromUrl(url) {
    if (!url) return { success: false, error: "URL is required for import." };

    const newImageId = `img_${Date.now()}_imported_${Math.random().toString(36).substring(2, 9)}`;

    try {
        sendProgressNotification('packet_creation_progress', { imageId: newImageId, status: 'active', text: 'Downloading...', progressPercent: 10, title: 'Importing Packet...' });
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Failed to download packet from URL (${response.status})`);
        const sharedImage = await response.json();
        if (!sharedImage || !sharedImage.title || !Array.isArray(sharedImage.sourceContent)) {
            throw new Error("Invalid packet image format in downloaded JSON.");
        }
        const importedPacketImage = { ...sharedImage, id: newImageId, created: new Date().toISOString(), shareUrl: url };
        
        for (const contentItem of importedPacketImage.sourceContent) {
            if (contentItem.origin === 'internal' && contentItem.contentB64) {
                const contentBuffer = await base64Decode(contentItem.contentB64);
                const indexedDbKey = sanitizeForFileName(contentItem.lrl);
                await indexedDbStorage.saveGeneratedContent(newImageId, indexedDbKey, [{
                    name: contentItem.lrl.split('/').pop(),
                    content: contentBuffer,
                    contentType: contentItem.contentType || contentItem.mimeType
                }]);
                delete contentItem.contentB64;
            }
        }

        await storage.savePacketImage(importedPacketImage);
        sendProgressNotification('packet_image_created', { image: importedPacketImage });
        return { success: true, imageId: newImageId };

    } catch (error) {
        logger.error('PacketProcessor:importImageFromUrl', 'Error importing image', { url, error });
        sendProgressNotification('packet_creation_failed', { imageId: newImageId, error: error.message, step: 'import_failure' });
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
            if (contentItem.origin === 'internal' && contentItem.lrl) {
                const indexedDbKey = sanitizeForFileName(contentItem.lrl);
                const storedContent = await indexedDbStorage.getGeneratedContent(imageId, indexedDbKey);
                if (storedContent && storedContent[0]?.content) {
                    // [FIX] Await the async conversion to prevent freezing/crashing
                    contentItem.contentB64 = await arrayBufferToBase64(storedContent[0].content);
                }
            }
        }
        
        const jsonString = JSON.stringify(imageForExport);
        const shareFileName = `shared/img_${imageId.replace(/^img_/, '')}_${Date.now()}.json`;
        const uploadResult = await cloudStorage.uploadFile(shareFileName, jsonString, 'application/json', 'public-read');

        if (uploadResult.success && uploadResult.fileName) {
            const publicUrl = cloudStorage.getPublicUrl(uploadResult.fileName);
            if (!publicUrl) return { success: false, error: "Failed to construct public URL after upload." };
            return { success: true, shareUrl: publicUrl, message: "Packet link ready to share!" };
        } else {
            return { success: false, error: `Failed to upload shareable image: ${uploadResult.error || 'Unknown cloud error'}` };
        }
    } catch (error) {
        logger.error('PacketProcessor:publishImageForSharing', 'Error publishing image', { imageId, error });
        return { success: false, error: error.message || "Unknown error during image sharing." };
    }
}