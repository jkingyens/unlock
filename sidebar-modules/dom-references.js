// ext/sidebar-modules/dom-references.js
// Caches and exports references to all DOM elements used by the sidebar UI.

import { logger } from '../utils.js';

// This object will be populated by cacheDomReferences and imported by other modules.
export const domRefs = {};

/**
 * Finds all necessary DOM elements and populates the domRefs object.
 * This should be called once when the sidebar is initialized.
 */
export function cacheDomReferences() {
    Object.assign(domRefs, {
        // Header
        backBtn: document.getElementById('back-btn'),
        settingsBtn: document.getElementById('settings-btn'),
        sidebarTitle: document.getElementById('sidebar-title'),
        
        // Views
        mainContentArea: document.querySelector('.main-content-area'),
        rootView: document.getElementById('root-view'),
        createView: document.getElementById('create-view'),
        packetDetailView: document.getElementById('packet-detail-view'),
        settingsView: document.getElementById('settings-view'),
        
        // Root View Elements
        tabInbox: document.getElementById('tab-inbox'),
        tabInProgress: document.getElementById('tab-in-progress'),
        tabCompleted: document.getElementById('tab-completed'),
        contentInbox: document.getElementById('content-inbox'),
        tabContentInProgress: document.getElementById('content-in-progress'),
        tabContentCompleted: document.getElementById('content-completed'),
        inboxList: document.getElementById('inbox-list'),
        inProgressList: document.getElementById('in-progress-list'),
        completedList: document.getElementById('completed-list'),
        createPacketSidebarBtn: document.getElementById('create-packet-sidebar-btn'),
        sidebarDeleteBtn: document.getElementById('sidebar-delete-btn'),
        sidebarStatusMessage: document.getElementById('sidebar-status-message'),
        showImportDialogBtn: document.getElementById('show-import-dialog-btn'),
        genericConfirmDialog: document.getElementById('generic-confirm-dialog'),
        genericConfirmMessage: document.getElementById('generic-confirm-message'),
        genericConfirmConfirmBtn: document.getElementById('generic-confirm-confirm-btn'),
        genericConfirmCancelBtn: document.getElementById('generic-confirm-cancel-btn'),

        // Create View Elements
        createViewContentList: document.getElementById('create-view-content-list'),
        createViewDiscardBtn: document.getElementById('create-view-discard-btn'),
        createViewSaveBtn: document.getElementById('create-view-save-btn'),
        dropZone: document.getElementById('drop-zone'),
        addCurrentTabBtn: document.getElementById('add-current-tab-btn'),
        createNewPageBtn: document.getElementById('create-new-page-btn'),
        
        // Generate New Page Dialog Refs
        makePageDialog: document.getElementById('make-page-dialog'),
        makePagePromptInput: document.getElementById('make-page-prompt-input'),
        makePageInteractiveCheckbox: document.getElementById('make-page-interactive-checkbox'),
        makePageProgressContainer: document.querySelector('#make-page-dialog .dialog-progress-container'), // <-- ADDED
        confirmMakePageBtn: document.getElementById('confirm-make-page-btn'),
        cancelMakePageBtn: document.getElementById('cancel-make-page-btn'),

        // Settings View LLM Refs
        llmModelsList: document.getElementById('llm-models-list'),
        llmAddNewModelBtn: document.getElementById('llm-add-new-model-btn'),
        llmModelEditFormSection: document.getElementById('llm-model-edit-form-section'),
        llmEditFormTitle: document.getElementById('llm-edit-form-title'),
        llmEditModelIdInput: document.getElementById('llm-edit-model-id'), 
        llmEditFriendlyNameInput: document.getElementById('llm-edit-friendly-name'),
        llmEditProviderTypeSelect: document.getElementById('llm-edit-provider-type'),
        llmEditApiKeyGroup: document.getElementById('llm-edit-api-key-group'),
        llmEditApiKeyInput: document.getElementById('llm-edit-api-key'),
        toggleLlmEditApiKeyVisibilityBtn: document.getElementById('toggle-llm-edit-api-key-visibility'),
        llmEditModelNameInput: document.getElementById('llm-edit-model-name'),
        llmEditApiEndpointGroup: document.getElementById('llm-edit-api-endpoint-group'),
        llmEditApiEndpointInput: document.getElementById('llm-edit-api-endpoint'),
        llmEditApiEndpointDesc: document.getElementById('llm-edit-api-endpoint-desc'),
        llmEditFormSaveBtn: document.getElementById('llm-edit-form-save-btn'),
        llmEditFormCancelBtn: document.getElementById('llm-edit-form-cancel-btn'),
        
        // Settings View S3 Refs
        s3ConfigsList: document.getElementById('s3-configs-list'),
        s3AddNewConfigBtn: document.getElementById('s3-add-new-config-btn'),
        s3ConfigEditFormSection: document.getElementById('s3-config-edit-form-section'),
        s3EditFormTitle: document.getElementById('s3-edit-form-title'),
        s3EditConfigIdInput: document.getElementById('s3-edit-config-id'),
        s3EditFriendlyNameInput: document.getElementById('s3-edit-friendly-name'),
        s3EditProviderTypeSelect: document.getElementById('s3-edit-provider-type'),
        s3EditAccessKeyInput: document.getElementById('s3-edit-access-key'),
        toggleS3AccessKeyVisibilityBtn: document.getElementById('toggle-s3-access-key-visibility'),
        s3EditSecretKeyInput: document.getElementById('s3-edit-secret-key'),
        toggleS3SecretKeyVisibilityBtn: document.getElementById('toggle-s3-secret-key-visibility'),
        s3EditBucketNameInput: document.getElementById('s3-edit-bucket-name'),
        s3EditRegionInput: document.getElementById('s3-edit-region'),
        s3EditFormSaveBtn: document.getElementById('s3-edit-form-save-btn'),
        s3EditFormCancelBtn: document.getElementById('s3-edit-form-cancel-btn'),

        // Other Settings Refs
        tabGroupsEnabledCheckbox: document.getElementById('tab-groups-enabled'),
        confettiEnabledCheckbox: document.getElementById('confetti-enabled'),
        mediaOverlayEnabledCheckbox: document.getElementById('media-overlay-enabled'),
        preferAudioEnabledCheckbox: document.getElementById('prefer-audio-enabled'),
        waveformLinkMarkersEnabledCheckbox: document.getElementById('waveform-link-markers-enabled'),
        visitThresholdSecondsInput: document.getElementById('visit-threshold-seconds'),
        quickCopyEnabledCheckbox: document.getElementById('quick-copy-enabled'),
        themeAutoRadio: document.getElementById('theme-auto'),
        themeLightRadio: document.getElementById('theme-light'),
        themeDarkRadio: document.getElementById('theme-dark'),
        themeRadios: document.querySelectorAll('#settings-view input[name="theme"]'),
        settingsStatusMessage: document.getElementById('settings-status-message'),
        llmHelpLink: document.getElementById('llm-help-link'),
        s3HelpLink: document.getElementById('s3-help-link'),

        // Detail View Dynamic Refs
        detailProgressContainer: null, 
        detailActionButtonContainer: null,
        detailCloseGroupBtn: null,
        detailCardsContainer: null,
        
        // Share Dialog Refs
        shareDialog: document.getElementById('share-dialog'),
        shareDialogMessage: document.getElementById('share-dialog-message'),
        shareDialogUrlInput: document.getElementById('share-dialog-url'),
        copyShareLinkBtn: document.getElementById('copy-share-link-btn'),
        closeShareDialogBtn: document.getElementById('close-share-dialog-btn'),
        
        // Import Dialog Refs
        importDialog: document.getElementById('import-dialog'),
        importDialogUrlInput: document.getElementById('import-dialog-url-input'),
        importDialogStatusMessage: document.getElementById('import-dialog-status-message'),
        confirmImportDialogBtn: document.getElementById('confirm-import-dialog-btn'),
        cancelImportDialogBtn: document.getElementById('cancel-import-dialog-btn'),
        
        // Close Group Dialog Refs
        closeGroupDialog: document.getElementById('close-group-dialog'),
        closeGroupDialogBox: document.querySelector('.close-group-dialog'), 
        closeGroupDialogMessage: document.getElementById('close-group-dialog-message'),
        confirmCloseGroupBtn: document.getElementById('confirm-close-group-btn'),
        cancelCloseGroupBtn: document.getElementById('cancel-close-group-btn'),

        // Input Prompt Dialog Refs
        inputPromptDialog: document.getElementById('input-prompt-dialog'),
        inputPromptMessage: document.getElementById('input-prompt-message'),
        inputPromptInput: document.getElementById('input-prompt-input'),
        confirmInputPromptBtn: document.getElementById('confirm-input-prompt-btn'),
        cancelInputPromptBtn: document.getElementById('cancel-input-prompt-btn'),
    });
    logger.log('Sidebar:cacheDomReferences', 'DOM references cached.');
}