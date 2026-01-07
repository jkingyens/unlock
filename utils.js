// ext/utils.js
// Shared utility functions for the Unlock extension
// REVISED: Fixed memory crash in arrayBufferToBase64 by using asynchronous Blob/FileReader API.

// --- Centralized Configuration ---
const CONFIG = {
    DEBUG: true, // Set to false for production
    TEMPERATURE: 0.2, // LLM Temperature
    DEFAULT_PRESIGNED_URL_EXPIRATION_SECONDS: 3600, // 1 hour
    PRESIGNED_URL_CACHE_EXPIRY_BUFFER_MS: 60000, // 1 minute
    STORAGE_KEYS: {
        PACKET_IMAGES: 'packetImages',       // Stores PacketImage objects (map)
        PACKET_INSTANCES: 'packetInstances', // Stores PacketInstance objects (map)
        PACKET_BROWSER_STATES: 'packetBrowserStates', // Stores PacketBrowserState objects (map)
        SETTINGS: 'settings',
        PENDING_VIEW_KEY: 'pendingSidebarView',
        PACKET_CONTEXT_PREFIX: 'packetContext_', // Stores { instanceId, canonicalPacketUrl, currentBrowserUrl } for a tab
        ACTIVE_MEDIA_KEY: 'activeMediaPlaybackState'
    },
    DEFAULT_SETTINGS: {
        selectedModelId: 'default_openai_gpt4o',
        llmModels: [
            {
                id: 'default_openai_gpt4o',
                name: 'OpenAI GPT-4o (Default)',
                providerType: 'openai',
                apiKey: '',
                modelName: 'gpt-4o',
                apiEndpoint: 'https://api.openai.com/v1/chat/completions'
            },
            {
                id: 'default_gemini_2_5_pro',
                name: 'Google Gemini 2.5 Pro (Default)',
                providerType: 'gemini',
                apiKey: '',
                modelName: 'gemini-2.5-pro',
                apiEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/'
            },
            {
                id: 'default_perplexity_sonar_medium',
                name: 'Perplexity Sonar Medium (Default)',
                providerType: 'perplexity',
                apiKey: '',
                modelName: 'sonar-medium-online',
                apiEndpoint: 'https://api.perplexity.ai/chat/completions'
            },
            {
                id: 'default_meta_llama',
                name: 'Meta Llama (Default)',
                providerType: 'llama',
                apiKey: '',
                modelName: 'Llama-4-Maverick-17B-128E-Instruct-FP8',
                apiEndpoint: 'https://api.llama.com/v1/chat/completions'
            },
            {
                id: 'default_deepseek_chat',
                name: 'DeepSeek (Chat - Default)',
                providerType: 'deepseek',
                apiKey: '',
                modelName: 'deepseek-chat',
                apiEndpoint: 'https://api.deepseek.com/chat/completions'
            },
            {
                id: 'default_anthropic_claude3_haiku',
                name: 'Anthropic Claude 3 Haiku (Default)',
                providerType: 'anthropic',
                apiKey: '',
                modelName: 'claude-3-haiku-20240307',
                apiEndpoint: 'https://api.anthropic.com/v1/messages'
            },
            {
                id: 'default_grok_mini',
                name: 'Grok (Mini - xAI) (Default)',
                providerType: 'grok',
                apiKey: '',
                modelName: 'grok-3-mini-fast-latest',
                apiEndpoint: 'https://api.x.ai/v1/chat/completions'
            }
        ],
        activeStorageId: null,
        storageConfigs: [],
        themePreference: 'auto',
        confettiEnabled: true,
        tabGroupsEnabled: true,
        mediaOverlayEnabled: true,
        preferAudio: true,
        waveformLinkMarkersEnabled: true,
        visitThresholdSeconds: 2,
        quickCopyEnabled: true,
        elevenlabsApiKey: ''
    },
    INDEXED_DB: {
        NAME: 'UnlockDB',
        VERSION: 2, // Incremented for CAS schema
        STORE_GENERATED_CONTENT: 'generatedContent',
        STORE_CONTENT_BLOBS: 'contentBlobs' // New store for deduplicated binary data
    },
    IMAGE_DIR: 'packet-images/'
};

export const GROUP_TITLE_PREFIX = "PKT-";

export const MPI_PARAMS = {
    MARKER: 'MPI',
    INSTANCE_ID: 'instanceId',
    PAGE_ID: 'pageId',
    EVENT_NAME: 'eventName'
};

export function getIdentifierForGroupTitle(instanceId) {
    if (instanceId && typeof instanceId === 'string' && instanceId.startsWith('inst_')) {
        return instanceId.substring('inst_'.length);
    }
    logger.warn('Utils:getIdentifierForGroupTitle', 'Invalid instanceId format for identifier extraction', { instanceId });
    return null;
}

export function getInstanceIdFromGroupTitle(title) {
    if (title && typeof title === 'string' && title.startsWith(GROUP_TITLE_PREFIX)) {
        const identifier = title.substring(GROUP_TITLE_PREFIX.length);
        if (identifier) {
            return `inst_${identifier}`;
        }
    }
    return null;
}

const logger = {
    log(component, message, data) {
        if (CONFIG.DEBUG) {
            if (typeof data !== 'undefined') {
                console.log(`[Unlock ${component}] ${message}`, data);
            } else {
                console.log(`[Unlock ${component}] ${message}`);
            }
        }
    },
    warn(component, message, data) {
        if (CONFIG.DEBUG) {
            if (typeof data !== 'undefined') {
                console.warn(`[Unlock ${component} Warning] ${message}`, data);
            } else {
                console.warn(`[Unlock ${component} Warning] ${message}`);
            }
        }
    },
    error(component, message, error) {
        console.error(`[Unlock ${component} Error] ${message}`, error);
    }
};

// --- Helper for Content Hashing ---
async function computeContentHash(buffer) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

let dbPromise = null;
function getDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const openRequest = indexedDB.open(CONFIG.INDEXED_DB.NAME, CONFIG.INDEXED_DB.VERSION);
            openRequest.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT)) {
                    db.createObjectStore(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT);
                }
                // --- NEW: Create blob store for CAS ---
                if (!db.objectStoreNames.contains(CONFIG.INDEXED_DB.STORE_CONTENT_BLOBS)) {
                    db.createObjectStore(CONFIG.INDEXED_DB.STORE_CONTENT_BLOBS);
                }
            };
            openRequest.onerror = (event) => {
                logger.error('IndexedDB', 'Database error', event.target.error);
                dbPromise = null; reject(event.target.error);
            };
            openRequest.onsuccess = (event) => {
                resolve(event.target.result);
            };
        });
    }
    return dbPromise;
}

const indexedDbStorage = {
    async saveGeneratedContent(imageId, pageId, filesArray) {
        const key = `${imageId}::${pageId}`;
        try {
            const db = await getDb();
            // Transaction covers both stores
            const tx = db.transaction([CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT, CONFIG.INDEXED_DB.STORE_CONTENT_BLOBS], 'readwrite');
            const contentStore = tx.objectStore(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT);
            const blobStore = tx.objectStore(CONFIG.INDEXED_DB.STORE_CONTENT_BLOBS);

            const processedFiles = [];

            for (const file of filesArray) {
                // If file has binary content, hash it and store in blobStore
                if (file.content) {
                    const hash = await computeContentHash(file.content);
                    // Store the blob keyed by hash. 'put' is safe/idempotent.
                    blobStore.put(file.content, hash);

                    // Store a lightweight reference in the main entry
                    processedFiles.push({
                        ...file,
                        content: null, // Strip the heavy blob
                        contentHash: hash // Add reference
                    });
                } else {
                    processedFiles.push(file);
                }
            }

            const request = contentStore.put(processedFiles, key);

            await new Promise((resolve, reject) => {
                request.onerror = () => reject(request.error);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
            return true;
        } catch (error) {
            logger.error('IndexedDB', 'Error saving generated content', { key, error });
            return false;
        }
    },
    async getGeneratedContent(imageId, pageId) {
        const key = `${imageId}::${pageId}`;
        try {
            const db = await getDb();
            const tx = db.transaction([CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT, CONFIG.INDEXED_DB.STORE_CONTENT_BLOBS], 'readonly');
            const contentStore = tx.objectStore(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT);
            const blobStore = tx.objectStore(CONFIG.INDEXED_DB.STORE_CONTENT_BLOBS);

            const entry = await new Promise((resolve, reject) => {
                const request = contentStore.get(key);
                request.onsuccess = (event) => resolve(event.target.result || null);
                request.onerror = (event) => reject(event.target.error);
            });

            if (!entry) return null;

            // Rehydrate content from blobStore
            const rehydratedFiles = [];
            for (const file of entry) {
                if (file.contentHash && !file.content) {
                    const blobContent = await new Promise((resolve, reject) => {
                        const req = blobStore.get(file.contentHash);
                        req.onsuccess = () => resolve(req.result);
                        req.onerror = () => reject(req.error);
                    });
                    if (blobContent) {
                        rehydratedFiles.push({
                            ...file,
                            content: blobContent
                        });
                    } else {
                        logger.warn('IndexedDB', 'Missing blob for hash', file.contentHash);
                        rehydratedFiles.push(file); // Push without content if missing (shouldn't happen)
                    }
                } else {
                    rehydratedFiles.push(file);
                }
            }

            return rehydratedFiles;
        } catch (error) {
            logger.error('IndexedDB', 'Error getting generated content', { key, error });
            return null;
        }
    },
    async deleteGeneratedContentForImage(imageId) {
        try {
            const db = await getDb();
            const tx = db.transaction(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT, 'readwrite');
            const store = tx.objectStore(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT);
            const request = store.openCursor();
            await new Promise((resolve, reject) => {
                request.onsuccess = event => {
                    const cursor = event.target.result;
                    if (cursor) {
                        if (String(cursor.key).startsWith(`${imageId}::`)) {
                            cursor.delete(); // Only deletes the references
                        }
                        cursor.continue();
                    } else { resolve(); }
                };
                request.onerror = event => reject(event.target.error);
                tx.onerror = () => reject(tx.error);
            });
            // Note: We rely on garbageCollectIndexedDbContent to clean up the actual blobs
            return true;
        } catch (error) {
            logger.error('IndexedDB', 'Error deleting content for image', { imageId, error });
            return false;
        }
    },
    async transferDraftContent(originalDraftId, finalImageId) {
        try {
            const db = await getDb();
            const tx = db.transaction(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT, 'readwrite');
            const store = tx.objectStore(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT);

            await new Promise((resolve, reject) => {
                const request = store.openCursor();

                request.onsuccess = event => {
                    const cursor = event.target.result;
                    if (cursor) {
                        const currentKey = String(cursor.key);
                        if (currentKey.startsWith(`${originalDraftId}::`)) {
                            const pageId = currentKey.substring(currentKey.indexOf('::') + 2);
                            const newKey = `${finalImageId}::${pageId}`;
                            const value = cursor.value; // Value contains refs, so copying is cheap

                            store.add(value, newKey);
                            cursor.delete();
                        }
                        cursor.continue();
                    }
                };

                request.onerror = () => reject(request.error);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });

            logger.log('IndexedDB', `Successfully transferred content from ${originalDraftId} to ${finalImageId}`);
            return true;
        } catch (error) {
            logger.error('IndexedDB', 'Error transferring draft content', { originalDraftId, finalImageId, error });
            return false;
        }
    },
    async clearAllContent() {
        try {
            const db = await getDb();
            const tx = db.transaction([CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT, CONFIG.INDEXED_DB.STORE_CONTENT_BLOBS], 'readwrite');
            const contentStore = tx.objectStore(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT);
            const blobStore = tx.objectStore(CONFIG.INDEXED_DB.STORE_CONTENT_BLOBS);

            contentStore.clear();
            blobStore.clear();

            await new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
            logger.log('IndexedDB', 'All cached content has been cleared.');
            return true;
        } catch (error) {
            logger.error('IndexedDB', 'Error clearing cached content', { error });
            return false;
        }
    },
    async garbageCollectIndexedDbContent() {
        logger.log('IndexedDB:GC', 'Starting garbage collection...');
        try {
            const db = await getDb();
            const allImages = await storage.getPacketImages();
            const validImageIds = new Set(Object.keys(allImages));
            let deletedEntries = 0;
            let deletedBlobs = 0;

            const activeHashes = new Set();

            const tx = db.transaction([CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT, CONFIG.INDEXED_DB.STORE_CONTENT_BLOBS], 'readwrite');
            const contentStore = tx.objectStore(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT);
            const blobStore = tx.objectStore(CONFIG.INDEXED_DB.STORE_CONTENT_BLOBS);

            // 1. Scan content entries: Delete orphans, collect active hashes
            await new Promise((resolve, reject) => {
                const request = contentStore.openCursor();
                request.onsuccess = event => {
                    const cursor = event.target.result;
                    if (cursor) {
                        const currentKey = String(cursor.key);
                        const imageId = currentKey.split('::')[0];

                        if (!imageId.startsWith('inst_') && !validImageIds.has(imageId)) {
                            cursor.delete();
                            deletedEntries++;
                        } else {
                            // Collect hashes from valid entries
                            const files = cursor.value;
                            if (Array.isArray(files)) {
                                files.forEach(f => {
                                    if (f.contentHash) activeHashes.add(f.contentHash);
                                });
                            }
                        }
                        cursor.continue();
                    } else {
                        resolve();
                    }
                };
                request.onerror = () => reject(request.error);
            });

            // 2. Scan blobs: Delete those not in activeHashes
            await new Promise((resolve, reject) => {
                const request = blobStore.openKeyCursor();
                request.onsuccess = event => {
                    const cursor = event.target.result;
                    if (cursor) {
                        if (!activeHashes.has(cursor.key)) {
                            blobStore.delete(cursor.key);
                            deletedBlobs++;
                        }
                        cursor.continue();
                    } else {
                        resolve();
                    }
                };
                request.onerror = () => reject(request.error);
            });

            await new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });

            logger.log('IndexedDB:GC', `GC complete. Removed ${deletedEntries} orphaned entries and ${deletedBlobs} unused blobs.`);
            return true;
        } catch (error) {
            logger.error('IndexedDB:GC', 'Error during garbage collection', { error });
            return false;
        }
    },
    async clearInstanceCacheEntries() {
        logger.log('IndexedDB:ClearInstances', 'Clearing all packet instance cache entries...');
        try {
            const db = await getDb();
            let deletedCount = 0;
            const tx = db.transaction(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT, 'readwrite');
            const store = tx.objectStore(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT);
            const request = store.openCursor();

            await new Promise((resolve, reject) => {
                request.onsuccess = event => {
                    const cursor = event.target.result;
                    if (cursor) {
                        if (String(cursor.key).startsWith('inst_')) {
                            cursor.delete();
                            deletedCount++;
                        }
                        cursor.continue();
                    } else {
                        resolve();
                    }
                };
                request.onerror = event => reject(event.target.error);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });

            // We do not need to explicitly clear blobs here; the next GC cycle will pick up
            // any blobs that were *only* referenced by these instances.
            logger.log('IndexedDB:ClearInstances', `Cleanup complete. Removed ${deletedCount} instance cache entries.`);
            return true;
        } catch (error) {
            logger.error('IndexedDB:ClearInstances', 'Error during instance cache cleanup', { error });
            return false;
        }
    },
    async debugDumpIndexedDb() {
        if (!CONFIG.DEBUG) return;
        try {
            const db = await getDb();
            const tx = db.transaction(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT, 'readonly');
            const store = tx.objectStore(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT);
            const request = store.getAllKeys();

            const keys = await new Promise((resolve, reject) => {
                request.onerror = (event) => reject(event.target.error);
                request.onsuccess = (event) => resolve(event.target.result);
            });

            console.log("--- IndexedDB Content Keys ---");
            if (keys && keys.length > 0) {
                console.log(keys);
            } else {
                console.log("Database is empty.");
            }
            console.log("------------------------------");

        } catch (error) {
            logger.error('IndexedDB', 'Error dumping database keys', error);
        }
    }
};

const storage = {
    async getLocal(key) {
        return new Promise((resolve, reject) => {
            chrome.storage.local.get(key, (result) => {
                if (chrome.runtime.lastError) reject(chrome.runtime.lastError); else resolve(result);
            });
        });
    },
    async setLocal(data) {
        return new Promise((resolve, reject) => {
            chrome.storage.local.set(data, () => {
                if (chrome.runtime.lastError) reject(chrome.runtime.lastError); else resolve();
            });
        });
    },
    async removeLocal(key) {
        return new Promise((resolve, reject) => {
            chrome.storage.local.remove(key, () => { if (chrome.runtime.lastError) reject(chrome.runtime.lastError); else resolve(); });
        });
    },
    async getPacketImages() {
        const data = await this.getLocal(CONFIG.STORAGE_KEYS.PACKET_IMAGES);
        return data[CONFIG.STORAGE_KEYS.PACKET_IMAGES] || {};
    },
    async getPacketImage(imageId) {
        const images = await this.getPacketImages();
        return images[imageId] || null;
    },
    async savePacketImage(image) {
        const images = await this.getPacketImages();
        images[image.id] = image;
        await this.setLocal({ [CONFIG.STORAGE_KEYS.PACKET_IMAGES]: images });
        return true;
    },
    async deletePacketImage(imageId) {
        const images = await this.getPacketImages();
        if (images[imageId]) {
            delete images[imageId];
            await this.setLocal({ [CONFIG.STORAGE_KEYS.PACKET_IMAGES]: images });
            return true;
        }
        return false;
    },
    async getPacketInstances() {
        const data = await this.getLocal(CONFIG.STORAGE_KEYS.PACKET_INSTANCES);
        return data[CONFIG.STORAGE_KEYS.PACKET_INSTANCES] || {};
    },
    async getPacketInstance(instanceId) {
        const instances = await this.getPacketInstances();
        return instances[instanceId] || null;
    },
    async savePacketInstance(instance) {
        const instances = await this.getPacketInstances();
        instances[instance.instanceId] = instance;
        await this.setLocal({ [CONFIG.STORAGE_KEYS.PACKET_INSTANCES]: instances });
        return true;
    },
    async deletePacketInstance(instanceId) {
        const instances = await this.getPacketInstances();
        if (instances[instanceId]) {
            delete instances[instanceId];
            await this.setLocal({ [CONFIG.STORAGE_KEYS.PACKET_INSTANCES]: instances });
            return true;
        }
        return false;
    },
    async getInstanceCountForImage(imageId) {
        const instances = await this.getPacketInstances();
        return Object.values(instances).filter(inst => inst.imageId === imageId).length;
    },
    async getAllPacketBrowserStates() {
        const data = await this.getLocal(CONFIG.STORAGE_KEYS.PACKET_BROWSER_STATES);
        return data[CONFIG.STORAGE_KEYS.PACKET_BROWSER_STATES] || {};
    },
    async getPacketBrowserState(instanceId) {
        const states = await this.getAllPacketBrowserStates();
        return states[instanceId] || null;
    },
    async savePacketBrowserState(state) {
        const states = await this.getAllPacketBrowserStates();
        states[state.instanceId] = state;
        await this.setLocal({ [CONFIG.STORAGE_KEYS.PACKET_BROWSER_STATES]: states });
        return true;
    },
    async deletePacketBrowserState(instanceId) {
        const states = await this.getAllPacketBrowserStates();
        if (states[instanceId]) {
            delete states[instanceId];
            await this.setLocal({ [CONFIG.STORAGE_KEYS.PACKET_BROWSER_STATES]: states });
            return true;
        }
        return false;
    },
    async getSettings() {
        const data = await this.getLocal(CONFIG.STORAGE_KEYS.SETTINGS);
        const storedSettings = data[CONFIG.STORAGE_KEYS.SETTINGS] || {};
        return { ...CONFIG.DEFAULT_SETTINGS, ...storedSettings };
    },
    async saveSettings(settings) {
        await this.setLocal({ [CONFIG.STORAGE_KEYS.SETTINGS]: settings });
        return true;
    },
    async getActiveModelConfig() {
        const settings = await this.getSettings();
        return settings.llmModels.find(model => model.id === settings.selectedModelId) || null;
    },
    async isCloudStorageEnabled() {
        const settings = await this.getSettings();
        const config = settings.storageConfigs.find(c => c.id === settings.activeStorageId);
        return !!(config?.credentials?.accessKey && config?.credentials?.secretKey);
    },
    async getActiveCloudStorageConfig() {
        const settings = await this.getSettings();
        return settings.storageConfigs.find(c => c.id === settings.activeStorageId) || null;
    },
    async getSession(key) {
        return new Promise(resolve => {
            if (!chrome.storage?.session) return resolve({});
            chrome.storage.session.get(key, result => resolve(result || {}));
        });
    },
    async setSession(data) {
        return new Promise(resolve => {
            if (!chrome.storage?.session) return resolve(false);
            chrome.storage.session.set(data, () => resolve(!chrome.runtime.lastError));
        });
    },
    async removeSession(key) {
        return new Promise(resolve => {
            if (!chrome.storage?.session) return resolve();
            chrome.storage.session.remove(key, () => resolve());
        });
    },
    async clearAllPacketData() {
        logger.log('Storage:clearAllPacketData', 'Clearing all packet images, instances, browser states, and cached content.');
        await Promise.all([
            this.setLocal({
                [CONFIG.STORAGE_KEYS.PACKET_IMAGES]: {},
                [CONFIG.STORAGE_KEYS.PACKET_INSTANCES]: {},
                [CONFIG.STORAGE_KEYS.PACKET_BROWSER_STATES]: {}
            }),
            indexedDbStorage.clearAllContent()
        ]);
        logger.log('Storage:clearAllPacketData', 'All packet data has been cleared.');
    }
};

const packetUtils = {
    _expressToRegex: (path) => {
        const regexString = '^' + path.replace(/\//g, '\\/').replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$';
        return new RegExp(regexString);
    },

    renderPacketUrl: (templateUrl, variables) => {
        if (!templateUrl || typeof templateUrl !== 'string') return templateUrl;
        if (!variables) return templateUrl;
        let renderedUrl = templateUrl;
        for (const key in variables) {
            const regex = new RegExp(`:${key}`, 'g');
            renderedUrl = renderedUrl.replace(regex, variables[key]);
        }
        return renderedUrl;
    },

    isUrlInPacket(loadedUrl, instance, options = {}) {
        if (!loadedUrl || !instance || !Array.isArray(instance.contents)) {
            return options.returnItem ? null : false;
        }

        if (loadedUrl.startsWith('chrome-extension://')) {
            try {
                const urlObj = new URL(loadedUrl);
                if (urlObj.pathname.endsWith('/preview.html')) {
                    const urlInstanceId = urlObj.searchParams.get('instanceId');
                    const urlLrl = urlObj.searchParams.get('lrl');

                    if (urlInstanceId === instance.instanceId && urlLrl) {
                        const matchedItem = instance.contents.find(item => item.lrl === decodeURIComponent(urlLrl));
                        if (matchedItem) {
                            return options.returnItem ? matchedItem : true;
                        }
                    }
                }
            } catch (e) {
                logger.warn('isUrlInPacket', 'Could not parse chrome-extension URL', { loadedUrl, error: e });
            }
        }

        let decodedLoadedUrl;
        try {
            decodedLoadedUrl = decodeURIComponent(loadedUrl);
        } catch (e) {
            decodedLoadedUrl = loadedUrl;
        }

        for (const item of instance.contents) {
            let decodedItemUrl = item.url ? decodeURIComponent(item.url) : null;
            if (!decodedItemUrl) continue;

            if (decodedItemUrl) {
                const renderedItemUrl = this.renderPacketUrl(decodedItemUrl, instance.variables);

                const isWildcard = renderedItemUrl.includes('*');
                const urlPattern = isWildcard ? new RegExp('^' + renderedItemUrl.replace(/\*/g, '[^/]+') + '$') : null;

                if ((!isWildcard && renderedItemUrl === decodedLoadedUrl) || (isWildcard && urlPattern.test(decodedLoadedUrl))) {
                    return options.returnItem ? item : true;
                }

                if (item.captures && item.captures.fromPath) {
                    try {
                        const itemUrlObject = new URL(item.url);
                        const loadedUrlObject = new URL(decodedLoadedUrl);

                        if (itemUrlObject.hostname === loadedUrlObject.hostname) {
                            const regex = this._expressToRegex(item.captures.fromPath);
                            const match = loadedUrlObject.pathname.match(regex);
                            if (match) {
                                if (options.returnItem) {
                                    return { ...item, capturedParams: match.groups };
                                }
                                return true;
                            }
                        }
                    } catch (e) { /* Invalid URL, skip */ }
                }
            }

            if (item.origin === 'internal' && item.url) {
                if (decodedItemUrl === decodedLoadedUrl) {
                    return options.returnItem ? item : true;
                }

                if (item.publishContext) {
                    try {
                        const loadedUrlObj = new URL(loadedUrl);
                        const { publishContext } = item;
                        let expectedPathname = (publishContext.provider === 'google')
                            ? `/${publishContext.bucket}/${item.url}`
                            : `/${item.url}`;

                        if (decodeURIComponent(loadedUrlObj.pathname) === decodeURIComponent(expectedPathname)) {
                            return options.returnItem ? item : true;
                        }
                    } catch (e) { /* loadedUrl might not be a valid URL. */ }
                }
            }
        }
        return options.returnItem ? null : false;
    },

    _updateCheckpointsOnVisit(instance) {
        if (!instance || !Array.isArray(instance.checkpoints) || !Array.isArray(instance.checkpointsTripped)) {
            return false;
        }
        let checkpointsModified = false;
        const visitedUrlsSet = new Set(instance.visitedUrls || []);

        instance.checkpoints.forEach((checkpoint, index) => {
            if (instance.checkpointsTripped[index] === 1) {
                return;
            }
            const isCompleted = checkpoint.requiredItems.every(req => {
                const identifier = req.url || req.lrl;
                return visitedUrlsSet.has(identifier);
            });
            if (isCompleted) {
                instance.checkpointsTripped[index] = 1;
                checkpointsModified = true;
                logger.log('Utils:_updateCheckpoints', `Checkpoint '${checkpoint.title}' completed for instance ${instance.instanceId}`);
            }
        });
        return checkpointsModified;
    },

    calculateInstanceProgress(instance) {
        if (!instance) {
            return { visitedCount: 0, totalCount: 0, progressPercentage: 0 };
        }

        if (Array.isArray(instance.checkpoints) && instance.checkpoints.length > 0 && Array.isArray(instance.checkpointsTripped)) {
            const totalCount = instance.checkpoints.length;
            const visitedCount = instance.checkpointsTripped.filter(c => c === 1).length;
            const progressPercentage = totalCount > 0 ? Math.round((visitedCount / totalCount) * 100) : 0;
            return {
                visitedCount,
                totalCount,
                progressPercentage
            };
        }

        if (!Array.isArray(instance.contents)) {
            return { visitedCount: 0, totalCount: 0, progressPercentage: 0 };
        }

        const trackableItems = instance.contents.filter(item =>
            item && (item.url || item.format === 'interactive-input')
        );

        const totalCount = trackableItems.length;
        if (totalCount === 0) {
            // [FIX] If this is a Wasm/Module packet, it manages its own completion.
            // Do NOT auto-complete it just because it has no static URLs.
            const hasAgent = instance.contents.some(item => item.format === 'wasm' || item.format === 'module');
            if (hasAgent) {
                return { visitedCount: 0, totalCount: 0, progressPercentage: 0 };
            }
            return { visitedCount: 0, totalCount: 0, progressPercentage: 100 };
        }
        const visitedUrlsSet = new Set(instance.visitedUrls || []);

        const visitedCount = trackableItems.filter(item => {
            return (item.url && visitedUrlsSet.has(item.url)) ||
                (item.format === 'interactive-input' && item.lrl && visitedUrlsSet.has(item.lrl));
        }).length;

        return {
            visitedCount: visitedCount,
            totalCount,
            progressPercentage: Math.round((visitedCount / totalCount) * 100)
        };
    },

    async isPacketInstanceCompleted(instance) {
        if (!instance) return false;
        const { progressPercentage } = this.calculateInstanceProgress(instance);
        return progressPercentage >= 100;
    },

    async markUrlAsVisited(instance, url) {
        if (!instance) {
            logger.warn('markUrlAsVisited', 'Packet instance not found');
            return { success: false, error: 'Packet instance not found' };
        }

        // [NEW] Guard against missing URL
        if (!url) {
            return { success: true, notTrackable: true, instance: instance };
        }

        const wasCompletedBefore = await this.isPacketInstanceCompleted(instance);
        const foundItem = this.isUrlInPacket(url, instance, { returnItem: true });

        if (!foundItem) {
            return { success: true, notTrackable: true, instance: instance };
        }

        // Prioritize LRL as the canonical identifier for visit tracking if it exists.
        const canonicalIdentifier = foundItem.lrl || foundItem.url;

        // [NEW] Double-check we have a valid identifier
        if (!canonicalIdentifier) {
            return { success: true, notTrackable: true, instance: instance };
        }

        if ((instance.visitedUrls || []).includes(canonicalIdentifier)) {
            return { success: true, alreadyVisited: true, instance: instance };
        }

        instance.visitedUrls = [...(instance.visitedUrls || []), canonicalIdentifier];
        this._updateCheckpointsOnVisit(instance);
        const justCompleted = !wasCompletedBefore && await this.isPacketInstanceCompleted(instance);

        return { success: true, modified: true, instance, justCompleted };
    },

    getColorForTopic(title) {
        const colors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
        if (!title) return colors[0];
        let hash = 0;
        for (let i = 0; i < title.length; i++) {
            hash = ((hash << 5) - hash) + title.charCodeAt(i);
            hash |= 0;
        }
        return colors[Math.abs(hash) % colors.length];
    },

    getDefaultGeneratedPageUrl(instance) {
        if (!instance?.contents) return null;
        const page = instance.contents.find(item => item.format === 'html' && item.origin === 'internal');
        return page ? this.renderPacketUrl(page.url, instance.variables) : null;
    },
    getGeneratedPages(instance) {
        if (!instance?.contents) return [];
        return instance.contents.filter(item => item.format === 'html' && item.origin === 'internal');
    }
};

// --- Hot Cache for Packet Context ---
const packetContextCache = new Map();

function getPacketContextKey(tabId) { return `${CONFIG.STORAGE_KEYS.PACKET_CONTEXT_PREFIX}${tabId}`; }

async function getPacketContext(tabId) {
    if (packetContextCache.has(tabId)) {
        return packetContextCache.get(tabId);
    }
    const key = getPacketContextKey(tabId);
    const data = await storage.getLocal(key);
    const context = data[key] || null;

    if (context) {
        packetContextCache.set(tabId, context);
    }
    return context;
}

async function setPacketContext(tabId, instanceId, canonicalPacketUrl, currentBrowserUrl) {
    const context = {
        instanceId,
        canonicalPacketUrl,
        currentBrowserUrl
    };
    logger.log('Utils:setPacketContext', `Setting context for tabId: ${tabId}`, context);
    packetContextCache.set(tabId, context);
    await storage.setLocal({ [getPacketContextKey(tabId)]: context });
    return true;
}

async function clearPacketContext(tabId) {
    logger.log('Utils:clearPacketContext', `Clearing context for tabId: ${tabId}`);
    packetContextCache.delete(tabId);
    await storage.removeLocal(getPacketContextKey(tabId));
}

function isTabGroupsAvailable() { return typeof chrome?.tabGroups?.update === 'function'; }
function isSidePanelAvailable() { return typeof chrome?.sidePanel?.open === 'function'; }

function isChromeAiAvailable() {
    return typeof globalThis.LanguageModel?.create === 'function';
}

let currentThemeListener = null;
async function applyThemeMode() {
    const settings = await storage.getSettings();
    const preference = settings.themePreference || 'auto';
    if (typeof window !== 'undefined' && document.body) {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
        const darkModeEnabled = (preference === 'dark') || (preference === 'auto' && prefersDark.matches);
        document.body.classList.toggle('dark-mode', darkModeEnabled);
        document.body.classList.toggle('light-mode', !darkModeEnabled);

        if (currentThemeListener) prefersDark.removeEventListener('change', currentThemeListener);
        if (preference === 'auto') {
            currentThemeListener = () => applyThemeMode();
            prefersDark.addEventListener('change', currentThemeListener);
        }
    }
}

async function shouldUseTabGroups() {
    if (!isTabGroupsAvailable()) return false;
    const settings = await storage.getSettings();
    return settings.tabGroupsEnabled;
}

async function shouldShowOverlay() {
    const settings = await storage.getSettings();
    return settings.mediaOverlayEnabled;
}

function arrayBufferToBase64(buffer) {
    return new Promise((resolve, reject) => {
        const blob = new Blob([buffer], { type: 'application/octet-stream' });
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result;
            const base64 = dataUrl.split(',')[1];
            resolve(base64);
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

async function base64Decode(base64) {
    const dataUrl = `data:application/octet-stream;base64,${base64}`;
    try {
        const response = await fetch(dataUrl);
        return await response.arrayBuffer();
    } catch (error) {
        logger.error('Utils:base64Decode', 'Failed to decode base64 using fetch.', error);
        throw new Error('Could not decode base64 data.');
    }
}

function sanitizeForFileName(input) {
    // Use encodeURIComponent to ensure uniqueness and prevent collisions (e.g., "file.name" vs "file_name")
    // while making the string safe for IDB keys.
    return encodeURIComponent(input || '');
}


export {
    CONFIG,
    logger,
    storage,
    indexedDbStorage,
    packetUtils,
    isTabGroupsAvailable,
    isSidePanelAvailable,
    getPacketContext,
    setPacketContext,
    clearPacketContext,
    getDb,
    shouldUseTabGroups,
    shouldShowOverlay,
    arrayBufferToBase64,
    base64Decode,
    sanitizeForFileName,
    isChromeAiAvailable,
    applyThemeMode,
};