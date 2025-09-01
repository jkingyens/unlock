// popup_ui.js - Handles UI updates and DOM manipulation for the popup

import { logger, storage, packetUtils, isSidePanelAvailable } from './utils.js';
// Import necessary action handlers for context menu items etc.
import { handleOpenContentUrl, handleOpenNextExternalContent, handleDeleteSelected, handleRepublishPage, handleGeneratePageForPacket } from './popup_actions.js';

// --- Store DOM element references ---
let domElements = {};
let activeTab = 'in-progress'; // Track active tab state
let currentContextMenuCloseHandler = null; // Track context menu handler

/**
 * Gets references to all necessary DOM elements.
 * @returns {object} - An object containing references to DOM elements.
 */
function initializeUI() {
    domElements = {
        titleInput: document.getElementById('title-input'),
        createBtn: document.getElementById('create-btn'),
        inProgressList: document.getElementById('in-progress-list'),
        completedList: document.getElementById('completed-list'),
        statusMessage: document.getElementById('status-message'),
        loadingSpinner: document.getElementById('loading-spinner'),
        deleteBtn: document.getElementById('delete-btn'),
        tabInProgress: document.getElementById('tab-in-progress'),
        tabCompleted: document.getElementById('tab-completed'),
        contentInProgress: document.getElementById('content-in-progress'),
        contentCompleted: document.getElementById('content-completed'),
        openSidebarBtn: document.getElementById('open-sidebar-btn'),
        settingsBtn: document.getElementById('settings-btn'),
        restartBtn: document.getElementById('restart-btn'),
        refreshBtn: document.getElementById('refresh-btn')
    };
    // Load initial packet list on UI initialization
    loadPackets();
    return domElements;
}

/**
 * Load all packets from storage and display them.
 */
async function loadPackets() {
    if (!domElements.loadingSpinner || !domElements.statusMessage) {
        logger.warn('PopupUI', 'DOM elements not ready for loadPackets');
        return;
    }
    logger.log('PopupUI', 'Loading packets');
    showLoading(true); // Show loading indicator while loading
    try {
      const packets = await storage.getPackets();
      logger.log('PopupUI', 'Loaded packets', { count: packets.length });
      displayPackets(packets);
    } catch (error) {
      logger.error('PopupUI', 'Error loading packets', error);
      if (domElements.statusMessage) domElements.statusMessage.textContent = 'Error loading packets';
    } finally {
        showLoading(false); // Hide loading indicator
    }
}

/**
 * Display packets in the UI lists.
 * @param {Array<Object>} packets - Array of packet objects.
 */
function displayPackets(packets) {
    if (!domElements.inProgressList || !domElements.completedList) return;

    domElements.inProgressList.innerHTML = '';
    domElements.completedList.innerHTML = '';

    const inProgressPackets = packets.filter(packet => !packetUtils.isPacketCompleted(packet));
    const completedPackets = packets.filter(packet => packetUtils.isPacketCompleted(packet));

    // Display in-progress packets
    if (inProgressPackets.length === 0) {
      domElements.inProgressList.innerHTML = `<tr><td colspan="3" class="empty-state">No packets Started. Create one!</td></tr>`;
    } else {
      inProgressPackets.sort((a, b) => parseInt(b.id) - parseInt(a.id)); // Sort newest first
      inProgressPackets.forEach(packet => createPacketRow(packet, domElements.inProgressList));
    }

    // Display completed packets
    if (completedPackets.length === 0) {
      domElements.completedList.innerHTML = `<tr><td colspan="3" class="empty-state">No completed packets yet.</td></tr>`;
    } else {
       completedPackets.sort((a, b) => parseInt(b.id) - parseInt(a.id)); // Sort newest first
      completedPackets.forEach(packet => createPacketRow(packet, domElements.completedList));
    }

    updateActionButtonsVisibility(); // Ensure button visibility is correct after display
}


/**
 * Create a table row element for a single packet.
 * @param {Object} packet - The packet object.
 * @param {HTMLElement} listElement - The tbody element to append the row to.
 */
function createPacketRow(packet, listElement) {
    const row = document.createElement('tr');
    row.dataset.packetId = packet.id; // Add packet ID for easier updates

    // Calculate progress based on ALL items with URLs (external + published generated)
    const trackableItems = packet.contents.filter(item =>
        item.type === 'external' || (item.type === 'generated' && item.published && item.url)
    );
    const visitedTrackableCount = packet.visitedUrls?.filter(url => // Use optional chaining for visitedUrls
        trackableItems.some(item => item.url === url)
    ).length || 0; // Default to 0 if visitedUrls is null/undefined
    const totalTrackableCount = trackableItems.length;
    const progressPercentage = totalTrackableCount > 0 ? Math.round((visitedTrackableCount / totalTrackableCount) * 100) : 0;
    const isCompleted = packetUtils.isPacketCompleted(packet);

    // Checkbox Cell
    const checkboxCell = document.createElement('td');
    checkboxCell.className = 'checkbox-cell';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'packet-checkbox';
    checkbox.dataset.packetId = packet.id;
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation(); // Prevent row click
      updateActionButtonsVisibility();
    });
    checkboxCell.appendChild(checkbox);

    // Name Cell
    const nameCell = document.createElement('td');
    const nameContainer = document.createElement('div');
    nameContainer.className = 'packet-title';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = packet.title;
    nameContainer.appendChild(titleSpan);
    nameCell.appendChild(nameContainer);

    // Progress Cell
    const progressCell = document.createElement('td');
    const progressTextHTML = `<div class="progress-text">${visitedTrackableCount}/${totalTrackableCount}</div>`;
    const progressBarHTML = `
      <div class="progress-bar-container" title="${progressPercentage}% Complete">
        <div class="progress-bar" style="width: ${progressPercentage}%"></div>
      </div>
    `;
    progressCell.innerHTML = progressTextHTML + progressBarHTML;

    // Add cells to row
    row.appendChild(checkboxCell);
    row.appendChild(nameCell);
    row.appendChild(progressCell);

    setupPacketContextMenu(row, packet); // Attach context menu

    // Click handler update
    if (!isCompleted) {
      row.addEventListener('click', (e) => {
        // Only respond if the click was not on the checkbox itself
        if (e.target !== checkbox) {
          const defaultPageUrl = packetUtils.getDefaultGeneratedPageUrl(packet);
          if (defaultPageUrl) {
            handleOpenContentUrl(packet.id, defaultPageUrl); // Call action handler
          } else {
            handleOpenNextExternalContent(packet.id); // Call action handler
          }
        }
      });
      // Update tooltip based on what will open
      const defaultPageUrl = packetUtils.getDefaultGeneratedPageUrl(packet);
      row.title = defaultPageUrl ? "Click to open this packet's summary page" : "Click to open next article.";
    } else {
      // Keep completed packets slightly dimmed
      row.style.opacity = '0.8';
      row.title = "Packet completed!";
    }

    listElement.appendChild(row);
}

/**
 * Updates a single packet row in the UI without reloading the whole list.
 * @param {Object} packet - The updated packet object.
 */
function updatePacketRowUI(packet) {
    const listElement = packetUtils.isPacketCompleted(packet) ? domElements.completedList : domElements.inProgressList;
    const row = listElement?.querySelector(`tr[data-packet-id="${packet.id}"]`);

    if (row) {
        // Re-render the row content based on the updated packet
        const tempContainer = document.createElement('tbody'); // Use tbody to contain the new row
        createPacketRow(packet, tempContainer);
        if (tempContainer.firstChild) {
            row.innerHTML = tempContainer.firstChild.innerHTML; // Replace content
            // Re-attach context menu listener to the updated row content
            setupPacketContextMenu(row, packet);
             // Re-attach click listener if needed (or ensure createPacketRow does it)
             // This might require finding the checkbox within the new innerHTML and re-adding the listener
             // For simplicity, the createPacketRow function already adds necessary listeners to its generated content.
        }
    } else {
         logger.warn('PopupUI', 'Could not find row to update in UI', { packetId: packet.id });
         // Fallback: Reload all packets if row isn't found
         loadPackets();
    }
}


/**
 * Switch between 'Started' and 'Completed' tabs.
 * @param {'in-progress' | 'completed'} tabName - The name of the tab to activate.
 */
function switchTab(tabName) {
    activeTab = tabName;

    if (!domElements.tabInProgress || !domElements.tabCompleted || !domElements.contentInProgress || !domElements.contentCompleted || !domElements.statusMessage) return;

    const isProgress = tabName === 'in-progress';

    domElements.tabInProgress.classList.toggle('active', isProgress);
    domElements.tabCompleted.classList.toggle('active', !isProgress);
    domElements.contentInProgress.classList.toggle('active', isProgress);
    domElements.contentCompleted.classList.toggle('active', !isProgress);

    updateActionButtonsVisibility(); // Update button visibility based on the new tab
    domElements.statusMessage.textContent = ''; // Clear status message on tab switch
}

/**
 * Update visibility of Delete and Restart buttons based on selection and active tab.
 */
function updateActionButtonsVisibility() {
    if (!domElements.deleteBtn || !domElements.restartBtn || !domElements.inProgressList || !domElements.completedList) return;

    const currentList = activeTab === 'in-progress' ? domElements.inProgressList : domElements.completedList;
    const selectedCheckboxes = currentList.querySelectorAll('.packet-checkbox:checked');
    const anySelected = selectedCheckboxes.length > 0;

    // Delete button is visible if any item is selected in the *current* tab
    domElements.deleteBtn.style.display = anySelected ? 'inline-block' : 'none';

    // Restart button is visible ONLY if on 'completed' tab AND items are selected
    domElements.restartBtn.style.display = (activeTab === 'completed' && anySelected) ? 'inline-block' : 'none';
}


/**
 * Show or hide the main loading spinner and disable/enable create button.
 * @param {boolean} show - True to show loading, false to hide.
 */
function showLoading(show) {
    if (!domElements.loadingSpinner || !domElements.createBtn) return;
    domElements.loadingSpinner.classList.toggle('hidden', !show);
    domElements.createBtn.disabled = show; // Disable create button when loading
}

/**
 * Show a temporary toast message.
 * @param {string} message - The message to display.
 * @param {'info' | 'success' | 'error'} type - Type of toast.
 * @param {number} duration - How long to show the toast in ms.
 */
function showToast(message, type = 'info', duration = 3000) {
    // Remove any existing toasts first
    document.querySelectorAll('.toast').forEach(toast => toast.remove());

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
       toast.style.animation = 'fadeOut 0.5s forwards';
       toast.addEventListener('animationend', () => {
            if (toast.parentNode) toast.parentNode.removeChild(toast);
       }, { once: true });
    }, duration);
}


/**
 * Setup context menu for a packet row.
 * @param {HTMLElement} row - The table row element.
 * @param {Object} packet - The corresponding packet object.
 */
function setupPacketContextMenu(row, packet) {
    row.addEventListener('contextmenu', async (e) => { // Make async for storage check
        e.preventDefault();
        removeContextMenus(); // Close any existing menus

        const contextMenu = document.createElement('div');
        contextMenu.className = 'context-menu';
        // Adjust position slightly to avoid cursor overlap
        contextMenu.style.top = `${e.clientY + 2}px`;
        contextMenu.style.left = `${e.clientX + 2}px`;

        const generatedPages = packetUtils.getGeneratedPages(packet);
        const publishedPages = generatedPages.filter(p => p.published && p.url);
        const pagesWithLocalFiles = generatedPages.filter(p => p.files && p.files.length > 0);

        // --- Generated Page Options ---
        if (publishedPages.length > 0) {
            addMenuItem(contextMenu, 'View Summary Page', () => {
                handleOpenContentUrl(packet.id, publishedPages[0].url); // Use action handler
            });
        }

        // Option to Republish/Publish if local files exist
        if (pagesWithLocalFiles.length > 0) {
             const pageToPublish = pagesWithLocalFiles[0];
             const actionText = pageToPublish.published ? 'Republish Summary Page' : 'Publish Summary Page';
             addMenuItem(contextMenu, actionText, () => {
                 handleRepublishPage(packet.id, pageToPublish.pageId); // Use action handler
             });
        }

        // Option to generate a page if cloud storage is enabled and none exist yet
        const storageEnabled = await storage.isCloudStorageEnabled();
        if (generatedPages.length === 0 && storageEnabled) {
            addMenuItem(contextMenu, 'Generate Summary Page', () => {
                handleGeneratePageForPacket(packet.id); // Use action handler
            });
        }

        // --- External Content Options ---
        const hasExternalContent = packet.contents.some(c => c.type === 'external');
        if (hasExternalContent) {
            addMenuItem(contextMenu, 'Open next article', () => {
                handleOpenNextExternalContent(packet.id); // Use action handler
            });
            // 'Show content details' might be better suited for the sidebar now,
            // but could be added back here if needed, potentially calling an action handler.
            // addMenuItem(contextMenu, 'Show content details', () => { /* Call action handler */ });
        }

        // --- Tab Ordering Option ---
        // Only add if the packet has a tab group
        if (packet.tabGroupId) {
            addMenuItem(contextMenu, 'Reorder tabs', () => {
                handleReorderPacketTabs(packet.id);
            });
        }

        // --- Common Options ---
         if (contextMenu.children.length > 0) { // Only add divider if other items exist
              const divider = document.createElement('div');
              divider.className = 'context-menu-divider';
              contextMenu.appendChild(divider);
         }

        addMenuItem(contextMenu, 'Delete packet', () => {
             const checkbox = row.querySelector('.packet-checkbox');
             if (checkbox) checkbox.checked = true;
             updateActionButtonsVisibility();
             handleDeleteSelected(); // Use the multi-delete action handler
        }, 'delete-action');

        document.body.appendChild(contextMenu);

        // Define the handler
        const closeMenuHandler = (event) => {
          if (!contextMenu.contains(event.target)) {
              removeContextMenus();
          }
        };
        currentContextMenuCloseHandler = closeMenuHandler; // Store ref

        setTimeout(() => { // Add listener after current event cycle
             document.addEventListener('click', currentContextMenuCloseHandler);
             document.addEventListener('contextmenu', currentContextMenuCloseHandler);
        }, 0);

        contextMenu.addEventListener('click', (e) => e.stopPropagation()); // Prevent menu click closing itself
    });
}

/**
 * Adds an item to the context menu.
 * @param {HTMLElement} menu - The context menu div.
 * @param {string} text - Text for the menu item.
 * @param {Function} action - Callback function when item is clicked.
 * @param {string} [className=''] - Optional CSS class for the item.
 */
function addMenuItem(menu, text, action, className = '') {
    const item = document.createElement('div');
    item.className = `context-menu-item ${className}`;
    item.textContent = text;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      action();
      removeContextMenus(); // Close menu after action
    });
    menu.appendChild(item);
}

/**
 * Removes all context menus from the DOM and their listeners.
 */
function removeContextMenus() {
    document.querySelectorAll('.context-menu').forEach(menu => {
      if (menu.parentNode) menu.parentNode.removeChild(menu);
    });

    if (currentContextMenuCloseHandler) {
      document.removeEventListener('click', currentContextMenuCloseHandler);
      document.removeEventListener('contextmenu', currentContextMenuCloseHandler);
      currentContextMenuCloseHandler = null;
    }
}

/**
 * Checks the status of the current browser tab to enable/disable the sidebar button.
 * @param {HTMLElement} openSidebarBtn - Reference to the sidebar button element.
 */
async function checkCurrentTabStatus(openSidebarBtn = domElements.openSidebarBtn) {
     if (!openSidebarBtn) return; // Exit if button element not found

    try {
        const tabs = await getCurrentTabs(); // Use helper function

        if (!tabs || tabs.length === 0) {
            openSidebarBtn.disabled = true;
            openSidebarBtn.title = "No active tab";
            return;
        }

        const currentTab = tabs[0];
        const currentUrl = currentTab.url;

        // Disable on special pages
        if (!currentUrl || currentUrl.startsWith('chrome://') || currentUrl.startsWith('chrome-extension://')) {
            openSidebarBtn.disabled = true;
            openSidebarBtn.title = "Sidebar not available on this page";
            return;
        }

        // Check if URL is part of any packet
        const packets = await storage.getPackets();
        const packetWithUrl = packets.find(packet =>
            packet.contents.some(content => content.url === currentUrl)
        );

        if (packetWithUrl) {
            openSidebarBtn.disabled = false;
            openSidebarBtn.title = "Open explorer sidebar for this packet";
            openSidebarBtn.dataset.packetId = packetWithUrl.id; // Store ID for quick access
            openSidebarBtn.dataset.tabId = currentTab.id;
        } else {
            openSidebarBtn.disabled = false; // Keep enabled even if not in packet
            openSidebarBtn.title = "Open explorer sidebar";
            delete openSidebarBtn.dataset.packetId; // Clear stored data
            delete openSidebarBtn.dataset.tabId;
        }
    } catch (error) {
      logger.error('PopupUI', 'Error checking current tab status', error);
      openSidebarBtn.disabled = true;
      openSidebarBtn.title = "Error checking tab status";
    }
}

/**
 * Helper function to get the current active tab in the current window.
 * @returns {Promise<Array<chrome.tabs.Tab>>}
 */
function getCurrentTabs() {
    return new Promise((resolve, reject) => {
        if (typeof chrome !== 'undefined' && chrome.tabs && chrome.windows) {
            chrome.windows.getCurrent({ populate: false }, (currentWindow) => {
                if (chrome.runtime.lastError) {
                    return reject(chrome.runtime.lastError);
                }
                chrome.tabs.query({ active: true, windowId: currentWindow.id }, function(tabs) {
                    if (chrome.runtime.lastError) {
                        reject(chrome.runtime.lastError);
                    } else {
                        resolve(tabs);
                    }
                });
            });
        } else {
           reject(new Error('Chrome tabs/windows API not available'));
        }
    });
}


// Export functions needed by other modules
export {
    initializeUI,
    loadPackets,
    displayPackets,
    updatePacketRowUI,
    switchTab,
    updateActionButtonsVisibility,
    showLoading,
    showToast,
    checkCurrentTabStatus,
    getCurrentTabs,
    // Potentially export setupPacketContextMenu, addMenuItem, removeContextMenus if needed externally
};