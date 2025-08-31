// ext/utils.js
// Shared utility functions for the Unlock extension
// REVISED: This file establishes the core components for the new context management system.
// The PacketContext is now more explicit, tracking both the canonical packet URL and the
// current browser URL. The isUrlInPacket function is the sole authority for determining
// if a browser URL corresponds to a defined packet item, correctly handling pre-signed URLs.

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
        id: 'default_gemini_1_5_pro',
        name: 'Google Gemini 1.5 Pro (Default)',
        providerType: 'gemini',
        apiKey: '',
        modelName: 'gemini-1.5-pro-latest',
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
    elevenlabsApiKey: ''
  },
  INDEXED_DB: {
    NAME: 'UnlockDB', VERSION: 1, STORE_GENERATED_CONTENT: 'generatedContent'
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
        const tx = db.transaction(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT, 'readwrite');
        const store = tx.objectStore(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT);
        const request = store.put(filesArray, key);
        
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
   },   async getGeneratedContent(imageId, pageId) {
    const key = `${imageId}::${pageId}`;
    try {
        const db = await getDb();
        const tx = db.transaction(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT, 'readonly');
        const store = tx.objectStore(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT);
        const request = store.get(key);
        return await new Promise((resolve, reject) => {
             request.onerror = (event) => reject(event.target.error);
             request.onsuccess = (event) => resolve(event.target.result || null);
        });
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
                            cursor.delete();
                        }
                        cursor.continue();
                    } else { resolve(); }
                };
                request.onerror = event => reject(event.target.error);
                 tx.onerror = () => reject(tx.error);
            });
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
                           const value = cursor.value;
                           
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
    // --- START: New Debugging Function ---
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
    // --- END: New Debugging Function ---
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
  }
};

const packetUtils = {
    _updateCheckpointsOnVisit(instance, image) {
        if (!image || !Array.isArray(image.checkpoints) || !Array.isArray(instance.checkpointsTripped)) {
            return false;
        }
        let checkpointsModified = false;
        const visitedUrlsSet = new Set(instance.visitedUrls || []);

        image.checkpoints.forEach((checkpoint, index) => {
            if (instance.checkpointsTripped[index] === 1) {
                return;
            }
            const isCompleted = checkpoint.requiredItems.every(req => {
                return req.url && visitedUrlsSet.has(req.url);
            });
            if (isCompleted) {
                instance.checkpointsTripped[index] = 1;
                checkpointsModified = true;
                logger.log('Utils:_updateCheckpoints', `Checkpoint '${checkpoint.title}' completed for instance ${instance.instanceId}`);
            }
        });
        return checkpointsModified;
    },

    calculateInstanceProgress(instance, image = null) {
        if (!instance) {
            return { visitedCount: 0, totalCount: 0, progressPercentage: 0 };
        }
        if (image && Array.isArray(image.checkpoints) && Array.isArray(instance.checkpointsTripped)) {
            const totalCount = image.checkpoints.length;
            if (totalCount === 0) {
                return { visitedCount: 0, totalCount: 0, progressPercentage: 100 };
            }
            const visitedCount = instance.checkpointsTripped.filter(c => c === 1).length;
            return {
                visitedCount,
                totalCount,
                progressPercentage: Math.round((visitedCount / totalCount) * 100)
            };
        }
        if (!Array.isArray(instance.contents)) {
            return { visitedCount: 0, totalCount: 0, progressPercentage: 0 };
        }
        const trackableItems = instance.contents.filter(item => item.url && item.format === 'html');
        const totalCount = trackableItems.length;
        if (totalCount === 0) {
            return { visitedCount: 0, totalCount: 0, progressPercentage: 100 };
        }
        const visitedUrlsSet = new Set(instance.visitedUrls || []);
        const visitedCount = trackableItems.filter(item => visitedUrlsSet.has(item.url)).length;
        
        return {
            visitedCount: visitedCount,
            totalCount,
            progressPercentage: Math.round((visitedCount / totalCount) * 100)
        };
    },

    async isPacketInstanceCompleted(instance, image) {
        if (!instance) return false;
        if (!image) {
            image = await storage.getPacketImage(instance.imageId);
        }
        const { progressPercentage } = this.calculateInstanceProgress(instance, image);
        return progressPercentage >= 100;
    },

  isUrlInPacket(loadedUrl, instance, options = {}) {
    if (!loadedUrl || !instance || !Array.isArray(instance.contents)) {
        return options.returnItem ? null : false;
    }

    let decodedLoadedUrl;
    try {
        decodedLoadedUrl = decodeURIComponent(loadedUrl);
    } catch (e) {
        logger.warn('isUrlInPacket', 'Could not decode loadedUrl', { loadedUrl, error: e });
        decodedLoadedUrl = loadedUrl;
    }

    for (const item of instance.contents) {
        let decodedItemUrl;
        if (item.url) {
            try {
                decodedItemUrl = decodeURIComponent(item.url);
            } catch (e) {
                logger.warn('isUrlInPacket', 'Could not decode item.url', { itemUrl: item.url, error: e });
                decodedItemUrl = item.url;
            }
        }
        
        if (item.origin === 'external' && decodedItemUrl && decodedItemUrl === decodedLoadedUrl) {
             return options.returnItem ? item : true;
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

  getColorForTopic(topic) {
    const colors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
    if (!topic) return colors[0];
    let hash = 0;
    for (let i = 0; i < topic.length; i++) {
        hash = ((hash << 5) - hash) + topic.charCodeAt(i);
        hash |= 0;
    }
    return colors[Math.abs(hash) % colors.length];
  },
  
    async markUrlAsVisited(instance, url) {
        if (!instance) {
            logger.warn('markUrlAsVisited', 'Packet instance not found');
            return { success: false, error: 'Packet instance not found' };
        }

        const image = await storage.getPacketImage(instance.imageId);
        const wasCompletedBefore = await this.isPacketInstanceCompleted(instance, image);
        const foundItem = this.isUrlInPacket(url, instance, { returnItem: true });

        if (!foundItem) {
            return { success: true, notTrackable: true, instance: instance };
        }

        const canonicalUrl = foundItem.url;
        const alreadyVisited = (instance.visitedUrls || []).includes(canonicalUrl);

        if (alreadyVisited) {
            return { success: true, alreadyVisited: true, instance: instance };
        }
        
        instance.visitedUrls = [...(instance.visitedUrls || []), canonicalUrl];
        
        this._updateCheckpointsOnVisit(instance, image);
        
        const justCompleted = !wasCompletedBefore && await this.isPacketInstanceCompleted(instance, image);
        
        return { success: true, modified: true, instance, justCompleted };
    },

  getDefaultGeneratedPageUrl(instance) {
    if (!instance?.contents) return null;
    const page = instance.contents.find(item => item.format === 'html' && item.origin === 'internal');
    return page ? page.url : null;
  },
  getGeneratedPages(instance) {
      if (!instance?.contents) return [];
      return instance.contents.filter(item => item.format === 'html' && item.origin === 'internal');
  }
};

function getPacketContextKey(tabId) { return `${CONFIG.STORAGE_KEYS.PACKET_CONTEXT_PREFIX}${tabId}`; }
async function getPacketContext(tabId) {
    const key = getPacketContextKey(tabId);
    const data = await storage.getLocal(key);
    return data[key] || null;
}
async function setPacketContext(tabId, instanceId, canonicalPacketUrl, currentBrowserUrl) {
    const context = {
        instanceId,
        canonicalPacketUrl,
        currentBrowserUrl
    };
    logger.log('Utils:setPacketContext', `Setting context for tabId: ${tabId}`, context);
    await storage.setLocal({ [getPacketContextKey(tabId)]: context });
    return true;
}
async function clearPacketContext(tabId) {
    logger.log('Utils:clearPacketContext', `Clearing context for tabId: ${tabId}`);
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
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64Decode(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

function sanitizeForFileName(input) {
  return (input || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_.-]/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
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