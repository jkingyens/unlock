// ext/sidebar-modules/settings-view.js
// Manages the entire Settings view UI and logic.

import { domRefs } from './dom-references.js';
import { showConfirmDialog } from './dialog-handler.js';
import { logger, storage, applyThemeMode, isTabGroupsAvailable, isChromeAiAvailable, CONFIG } from '../utils.js';

// --- Module-specific State ---
let currentLlmModelsSetting = [];
let currentSelectedModelIdSetting = null;
let editingLlmModelId = null;

let currentStorageConfigsSetting = [];
let currentActiveStorageIdSetting = null;
let editingStorageConfigId = null;

let settingsSaveTimeout;
const DEBOUNCE_DELAY = 750;

// --- Dependencies from main sidebar ---
let showSettingsStatus;
let sendMessageToBackground;
let showConfetti;

// --- Initialization ---

/**
 * Injects dependencies from the main sidebar module.
 * @param {object} dependencies - The dependencies to inject.
 */
export function init(dependencies) {
    showSettingsStatus = dependencies.showSettingsStatus;
    sendMessageToBackground = dependencies.sendMessageToBackground;
    showConfetti = dependencies.showConfetti;
}

/**
 * Triggers an immediate save if one is scheduled.
 */
export function triggerPendingSave() {
    if (settingsSaveTimeout) {
        clearTimeout(settingsSaveTimeout);
        settingsSaveTimeout = null;
        gatherAndSaveSettings();
        logger.log('SettingsView', 'Pending settings save triggered immediately by navigation.');
    }
}

/**
 * Attaches event listeners specific to the settings view.
 */
export function setupSettingsListeners() {
    const s = domRefs;
    if (!s.settingsView) return;

    // --- Helper to request a debounced save ---
    function requestSave() {
        clearTimeout(settingsSaveTimeout);
        settingsSaveTimeout = setTimeout(gatherAndSaveSettings, DEBOUNCE_DELAY);
    }

    // LLM Listeners
    s.llmAddNewModelBtn?.addEventListener('click', () => showLlmEditForm(null));
    s.llmEditFormCancelBtn?.addEventListener('click', hideLlmEditForm);
    s.llmEditFormSaveBtn?.addEventListener('click', saveLlmModelFromForm);
    s.llmEditProviderTypeSelect?.addEventListener('change', updateLlmEditFormVisibility);
    s.toggleLlmEditApiKeyVisibilityBtn?.addEventListener('click', () => toggleVisibility(s.llmEditApiKeyInput, s.toggleLlmEditApiKeyVisibilityBtn));
    s.llmModelsList?.addEventListener('click', (event) => {
        const modelItem = event.target.closest('.llm-model-item');
        if (!modelItem) return;
        const modelId = modelItem.dataset.modelId;

        if (event.target.classList.contains('edit-llm-model-btn')) showLlmEditForm(modelId);
        else if (event.target.classList.contains('delete-llm-model-btn')) deleteLlmModel(modelId);
        else if (event.target.name === 'activeLlmModelRadio' && event.target.checked) {
            currentSelectedModelIdSetting = event.target.value;
            requestSave();
        }
    });

    // S3 Storage Listeners
    s.s3AddNewConfigBtn?.addEventListener('click', () => showStorageEditForm(null));
    s.s3EditFormCancelBtn?.addEventListener('click', hideStorageEditForm);
    s.s3EditFormSaveBtn?.addEventListener('click', saveStorageConfigFromForm);
    s.toggleS3AccessKeyVisibilityBtn?.addEventListener('click', () => toggleVisibility(s.s3EditAccessKeyInput, s.toggleS3AccessKeyVisibilityBtn));
    s.toggleS3SecretKeyVisibilityBtn?.addEventListener('click', () => toggleVisibility(s.s3EditSecretKeyInput, s.toggleS3SecretKeyVisibilityBtn));
    s.s3ConfigsList?.addEventListener('click', (event) => {
        const configItem = event.target.closest('.llm-model-item');
        if (!configItem) return;
        const configId = configItem.dataset.configId;

        if (event.target.classList.contains('edit-s3-config-btn')) showStorageEditForm(configId);
        else if (event.target.classList.contains('delete-s3-config-btn')) deleteStorageConfig(configId);
        else if (event.target.name === 'activeStorageRadio' && event.target.checked) {
            currentActiveStorageIdSetting = event.target.value;
            requestSave();
        }
    });

    // Other Settings
    s.themeRadios?.forEach(radio => radio.addEventListener('change', requestSave));
    s.tabGroupsEnabledCheckbox?.addEventListener('change', requestSave);
    s.mediaOverlayEnabledCheckbox?.addEventListener('change', requestSave);
    s.preferAudioEnabledCheckbox?.addEventListener('change', requestSave);
    s.waveformLinkMarkersEnabledCheckbox?.addEventListener('change', requestSave);
    s.visitThresholdSecondsInput?.addEventListener('change', requestSave);
    s.quickCopyEnabledCheckbox?.addEventListener('change', requestSave);
    s.confettiEnabledCheckbox?.addEventListener('change', (event) => {
        requestSave();
        if (event.target.checked && typeof showConfetti === 'function') {
            showConfetti('Settings Preview');
        }
    });
    s.llmHelpLink?.addEventListener('click', (e) => { e.preventDefault(); openHelpPage('llm_help.html'); });
    s.s3HelpLink?.addEventListener('click', (e) => { e.preventDefault(); openHelpPage('s3_help.html'); });
    
    // ElevenLabs API Key
    const elevenLabsApiKeyInput = document.getElementById('elevenlabs-api-key');
    const toggleElevenlabsApiKeyVisibilityBtn = document.getElementById('toggle-elevenlabs-api-key-visibility');

    if (elevenLabsApiKeyInput) {
        elevenLabsApiKeyInput.addEventListener('change', requestSave);
    }
    if (toggleElevenlabsApiKeyVisibilityBtn) {
        toggleElevenlabsApiKeyVisibilityBtn.addEventListener('click', () => toggleVisibility(elevenLabsApiKeyInput, toggleElevenlabsApiKeyVisibilityBtn));
    }
}

/**
 * Prepares the settings view by loading current settings and checking for feature availability.
 */
export async function prepareSettingsView() {
    await loadSettings();
}


// --- Data & Rendering ---

async function loadSettings() {
    try {
        const loadedSettings = await storage.getSettings();
        
        currentLlmModelsSetting = loadedSettings.llmModels || [];
        currentSelectedModelIdSetting = loadedSettings.selectedModelId;
        renderLlmModelsList();
        hideLlmEditForm();
        
        currentStorageConfigsSetting = loadedSettings.storageConfigs || [];
        currentActiveStorageIdSetting = loadedSettings.activeStorageId || null;
        renderStorageConfigsList();
        hideStorageEditForm();

        domRefs.tabGroupsEnabledCheckbox.checked = loadedSettings.tabGroupsEnabled ?? true;
        domRefs.tabGroupsEnabledCheckbox.disabled = !isTabGroupsAvailable();
        domRefs.tabGroupsEnabledCheckbox.parentElement.style.opacity = isTabGroupsAvailable() ? '1' : '0.6';
        domRefs.tabGroupsEnabledCheckbox.parentElement.title = isTabGroupsAvailable() ? '' : 'Tab Groups API not available in this browser version.';

        domRefs.confettiEnabledCheckbox.checked = loadedSettings.confettiEnabled ?? true;
        domRefs.mediaOverlayEnabledCheckbox.checked = loadedSettings.mediaOverlayEnabled ?? true;
        domRefs.preferAudioEnabledCheckbox.checked = loadedSettings.preferAudio ?? false;
        domRefs.waveformLinkMarkersEnabledCheckbox.checked = loadedSettings.waveformLinkMarkersEnabled ?? true;
        domRefs.visitThresholdSecondsInput.value = loadedSettings.visitThresholdSeconds ?? 5;
        domRefs.quickCopyEnabledCheckbox.checked = loadedSettings.quickCopyEnabled ?? true;

        const theme = loadedSettings.themePreference || 'auto';
        if (domRefs.themeAutoRadio) domRefs.themeAutoRadio.checked = theme === 'auto';
        if (domRefs.themeLightRadio) domRefs.themeLightRadio.checked = theme === 'light';
        if (domRefs.themeDarkRadio) domRefs.themeDarkRadio.checked = theme === 'dark';
        
        const elevenLabsApiKeyInput = document.getElementById('elevenlabs-api-key');
        if (elevenLabsApiKeyInput) {
            elevenLabsApiKeyInput.value = loadedSettings.elevenlabsApiKey || '';
        }

    } catch (error) {
        logger.error('SettingsView', 'Error loading settings into UI:', error);
        showSettingsStatus('Error loading settings', 'error');
    }
}

function renderLlmModelsList() {
    const listElement = domRefs.llmModelsList;
    if (!listElement) return;
    listElement.innerHTML = '';

    const modelsToRender = currentLlmModelsSetting;

    if (modelsToRender.length === 0) {
        listElement.innerHTML = '<p class="empty-state">No LLM configurations found.</p>';
        return;
    }

    modelsToRender.forEach(model => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'llm-model-item';
        itemDiv.dataset.modelId = model.id;
        const isChecked = model.id === currentSelectedModelIdSetting;
        itemDiv.innerHTML = `
            <input type="radio" name="activeLlmModelRadio" value="${model.id}" id="radio_llm_${model.id}" ${isChecked ? 'checked' : ''}>
            <label class="model-name-display" for="radio_llm_${model.id}">${model.name || 'Unnamed'}</label>
            <span class="model-type-display">${model.providerType || 'N/A'}</span>
            <button class="edit-llm-model-btn" title="Edit">Edit</button>
            <button class="delete-llm-model-btn" title="Delete">Del</button>
        `;
        listElement.appendChild(itemDiv);
    });
}

function renderStorageConfigsList() {
    const listElement = domRefs.s3ConfigsList;
    if (!listElement) return;
    listElement.innerHTML = '';

    if (currentStorageConfigsSetting.length === 0) {
        listElement.innerHTML = '<p class="empty-state">No storage configurations found.</p>';
        return;
    }

    currentStorageConfigsSetting.forEach(config => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'llm-model-item'; // Re-use style
        itemDiv.dataset.configId = config.id;
        const isChecked = config.id === currentActiveStorageIdSetting;
        itemDiv.innerHTML = `
            <input type="radio" name="activeStorageRadio" value="${config.id}" id="radio_s3_${config.id}" ${isChecked ? 'checked' : ''}>
            <label class="model-name-display" for="radio_s3_${config.id}">${config.name || 'Unnamed'}</label>
            <span class="model-type-display">${config.provider || 'N/A'}</span>
            <button class="edit-s3-config-btn" title="Edit">Edit</button>
            <button class="delete-s3-config-btn" title="Delete">Del</button>
        `;
        listElement.appendChild(itemDiv);
    });
}


// --- Form & Action Handlers ---

function debounceSaveSettings() {
    clearTimeout(settingsSaveTimeout);
    settingsSaveTimeout = setTimeout(gatherAndSaveSettings, DEBOUNCE_DELAY);
}

async function gatherAndSaveSettings() {
    showSettingsStatus('Saving...', 'info', false);
    try {
        const oldSettings = await storage.getSettings();
        let visitThreshold = parseInt(domRefs.visitThresholdSecondsInput.value, 10);
        if (isNaN(visitThreshold) || visitThreshold < 1) {
            visitThreshold = 5; // Fallback to default if input is invalid
        }

        const settingsToSave = {
            llmModels: currentLlmModelsSetting,
            selectedModelId: currentSelectedModelIdSetting,
            storageConfigs: currentStorageConfigsSetting,
            activeStorageId: currentActiveStorageIdSetting,
            themePreference: domRefs.themeLightRadio.checked ? 'light' : (domRefs.themeDarkRadio.checked ? 'dark' : 'auto'),
            tabGroupsEnabled: domRefs.tabGroupsEnabledCheckbox.checked,
            mediaOverlayEnabled: domRefs.mediaOverlayEnabledCheckbox.checked,
            preferAudio: domRefs.preferAudioEnabledCheckbox.checked,
            waveformLinkMarkersEnabled: domRefs.waveformLinkMarkersEnabledCheckbox.checked,
            confettiEnabled: domRefs.confettiEnabledCheckbox.checked,
            visitThresholdSeconds: visitThreshold,
            quickCopyEnabled: domRefs.quickCopyEnabledCheckbox.checked,
            elevenlabsApiKey: document.getElementById('elevenlabs-api-key').value.trim()
        };
        await storage.saveSettings(settingsToSave);
        showSettingsStatus('Settings saved.', 'success');
        
        if (oldSettings.themePreference !== settingsToSave.themePreference) {
            await applyThemeMode();
            await sendMessageToBackground({ action: 'theme_preference_updated' });
        }
        if (oldSettings.mediaOverlayEnabled !== settingsToSave.mediaOverlayEnabled) {
            await sendMessageToBackground({ action: 'overlay_setting_updated' });
        }

    } catch (error) {
        showSettingsStatus(`Error saving: ${error.message}`, 'error', false);
    }
}

// ... LLM Form Handlers ...
function showLlmEditForm(modelId) {
    editingLlmModelId = modelId;
    const s = domRefs;
    if (modelId) {
        s.llmEditFormTitle.textContent = 'Edit LLM Configuration';
        const model = currentLlmModelsSetting.find(m => m.id === modelId);
        if (model) {
            s.llmEditModelIdInput.value = model.id;
            s.llmEditFriendlyNameInput.value = model.name;
            s.llmEditProviderTypeSelect.value = model.providerType;
            s.llmEditApiKeyInput.value = model.apiKey || '';
            s.llmEditModelNameInput.value = model.modelName || '';
            s.llmEditApiEndpointInput.value = model.apiEndpoint || '';
        }
    } else {
        s.llmEditFormTitle.textContent = 'Add New LLM Configuration';
        s.llmEditModelIdInput.value = '';
        s.llmEditFriendlyNameInput.value = '';
        s.llmEditProviderTypeSelect.value = 'openai';
        s.llmEditApiKeyInput.value = '';
        s.llmEditModelNameInput.value = '';
        s.llmEditApiEndpointInput.value = '';
    }
    s.llmEditApiKeyInput.type = 'password';
    s.toggleLlmEditApiKeyVisibilityBtn.textContent = 'Show';
    updateLlmEditFormVisibility();
    s.llmModelEditFormSection.classList.remove('hidden');
    s.llmAddNewModelBtn.classList.add('hidden');
}

function hideLlmEditForm() {
    editingLlmModelId = null;
    domRefs.llmModelEditFormSection?.classList.add('hidden');
    domRefs.llmAddNewModelBtn?.classList.remove('hidden');
}

function updateLlmEditFormVisibility() {
    const provider = domRefs.llmEditProviderTypeSelect.value;
    const needsApi = true;
    domRefs.llmEditApiKeyGroup.style.display = needsApi ? 'block' : 'none';
    domRefs.llmEditApiEndpointGroup.style.display = needsApi ? 'block' : 'none';
}

function saveLlmModelFromForm() {
    const s = domRefs;
    const modelData = {
        id: s.llmEditModelIdInput.value || `model_${Date.now()}`,
        name: s.llmEditFriendlyNameInput.value.trim() || 'Unnamed Model',
        providerType: s.llmEditProviderTypeSelect.value,
        apiKey: s.llmEditApiKeyInput.value.trim(),
        modelName: s.llmEditModelNameInput.value.trim(),
        apiEndpoint: s.llmEditApiEndpointInput.value.trim(),
    };

    const index = currentLlmModelsSetting.findIndex(m => m.id === modelData.id);
    if (index > -1) {
        currentLlmModelsSetting[index] = modelData;
    } else {
        currentLlmModelsSetting.push(modelData);
    }
    
    if (!currentLlmModelsSetting.some(m => m.id === currentSelectedModelIdSetting)) {
        currentSelectedModelIdSetting = currentLlmModelsSetting[0]?.id || null;
    }

    renderLlmModelsList();
    hideLlmEditForm();
    debounceSaveSettings();
}

async function deleteLlmModel(modelId) {
    const modelName = currentLlmModelsSetting.find(m => m.id === modelId)?.name || 'this model';
    if (!await showConfirmDialog(`Delete LLM configuration "${modelName}"?`, 'Delete', 'Cancel', true)) return;
    
    currentLlmModelsSetting = currentLlmModelsSetting.filter(m => m.id !== modelId);
    if (currentSelectedModelIdSetting === modelId) {
        currentSelectedModelIdSetting = currentLlmModelsSetting[0]?.id || null;
    }
    renderLlmModelsList();
    debounceSaveSettings();
}

// ... Storage Form Handlers ...
function showStorageEditForm(configId) {
    editingStorageConfigId = configId;
    const s = domRefs;
    if (configId) {
        s.s3EditFormTitle.textContent = 'Edit Storage Configuration';
        const config = currentStorageConfigsSetting.find(c => c.id === configId);
        if (config) {
            s.s3EditConfigIdInput.value = config.id;
            s.s3EditFriendlyNameInput.value = config.name;
            s.s3EditProviderTypeSelect.value = config.provider;
            s.s3EditAccessKeyInput.value = config.credentials?.accessKey || '';
            s.s3EditSecretKeyInput.value = config.credentials?.secretKey || '';
            s.s3EditBucketNameInput.value = config.bucket || '';
            s.s3EditRegionInput.value = config.region || '';
        }
    } else {
        s.s3EditFormTitle.textContent = 'Add New Storage Configuration';
        s.s3EditConfigIdInput.value = '';
        s.s3EditFriendlyNameInput.value = '';
        s.s3EditProviderTypeSelect.value = 'digitalocean';
        s.s3EditAccessKeyInput.value = '';
        s.s3EditSecretKeyInput.value = '';
        s.s3EditBucketNameInput.value = '';
        s.s3EditRegionInput.value = '';
    }
    s.s3EditAccessKeyInput.type = 'password';
    s.toggleS3AccessKeyVisibilityBtn.textContent = 'Show';
    s.s3EditSecretKeyInput.type = 'password';
    s.toggleS3SecretKeyVisibilityBtn.textContent = 'Show';
    s.s3ConfigEditFormSection.classList.remove('hidden');
    s.s3AddNewConfigBtn.classList.add('hidden');
}

function hideStorageEditForm() {
    editingStorageConfigId = null;
    domRefs.s3ConfigEditFormSection?.classList.add('hidden');
    domRefs.s3AddNewConfigBtn?.classList.remove('hidden');
}

function saveStorageConfigFromForm() {
    const s = domRefs;
    const configData = {
        id: s.s3EditConfigIdInput.value || `storage_${Date.now()}`,
        name: s.s3EditFriendlyNameInput.value.trim() || 'Unnamed Storage',
        provider: s.s3EditProviderTypeSelect.value,
        credentials: {
            accessKey: s.s3EditAccessKeyInput.value.trim(),
            secretKey: s.s3EditSecretKeyInput.value.trim(),
        },
        bucket: s.s3EditBucketNameInput.value.trim(),
        region: s.s3EditRegionInput.value.trim(),
    };
    if (Object.values(configData.credentials).some(v => !v) || !configData.bucket || !configData.region) {
        showSettingsStatus("All storage fields are required.", "error", false);
        return;
    }
    const index = currentStorageConfigsSetting.findIndex(c => c.id === configData.id);
    if (index > -1) {
        currentStorageConfigsSetting[index] = configData;
    } else {
        currentStorageConfigsSetting.push(configData);
    }

    if (!currentStorageConfigsSetting.some(c => c.id === currentActiveStorageIdSetting)) {
        currentActiveStorageIdSetting = currentStorageConfigsSetting[0]?.id || null;
    }

    renderStorageConfigsList();
    hideStorageEditForm();
    debounceSaveSettings();
}

async function deleteStorageConfig(configId) {
    const configName = currentStorageConfigsSetting.find(c => c.id === configId)?.name || 'this configuration';
    if (!await showConfirmDialog(`Delete storage configuration "${configName}"?`, 'Delete', 'Cancel', true)) return;

    currentStorageConfigsSetting = currentStorageConfigsSetting.filter(c => c.id !== configId);
    if (currentActiveStorageIdSetting === configId) {
        currentActiveStorageIdSetting = currentStorageConfigsSetting[0]?.id || null;
    }
    renderStorageConfigsList();
    debounceSaveSettings();
}

// --- Helpers ---
function toggleVisibility(input, button) {
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    button.textContent = isPassword ? 'Hide' : 'Show';
}

function openHelpPage(pageName) {
    chrome.tabs.create({ url: chrome.runtime.getURL(pageName) });
}