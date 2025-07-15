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
    // --- REVISED STORAGE CONFIGURATION ---
    activeStorageId: null, // ID of the currently active storage configuration
    storageConfigs: [],   // Array of storage configuration objects
    // --- END REVISION ---
    themePreference: 'auto',
    confettiEnabled: true,
    tabGroupsEnabled: true,
    preferAudio: false,
    visitThresholdSeconds: 5,
    elevenlabsApiKey: ''
  },
  INDEXED_DB: {
    NAME: 'UnlockDB', VERSION: 1, STORE_GENERATED_CONTENT: 'generatedContent'
  },
  IMAGE_DIR: 'packet-images/'
};

export const GROUP_TITLE_PREFIX = "PKT-";

// Define MPI_PARAMS for event signaling URL structure
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
        logger.log('IndexedDB', `Upgrade needed from version ${event.oldVersion} to ${event.newVersion}`);
        if (!db.objectStoreNames.contains(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT)) {
          db.createObjectStore(CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT);
           logger.log('IndexedDB', `Created object store: ${CONFIG.INDEXED_DB.STORE_GENERATED_CONTENT}`);
        }
      };
      openRequest.onerror = (event) => {
        logger.error('IndexedDB', 'Database error', event.target.error);
        dbPromise = null; reject(event.target.error);
      };
      openRequest.onsuccess = (event) => {
        logger.log('IndexedDB', 'Database initialized successfully');
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
            tx.onabort = () => reject(new Error('Transaction aborted'));
        });
        logger.log('IndexedDB', 'Saved generated content', { key });
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
             request.onerror = (event) => {
                 logger.error('IndexedDB', 'Read request error', { key, error: event.target.error });
                 reject(event.target.error);
             };
             request.onsuccess = (event) => {
                 const result = event.target.result;
                 resolve(Array.isArray(result) ? result : null);
             };
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
           const request = store.delete(key);
           await new Promise((resolve, reject) => {
               request.onsuccess = resolve;
               request.onerror = () => reject(request.error);
               tx.oncomplete = resolve;
               tx.onerror = () => reject(tx.error);
               tx.onabort = () => reject(new Error('Transaction aborted'));
           });
           logger.log('IndexedDB', 'Deleted generated content', { key });
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
            let deleteCount = 0;
            await new Promise((resolve, reject) => {
                request.onsuccess = event => {
                    const cursor = event.target.result;
                    if (cursor) {
                        if (String(cursor.key).startsWith(`${imageId}::`)) {
                            cursor.delete();
                            deleteCount++;
                        }
                        cursor.continue();
                    } else { resolve(); }
                };
                request.onerror = event => { reject(event.target.error); };
                 tx.oncomplete = resolve;
                 tx.onerror = () => reject(tx.error);
                 tx.onabort = () => reject(new Error('Transaction aborted'));
            });
            logger.log('IndexedDB', `Deleted ${deleteCount} generated content entries for image`, { imageId });
            return true;
        } catch (error) {
             logger.error('IndexedDB', 'Error deleting generated content for image', { imageId, error });
             return false;
        }
   }
};

const storage = {
  async getLocal(key) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(key, (result) => {
        if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); } else { resolve(result); }
      });
    });
  },
  async setLocal(data) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(data, () => {
        if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); } else { resolve(); }
      });
    });
  },
  async removeLocal(key) {
    if (typeof key !== 'string' && !Array.isArray(key)) { logger.error('Storage:removeLocal', 'Invalid key type provided', { key }); return Promise.reject(new Error('Invalid key type for removeLocal')); }
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(key, () => { if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); } else { resolve(); } });
    });
  },
  async getPacketImages() {
    try { const data = await this.getLocal(CONFIG.STORAGE_KEYS.PACKET_IMAGES); return data[CONFIG.STORAGE_KEYS.PACKET_IMAGES] || {}; }
    catch (error) { logger.error('Storage', 'Error getting packet images', error); return {}; }
  },
  async getPacketImage(imageId) {
      try { const images = await this.getPacketImages(); return images[imageId] || null; }
      catch (error) { logger.error('Storage', 'Error getting single packet image', { imageId, error }); return null; }
  },
  async savePacketImage(image) {
      if (!image || !image.id) { logger.error('Storage', 'Attempted to save invalid packet image', image); return false; }
      try { const images = await this.getPacketImages(); images[image.id] = image; await this.setLocal({ [CONFIG.STORAGE_KEYS.PACKET_IMAGES]: images }); return true; }
      catch (error) { logger.error('Storage', 'Error saving packet image', { imageId: image.id, error }); return false; }
  },
  async deletePacketImage(imageId) {
       if (!imageId) return false;
       try { const images = await this.getPacketImages(); let deleted = false; if (images[imageId]) { delete images[imageId]; await this.setLocal({ [CONFIG.STORAGE_KEYS.PACKET_IMAGES]: images }); deleted = true; } logger.log('Storage', `Packet image ${deleted ? 'deleted' : 'not found'}`, { imageId }); return deleted; }
       catch (error) { logger.error('Storage', 'Error deleting packet image', { imageId, error }); return false; }
  },
  async getPacketInstances() {
    try { const data = await this.getLocal(CONFIG.STORAGE_KEYS.PACKET_INSTANCES); const instances = data[CONFIG.STORAGE_KEYS.PACKET_INSTANCES] || {}; Object.values(instances).forEach(inst => { inst.contents = Array.isArray(inst.contents) ? inst.contents : []; inst.visitedUrls = Array.isArray(inst.visitedUrls) ? inst.visitedUrls : []; if (!Array.isArray(inst.visitedGeneratedPageIds)) inst.visitedGeneratedPageIds = []; delete inst.tabGroupId; }); return instances; }
    catch (error) { logger.error('Storage', 'Error getting packet instances', error); return {}; }
  },
  async getPacketInstance(instanceId) {
      try { const instances = await this.getPacketInstances(); const instance = instances[instanceId] || null; if (instance) delete instance.tabGroupId; return instance; }
      catch (error) { logger.error('Storage', 'Error getting single packet instance', { instanceId, error }); return null; }
  },
  async savePacketInstance(instance) {
      if (!instance || !instance.instanceId) { logger.error('Storage', 'Attempted to save invalid packet instance', instance); return false; }
      try { const coreInstance = { ...instance }; coreInstance.contents = Array.isArray(coreInstance.contents) ? coreInstance.contents : []; coreInstance.visitedUrls = Array.isArray(coreInstance.visitedUrls) ? coreInstance.visitedUrls : []; coreInstance.visitedGeneratedPageIds = Array.isArray(coreInstance.visitedGeneratedPageIds) ? coreInstance.visitedGeneratedPageIds : []; delete coreInstance.tabGroupId; const instances = await this.getPacketInstances(); instances[coreInstance.instanceId] = coreInstance; await this.setLocal({ [CONFIG.STORAGE_KEYS.PACKET_INSTANCES]: instances }); return true; }
      catch (error) { logger.error('Storage', 'Error saving packet instance', { instanceId: instance.instanceId, error }); return false; }
  },
  async deletePacketInstance(instanceId) {
       if (!instanceId) return false;
       try { const instances = await this.getPacketInstances(); let deleted = false; if (instances[instanceId]) { delete instances[instanceId]; await this.setLocal({ [CONFIG.STORAGE_KEYS.PACKET_INSTANCES]: instances }); deleted = true; } logger.log('Storage', `Packet instance ${deleted ? 'deleted' : 'not found'}`, { instanceId }); return deleted; }
       catch (error) { logger.error('Storage', 'Error deleting packet instance', { instanceId, error }); return false; }
  },
  async getInstanceCountForImage(imageId) {
       if (!imageId) return 0;
       try { const instances = await this.getPacketInstances(); let count = 0; for (const instanceId in instances) { if (instances[instanceId]?.imageId === imageId) count++; } return count; }
       catch (error) { logger.error('Storage', 'Error counting instances for image', { imageId, error }); return 0; }
  },
  async getAllPacketBrowserStates() {
    try { const data = await this.getLocal(CONFIG.STORAGE_KEYS.PACKET_BROWSER_STATES); const states = data[CONFIG.STORAGE_KEYS.PACKET_BROWSER_STATES] || {}; Object.values(states).forEach(state => { state.instanceId = state.instanceId || null; state.tabGroupId = typeof state.tabGroupId === 'number' ? state.tabGroupId : null; state.activeTabIds = Array.isArray(state.activeTabIds) ? state.activeTabIds : []; state.lastActiveUrl = typeof state.lastActiveUrl === 'string' ? state.lastActiveUrl : null; }); return states; }
    catch (error) { logger.error('Storage', 'Error getting all packet browser states', error); return {}; }
  },
  async getPacketBrowserState(instanceId) {
      if (!instanceId) return null;
      try { const states = await this.getAllPacketBrowserStates(); const state = states[instanceId] || null; return state; }
      catch (error) { logger.error('Storage', 'Error getting single packet browser state', { instanceId, error }); return null; }
  },
  async savePacketBrowserState(state) {
      if (!state || !state.instanceId) { logger.error('Storage', 'Attempted to save invalid packet browser state', state); return false; }
      try { const stateToSave = { instanceId: state.instanceId, tabGroupId: typeof state.tabGroupId === 'number' ? state.tabGroupId : null, activeTabIds: Array.isArray(state.activeTabIds) ? state.activeTabIds : [], lastActiveUrl: typeof state.lastActiveUrl === 'string' ? state.lastActiveUrl : null }; const states = await this.getAllPacketBrowserStates(); states[state.instanceId] = stateToSave; await this.setLocal({ [CONFIG.STORAGE_KEYS.PACKET_BROWSER_STATES]: states }); return true; }
      catch (error) { logger.error('Storage', 'Error saving packet browser state', { instanceId: state.instanceId, error }); return false; }
  },
  async deletePacketBrowserState(instanceId) {
       if (!instanceId) return false;
       try { const states = await this.getAllPacketBrowserStates(); let deleted = false; if (states[instanceId]) { delete states[instanceId]; await this.setLocal({ [CONFIG.STORAGE_KEYS.PACKET_BROWSER_STATES]: states }); deleted = true; } logger.log('Storage', `Packet browser state ${deleted ? 'deleted' : 'not found'}`, { instanceId }); return deleted; }
       catch (error) { logger.error('Storage', 'Error deleting packet browser state', { instanceId, error }); return false; }
  },
  async getSettings() {
    try {
      const data = await this.getLocal(CONFIG.STORAGE_KEYS.SETTINGS);
      const storedSettings = data[CONFIG.STORAGE_KEYS.SETTINGS] || {};
      const defaults = JSON.parse(JSON.stringify(CONFIG.DEFAULT_SETTINGS));

      let mergedSettings = { ...defaults, ...storedSettings };

      // Deep merge for llmModels to preserve defaults if stored is empty/invalid
      if (!Array.isArray(mergedSettings.llmModels) || mergedSettings.llmModels.length === 0) {
        mergedSettings.llmModels = defaults.llmModels;
      }
      mergedSettings.llmModels = mergedSettings.llmModels.filter(model =>
        model && typeof model.id === 'string' && typeof model.name === 'string' && typeof model.providerType === 'string'
      );
      const selectedModelExists = mergedSettings.llmModels.some(m => m.id === mergedSettings.selectedModelId);
      if (!mergedSettings.selectedModelId || !selectedModelExists) {
          mergedSettings.selectedModelId = mergedSettings.llmModels.length > 0 ? mergedSettings.llmModels[0].id : null;
      }

      // Ensure storageConfigs is an array
      if (!Array.isArray(mergedSettings.storageConfigs)) {
        mergedSettings.storageConfigs = defaults.storageConfigs;
      }
      mergedSettings.storageConfigs = mergedSettings.storageConfigs.filter(sc => 
        sc && typeof sc.id === 'string' && typeof sc.name === 'string' && typeof sc.provider === 'string'
      );
      const activeStorageExists = mergedSettings.storageConfigs.some(sc => sc.id === mergedSettings.activeStorageId);
      if (!mergedSettings.activeStorageId || !activeStorageExists) {
        mergedSettings.activeStorageId = mergedSettings.storageConfigs.length > 0 ? mergedSettings.storageConfigs[0].id : null;
      }

      // Clean up old, flat storage provider settings if they exist
      delete mergedSettings.storageProvider;
      delete mergedSettings.digitalOcean;
      delete mergedSettings.awsS3;

      if (!['auto', 'light', 'dark'].includes(mergedSettings.themePreference)) {
        mergedSettings.themePreference = defaults.themePreference;
      }
      if (typeof mergedSettings.tabGroupsEnabled !== 'boolean') {
        mergedSettings.tabGroupsEnabled = defaults.tabGroupsEnabled;
      }
      if (typeof mergedSettings.preferAudio !== 'boolean') {
        mergedSettings.preferAudio = defaults.preferAudio;
      }
      return mergedSettings;
    } catch (error) {
      logger.error('Storage', 'Error getting settings, returning full defaults', error);
      return JSON.parse(JSON.stringify(CONFIG.DEFAULT_SETTINGS));
    }
  },
  async saveSettings(settings) {
    try {
      // Validate LLM models
      if (!Array.isArray(settings.llmModels)) {
        settings.llmModels = CONFIG.DEFAULT_SETTINGS.llmModels;
      }
      const validModelIds = settings.llmModels.map(m => m.id);
      if (!settings.selectedModelId || !validModelIds.includes(settings.selectedModelId)) {
        settings.selectedModelId = validModelIds.length > 0 ? validModelIds[0] : null;
      }

      // Validate Storage configs
      if (!Array.isArray(settings.storageConfigs)) {
        settings.storageConfigs = CONFIG.DEFAULT_SETTINGS.storageConfigs;
      }
       const validStorageIds = settings.storageConfigs.map(s => s.id);
      if (!settings.activeStorageId || !validStorageIds.includes(settings.activeStorageId)) {
        settings.activeStorageId = validStorageIds.length > 0 ? validStorageIds[0] : null;
      }

      const data = { [CONFIG.STORAGE_KEYS.SETTINGS]: settings };
      await this.setLocal(data);
      logger.log('Storage', 'Settings saved.');
      return true;
    } catch (error) {
      logger.error('Storage', 'Error saving settings', error);
      return false;
    }
  },
  async getActiveModelConfig() {
    try {
      const settings = await this.getSettings();
      if (!settings.selectedModelId || !Array.isArray(settings.llmModels)) {
        logger.warn('Storage:getActiveModelConfig', 'No selectedModelId or llmModels array found in settings.');
        return null;
      }
      const activeModel = settings.llmModels.find(model => model.id === settings.selectedModelId);
      if (!activeModel) {
        logger.warn('Storage:getActiveModelConfig', `Selected model ID '${settings.selectedModelId}' not found in llmModels.`, {llmModels: settings.llmModels});
        if (settings.llmModels.length > 0) {
            logger.warn('Storage:getActiveModelConfig', `Falling back to the first available model: ${settings.llmModels[0].name}`);
            return settings.llmModels[0];
        }
        return null;
      }
      return {
          id: activeModel.id,
          name: activeModel.name,
          providerType: activeModel.providerType,
          apiKey: activeModel.apiKey || (activeModel.providerType === 'chrome-ai-gemini-nano' ? null : ''),
          modelName: activeModel.modelName || (activeModel.providerType === 'chrome-ai-gemini-nano' ? 'gemini-nano' : ''),
          apiEndpoint: activeModel.apiEndpoint || (activeModel.providerType === 'chrome-ai-gemini-nano' ? null : ''),
      };
    } catch (error) {
      logger.error('Storage', 'Error getting active model config', error);
      return null;
    }
  },
  async isCloudStorageEnabled() {
    try {
      const settings = await this.getSettings();
      if (!settings.activeStorageId || !Array.isArray(settings.storageConfigs) || settings.storageConfigs.length === 0) {
        return false;
      }
      const activeConfig = settings.storageConfigs.find(c => c.id === settings.activeStorageId);
      if (!activeConfig) return false;
      
      const creds = activeConfig.credentials;
      return !!(creds && creds.accessKey && creds.secretKey && activeConfig.bucket && activeConfig.region);
    } catch (error) {
      logger.error('Storage', 'Error checking Cloud Storage status', error);
      return false;
    }
  },
  async getActiveCloudStorageConfig() {
    try {
      const settings = await this.getSettings();
      if (!settings.activeStorageId || !Array.isArray(settings.storageConfigs)) {
        return null;
      }
      return settings.storageConfigs.find(c => c.id === settings.activeStorageId) || null;
    } catch (error) {
      logger.error('Storage', 'Error getting active cloud storage config', error);
      return null;
    }
  },
  async getSession(key) {
    return new Promise((resolve, reject) => { if (!chrome.storage?.session) return resolve({}); chrome.storage.session.get(key, (result) => { if (chrome.runtime.lastError) { if (chrome.runtime.lastError.message?.includes('QUOTA_BYTES_PER_SESSION')) { resolve({}); } else { reject(chrome.runtime.lastError); } } else { resolve(result || {}); } }); });
  },
  async setSession(data) {
    return new Promise((resolve, reject) => { if (!chrome.storage?.session) return resolve(false); chrome.storage.session.set(data, () => { if (chrome.runtime.lastError) { if (chrome.runtime.lastError.message?.includes('QUOTA_BYTES_PER_SESSION')) { resolve(false); } else { reject(chrome.runtime.lastError); } } else { resolve(true); } }); });
  },
  async removeSession(key) {
    if (typeof key !== 'string' && !Array.isArray(key)) return Promise.reject(new Error('Invalid key type'));
    return new Promise((resolve, reject) => { if (!chrome.storage?.session) return resolve(); chrome.storage.session.remove(key, () => { if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); } else { resolve(); } }); });
  }
};

const packetUtils = {
  isPacketInstanceCompleted(instance) {
    if (!instance || !Array.isArray(instance.contents)) return false;

    // FIX: A PacketInstance's contents are resolved and do not contain 'alternative' wrappers.
    // The list of trackable items is simply all items that have a URL or a pageId.
    const trackableItems = instance.contents.filter(item => 
        (item.type === 'external' && item.url) || 
        ((item.type === 'generated' || item.type === 'media') && item.pageId)
    );
    
    const totalCount = trackableItems.length;
    if (totalCount === 0) return false;

    const visitedUrlsSet = new Set(instance.visitedUrls || []);
    const visitedGeneratedIdsSet = new Set(instance.visitedGeneratedPageIds || []);
    let visitedCount = 0;
    
    trackableItems.forEach(item => {
        if ((item.type === 'generated' || item.type === 'media') && item.pageId && visitedGeneratedIdsSet.has(item.pageId)) {
            visitedCount++;
        } else if (item.type === 'external' && item.url && visitedUrlsSet.has(item.url)) {
            visitedCount++;
        }
    });
    
    return visitedCount >= totalCount;
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
                const itemCanonicalReference = decodeURIComponent(item.url);
                if (urlToCompare === itemCanonicalReference) {
                    return options.returnItem ? item : true;
                }
            } else if (item.type === 'generated' || item.type === 'media') {
                try {
                    const loadedUrlObj = new URL(urlToCompare);
                    const { publishContext } = item;

                    if (publishContext) {
                        let expectedPathname;
                        if (publishContext.provider === 'google') {
                            expectedPathname = `/${publishContext.bucket}/${item.url}`;
                        } else {
                            expectedPathname = `/${item.url}`;
                        }

                        if (loadedUrlObj.pathname === expectedPathname) {
                            return options.returnItem ? item : true;
                        }
                    }
                } catch (e) {
                    logger.warn('Utils:isUrlInPacket', 'Could not parse loaded URL', { url: urlToCompare, error: e.message });
                }
            }
        }
    }
    return options.returnItem ? null : false;
  },

  getColorForTopic(topic) {
    const colors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
    if (!topic) return colors[0];
    let hash = 0; for (let i = 0; i < topic.length; i++) { hash = ((hash << 5) - hash) + topic.charCodeAt(i); hash |= 0; }
    return colors[Math.abs(hash) % colors.length];
  },
  async markUrlAsVisited(instanceId, url) {
    if (!instanceId || !url) {
        logger.warn('PacketUtils:markUrlAsVisited', 'Missing instanceId or url', { instanceId, url });
        return { success: false, error: 'Missing instanceId or url', instance: null, modified: false, alreadyVisited: false, notTrackable: false, justCompleted: false };
    }
    let instance = null; let instanceModified = false; let isGenerated = false; let pageIdToMark = null; let alreadyVisited = false; let isTrackable = false; let foundItem = null; let justCompleted = false;
    try {
        instance = await storage.getPacketInstance(instanceId);
        if (!instance) throw new Error('Packet instance not found');
        const wasCompletedBefore = this.isPacketInstanceCompleted(instance);

        // Directly find the item by its canonical URL (S3 key or external URL)
        foundItem = instance.contents.find(item => item.url === url);
        // If not found in the main list, check inside "alternative" content wrappers
        if (!foundItem) {
            for (const altWrapper of instance.contents.filter(i => i.type === 'alternative')) {
                if (altWrapper.alternatives) {
                    foundItem = altWrapper.alternatives.find(alt => alt.url === url);
                    if (foundItem) break;
                }
            }
        }

        if (foundItem) {
             isTrackable = true;
             pageIdToMark = foundItem.pageId;
             if ((foundItem.type === 'generated' || foundItem.type === 'media') && pageIdToMark) {
                 isGenerated = true;
                 alreadyVisited = (instance.visitedGeneratedPageIds || []).includes(pageIdToMark);
             } else if (foundItem.type === 'external') {
                 isGenerated = false;
                 alreadyVisited = (instance.visitedUrls || []).includes(url);
             } else {
                 logger.warn('PacketUtils:markUrlAsVisited', 'Found item has unexpected structure or missing pageId for generated type', { item: foundItem });
                 isTrackable = false;
             }
        } else {
            logger.log('PacketUtils:markUrlAsVisited', 'URL not found in instance contents when trying to mark visit.', { urlToMark: url, instanceId });
        }

        if (!isTrackable) {
            return { success: true, instance, modified: false, notTrackable: true, alreadyVisited: false, justCompleted: false };
        }

        if (!alreadyVisited) {
             if (isGenerated && pageIdToMark) {
                 if (!instance.visitedGeneratedPageIds) instance.visitedGeneratedPageIds = [];
                 instance.visitedGeneratedPageIds.push(pageIdToMark);
                 logger.log('PacketUtils:markUrlAsVisited', 'Marking GENERATED page ID as visited', { pageId: pageIdToMark, instanceId });
             } else {
                 if (!instance.visitedUrls) instance.visitedUrls = [];
                 instance.visitedUrls.push(url);
                 logger.log('PacketUtils:markUrlAsVisited', 'Marking EXTERNAL URL as visited', { url, instanceId });
             }
             instanceModified = true;
             const saved = await storage.savePacketInstance(instance);
              if (!saved) {
                  logger.error('PacketUtils:markUrlAsVisited', 'Failed to save instance after marking visit.');
                  if (isGenerated && pageIdToMark) {
                    const index = instance.visitedGeneratedPageIds.lastIndexOf(pageIdToMark);
                    if (index > -1) instance.visitedGeneratedPageIds.splice(index, 1);
                  } else {
                    const index = instance.visitedUrls.lastIndexOf(url);
                    if (index > -1) instance.visitedUrls.splice(index, 1);
                  }
                  instanceModified = false;
                  throw new Error('Failed to save instance after marking visit.');
              }
              logger.log('PacketUtils:markUrlAsVisited', 'Instance saved after marking visit.');
              const isCompletedAfter = this.isPacketInstanceCompleted(instance);
              if (isCompletedAfter && !wasCompletedBefore) {
                  justCompleted = true;
                  logger.log('PacketUtils:markUrlAsVisited', `Packet ${instanceId} just completed!`);
              }
        } else {
            logger.log('PacketUtils:markUrlAsVisited', 'Item already marked as visited', { url: url, pageId: pageIdToMark, instanceId });
        }
        return { success: true, instance, modified: instanceModified, alreadyVisited: alreadyVisited, notTrackable: !isTrackable, justCompleted: justCompleted };
    } catch (error) {
         logger.error('PacketUtils:markUrlAsVisited', `Error marking item visited for ${instanceId}, url ${url}`, error);
         return { success: false, instance: instance, modified: false, error: error.message, alreadyVisited: false, notTrackable: false, justCompleted: false };
    }
  },
  async markPageIdAsVisited(instanceId, pageId) {
    if (!instanceId || !pageId) {
        logger.warn('PacketUtils:markPageIdAsVisited', 'Missing instanceId or pageId', { instanceId, pageId });
        return { success: false, error: 'Missing instanceId or pageId' };
    }
    try {
        const instance = await storage.getPacketInstance(instanceId);
        if (!instance) throw new Error('Packet instance not found');

        const wasCompletedBefore = this.isPacketInstanceCompleted(instance);
        
        if (!instance.visitedGeneratedPageIds) instance.visitedGeneratedPageIds = [];
        
        if (instance.visitedGeneratedPageIds.includes(pageId)) {
            logger.log('PacketUtils:markPageIdAsVisited', 'Page ID already marked as visited', { pageId, instanceId });
            return { success: true, instance, modified: false, alreadyVisited: true, justCompleted: false };
        }

        instance.visitedGeneratedPageIds.push(pageId);
        const saved = await storage.savePacketInstance(instance);
        if (!saved) {
            throw new Error('Failed to save instance after marking page ID as visited.');
        }

        const isCompletedAfter = this.isPacketInstanceCompleted(instance);
        const justCompleted = isCompletedAfter && !wasCompletedBefore;
        if (justCompleted) {
            logger.log('PacketUtils:markPageIdAsVisited', `Packet ${instanceId} just completed by visiting pageId ${pageId}!`);
        }

        return { success: true, instance, modified: true, alreadyVisited: false, justCompleted };
    } catch (error) {
        logger.error('PacketUtils:markPageIdAsVisited', `Error marking pageId ${pageId} visited for ${instanceId}`, error);
        return { success: false, error: error.message };
    }
  },
  getDefaultGeneratedPageUrl(instance) {
    if (!instance || !Array.isArray(instance.contents)) return null;
    const generatedPage = this.getGeneratedPages(instance)[0];
    return generatedPage ? generatedPage.url : null;
  },
  getGeneratedPages(instance) {
      if (!instance || !Array.isArray(instance.contents)) return [];
      
      const pages = [];
      instance.contents.forEach(item => {
          if (item.type === 'generated') {
              pages.push(item);
          } else if (item.type === 'alternative') {
              pages.push(...item.alternatives.filter(alt => alt.type === 'generated'));
          }
      });
      return pages;
  }
};

function getPacketContextKey(tabId) { return `${CONFIG.STORAGE_KEYS.PACKET_CONTEXT_PREFIX}${tabId}`; }
async function getPacketContext(tabId) { if (typeof tabId !== 'number') return null; const storageKey = getPacketContextKey(tabId); try { const data = await storage.getLocal(storageKey); return (data && data[storageKey]) ? data[storageKey] : null; } catch (error) { logger.error('Utils:getPacketContext', 'Error getting context', { tabId, error }); return null; } }
async function setPacketContext(tabId, instanceId, packetUrl, currentUrl) { if (typeof tabId !== 'number' || !instanceId || !packetUrl || !currentUrl) { logger.error('Utils:setPacketContext', 'Invalid arguments', {tabId, instanceId, packetUrl, currentUrl}); return false; } const storageKey = getPacketContextKey(tabId); try { const contextToStore = { instanceId, packetUrl, currentUrl }; await storage.setLocal({ [storageKey]: contextToStore }); return true; } catch (error) { logger.error('Utils:setPacketContext', 'Error setting context', { tabId, error }); return false; } }
async function clearPacketContext(tabId) { if (typeof tabId !== 'number') return; const storageKey = getPacketContextKey(tabId); try { const data = await storage.getLocal(storageKey); if (data && data[storageKey]) await storage.removeLocal(storageKey); } catch (error) { logger.error('Utils:clearPacketContext', 'Error clearing context', { key: storageKey, error }); } }

function isTabGroupsAvailable() { return typeof chrome?.tabGroups?.update === 'function' && typeof chrome?.tabs?.group === 'function'; }
function isSidePanelAvailable() { return typeof chrome?.sidePanel?.open === 'function'; }

export async function isChromeAiAvailable() {
  if (typeof globalThis.LanguageModel?.create === 'function') {
    try {
      return true;
    } catch (e) {
      logger.warn('Utils:isChromeAiAvailable', 'Error during Chrome AI availability check (e.g. model not available/loaded)', e);
      return false;
    }
  }
  return false;
}

let currentThemeListener = null;
async function applyThemeMode() { try { const settings = await storage.getSettings(); const preference = settings.themePreference || 'auto'; if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.body) { const prefersDark = window.matchMedia('(prefers-color-scheme: dark)'); let darkModeEnabled = (preference === 'dark') || (preference === 'auto' && prefersDark.matches); document.body.classList.toggle('dark-mode', darkModeEnabled); document.body.classList.toggle('light-mode', !darkModeEnabled); if (currentThemeListener) { prefersDark.removeEventListener('change', currentThemeListener); currentThemeListener = null; } if (preference === 'auto') { currentThemeListener = () => applyThemeMode(); prefersDark.addEventListener('change', currentThemeListener); } } } catch (error) { logger.error('Utils:applyThemeMode', 'Error applying theme mode', error); if (typeof document !== 'undefined' && document.body) { document.body.classList.remove('dark-mode'); document.body.classList.add('light-mode'); } } }

async function shouldUseTabGroups() { if (!isTabGroupsAvailable()) return false; try { const settings = await storage.getSettings(); return typeof settings.tabGroupsEnabled === 'boolean' ? settings.tabGroupsEnabled : true; } catch (error) { logger.error('Utils:shouldUseTabGroups', 'Error getting settings, defaulting to false', error); return false; } }

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64Decode(base64) {
    try {
        const binaryString = atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    } catch (error) {
        logger.error('Utils:base64Decode', 'Error decoding base64', error);
        return null;
    }
}

function sanitizeForFileName(input) {
  if (!input) return '';
  return input
    .toLowerCase()
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/[^a-z0-9_.-]/g, '') // Remove all non-alphanumeric characters except underscore, dot, hyphen
    .replace(/-+/g, '-') // Replace multiple hyphens with a single one
    .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
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