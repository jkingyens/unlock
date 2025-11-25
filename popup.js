// ext/popup.js
import { handleCreatePacket, handleOpenSidebar } from './popup_actions.js';
import { applyThemeMode } from './utils.js'; // Import the theme helper

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Apply the correct theme immediately
    await applyThemeMode();

    // 2. Wire up buttons
    const createBtn = document.getElementById('create-btn');
    const sidebarBtn = document.getElementById('open-sidebar-btn-popup');
    const settingsBtn = document.getElementById('settings-btn');

    if (createBtn) {
        createBtn.addEventListener('click', handleCreatePacket);
    }

    if (sidebarBtn) {
        sidebarBtn.addEventListener('click', handleOpenSidebar);
    }

    if (settingsBtn) {
        settingsBtn.addEventListener('click', handleOpenSidebar);
    }
});