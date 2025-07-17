// ext/utils.js
// Shared utility functions for the Unlock extension
// REVISED: The isUrlInPacket function for 'generated' content is now corrected to
// properly parse incoming pre-signed URLs and compare their path against the stored S3 key.

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
    PACKET_CONTEXT_PREFIX: 'packetContext_' // Stores { instanceId, packetUrl, currentUrl } for a tab
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
      },
      {
        id: 'default_chrome_ai_nano',
        name: 'Chrome AI (Gemini Nano On-Device)',
        providerType: 'chrome-ai-gemini-nano',
        apiKey: null,
        modelName: 'gemini-nano',
        apiEndpoint: null
      }
    ],
    activeStorageId: null,
    storageConfigs: [],
    themePreference: 'auto',
    confettiEnabled: true,
    tabGroupsEnabled: true,
    preferAudio: false,
    waveformLinkMarkersEnabled: true,
    visitThresholdSeconds: 5,
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
            request.onsuccess = resolve;
            request.onerror = () => reject(request.error);
            tx.oncomplete = resolve;
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
   async deleteGeneratedContent(imageId, pageId) {
       const key = `${imageId}::${pageId}`;
       try {
           const db = await getDb();
           const tx = db.transaction(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT, 'readwrite');
           const store = tx.objectStore(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT);
           store.delete(key);
           await new Promise((resolve, reject) => {
               tx.oncomplete = resolve;
               tx.onerror = () => reject(tx.error);
           });
           return true;
       } catch (error) {
           logger.error('IndexedDB', 'Error deleting generated content', { key, error });
           return false;
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
  }
};

const packetUtils = {
    calculateInstanceProgress(instance) {
        if (!instance || !Array.isArray(instance.contents)) {
            return { visitedCount: 0, totalCount: 0, progressPercentage: 0 };
        }
        
        const trackableItems = instance.contents.filter(item => 
            (item.type === 'external' && item.url) || 
            ((item.type === 'generated' || item.type === 'media') && item.pageId)
        );

        const totalCount = trackableItems.length;
        if (totalCount === 0) {
            return { visitedCount: 0, totalCount: 0, progressPercentage: 0 };
        }
        
        const visitedUrlsSet = new Set(instance.visitedUrls || []);
        const visitedGeneratedIds = new Set(instance.visitedGeneratedPageIds || []);
        const mentionedLinksSet = new Set(instance.mentionedMediaLinks || []);
        let completedCheckpoints = 0;
        
        trackableItems.forEach(item => {
            if ((item.type === 'generated' || item.type === 'media') && item.pageId && visitedGeneratedIds.has(item.pageId)) {
                completedCheckpoints++;
            } else if (item.type === 'external' && item.url && visitedUrlsSet.has(item.url)) {
                completedCheckpoints++;
            } 
            else if (item.type === 'media' && item.pageId && Array.isArray(item.timestamps) && item.timestamps.length > 0) {
                const totalLinksInMedia = item.timestamps.length;
                let mentionedInMedia = 0;
                item.timestamps.forEach(ts => {
                    if (mentionedLinksSet.has(ts.url)) {
                        mentionedInMedia++;
                    }
                });
                completedCheckpoints += (mentionedInMedia / totalLinksInMedia);
            }
        });
        
        return {
            visitedCount: completedCheckpoints,
            totalCount,
            progressPercentage: totalCount > 0 ? Math.round((completedCheckpoints / totalCount) * 100) : 0
        };
    },

    isPacketInstanceCompleted(instance) {
        if (!instance) return false;
        const { progressPercentage } = this.calculateInstanceProgress(instance);
        return progressPercentage >= 100;
    },

  isUrlInPacket(loadedUrl, instance, options = {}) {
    if (!loadedUrl || !instance || !Array.isArray(instance.contents)) {
        return options.returnItem ? null : false;
    }

    const urlToCompare = decodeURIComponent(loadedUrl);
    
    for (const item of instance.contents) {
        if (item.type === 'alternative') {
            for (const alt of item.alternatives) {
                const result = this.isUrlInPacket(loadedUrl, { contents: [alt] }, options);
                if (result) return result;
            }
        } else {
            if (!item.url) continue;

            if (item.type === 'external') {
                if (urlToCompare === decodeURIComponent(item.url)) {
                    return options.returnItem ? item : true;
                }
            } else if (item.type === 'generated' || item.type === 'media') {
                try {
                    const loadedUrlObj = new URL(urlToCompare);
                    const { publishContext } = item;
                    if (publishContext) {
                        let expectedPathname = (publishContext.provider === 'google')
                            ? `/${publishContext.bucket}/${item.url}`
                            : `/${item.url}`;
                        if (loadedUrlObj.pathname === expectedPathname) {
                            return options.returnItem ? item : true;
                        }
                    }
                } catch (e) { /* ignore */ }
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
  async markUrlAsVisited(instanceId, url) {
    let instance = await storage.getPacketInstance(instanceId);
    if (!instance) return { success: false, error: 'Packet instance not found' };

    const wasCompletedBefore = this.isPacketInstanceCompleted(instance);
    const foundItem = this.isUrlInPacket(url, instance, { returnItem: true });

    if (!foundItem) return { success: true, notTrackable: true };

    const isGenerated = (foundItem.type === 'generated' || foundItem.type === 'media');
    const alreadyVisited = isGenerated
        ? (instance.visitedGeneratedPageIds || []).includes(foundItem.pageId)
        : (instance.visitedUrls || []).includes(url);

    if (alreadyVisited) return { success: true, alreadyVisited: true };
    
    if (isGenerated) {
        instance.visitedGeneratedPageIds = [...(instance.visitedGeneratedPageIds || []), foundItem.pageId];
    } else {
        instance.visitedUrls = [...(instance.visitedUrls || []), url];
    }

    await storage.savePacketInstance(instance);
    const justCompleted = !wasCompletedBefore && this.isPacketInstanceCompleted(instance);

    return { success: true, modified: true, instance, justCompleted };
  },
  async markPageIdAsVisited(instanceId, pageId) {
    let instance = await storage.getPacketInstance(instanceId);
    if (!instance) return { success: false, error: 'Packet instance not found' };

    const wasCompletedBefore = this.isPacketInstanceCompleted(instance);
    instance.visitedGeneratedPageIds = [...new Set([...(instance.visitedGeneratedPageIds || []), pageId])];
    
    await storage.savePacketInstance(instance);
    const justCompleted = !wasCompletedBefore && this.isPacketInstanceCompleted(instance);

    return { success: true, modified: true, instance, justCompleted };
  },
  getDefaultGeneratedPageUrl(instance) {
    const page = this.getGeneratedPages(instance)[0];
    return page ? page.url : null;
  },
  getGeneratedPages(instance) {
      if (!instance?.contents) return [];
      return instance.contents.flatMap(item => 
          item.type === 'generated' ? [item] :
          (item.type === 'alternative' ? item.alternatives.filter(alt => alt.type === 'generated') : [])
      );
  }
};

function getPacketContextKey(tabId) { return `${CONFIG.STORAGE_KEYS.PACKET_CONTEXT_PREFIX}${tabId}`; }
async function getPacketContext(tabId) {
    const key = getPacketContextKey(tabId);
    const data = await storage.getLocal(key);
    return data[key] || null;
}
async function setPacketContext(tabId, instanceId, packetUrl, currentUrl) {
    await storage.setLocal({ [getPacketContextKey(tabId)]: { instanceId, packetUrl, currentUrl } });
    return true;
}
async function clearPacketContext(tabId) {
    await storage.removeLocal(getPacketContextKey(tabId));
}

function isTabGroupsAvailable() { return typeof chrome?.tabGroups?.update === 'function'; }
function isSidePanelAvailable() { return typeof chrome?.sidePanel?.open === 'function'; }

export async function isChromeAiAvailable() {
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
  applyThemeMode,
  getDb,
  shouldUseTabGroups,
  arrayBufferToBase64,
  base64Decode,
  arrayBufferToBase64 as base64Encode,
  sanitizeForFileName,
};