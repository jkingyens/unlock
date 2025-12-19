// ext/selector.js
(function () {
    // 1. Cleanup previous listener to prevent duplicates/orphans
    if (window.unlockSelectorMsgListener) {
        chrome.runtime.onMessage.removeListener(window.unlockSelectorMsgListener);
    }

    // 2. State
    let activeTool = null;
    let activeIntent = null;
    let overlay = null;
    let canvas = null;
    let ctx = null;
    let isSelecting = false;
    let startX, startY;
    let currentX, currentY;

    // 3. CSS (Idempotent)
    const styles = `
        #unlock-selector-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background-color: rgba(0, 0, 0, 0.3) !important;
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
            z-index: 2147483647;
            cursor: crosshair;
            pointer-events: auto;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: flex-start;
            padding-top: 20px;
        }
        .unlock-selector-box {
            background-color: rgba(30, 30, 30, 0.65);
            color: #ffffff;
            padding: 8px 16px;
            border-radius: 50px;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            font-size: 14px;
            font-weight: 500;
            pointer-events: none;
            user-select: none;
            white-space: nowrap;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        #unlock-region-canvas {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            z-index: 2147483646;
            pointer-events: none;
        }
        .unlock-tool-active {
            user-select: none !important;
        }
        /* Prevent media overlay or other overlays from interfering and causing blur/distraction */
        .unlock-tool-active #unlock-media-overlay,
        .unlock-tool-active .unlock-selector-box {
             backdrop-filter: none !important;
             -webkit-backdrop-filter: none !important;
        }
        .unlock-tool-active #unlock-media-overlay {
            display: none !important;
        }
    `;

    if (!document.getElementById('unlock-selector-styles')) {
        const styleSheet = document.createElement("style");
        styleSheet.id = 'unlock-selector-styles';
        styleSheet.innerText = styles;
        document.head.appendChild(styleSheet);
    }

    // 4. Logic Functions
    function removeOverlay() {
        const existingOverlay = document.getElementById('unlock-selector-overlay');
        if (existingOverlay) existingOverlay.remove();
        overlay = null;

        const existingCanvas = document.getElementById('unlock-region-canvas');
        if (existingCanvas) existingCanvas.remove();
        canvas = null;
        ctx = null;

        document.body.classList.remove('unlock-tool-active', 'unlock-text-tool-active', 'unlock-image-tool-active', 'unlock-region-tool-active');
    }

    function createOverlay() {
        removeOverlay(); // Ensure clean state

        overlay = document.createElement('div');
        overlay.id = 'unlock-selector-overlay';

        let instructions = '';
        if (activeTool === 'image') instructions = 'drag an image';
        else if (activeTool === 'text') instructions = 'select text';
        else if (activeTool === 'region') instructions = 'click and drag to select a region';

        overlay.innerHTML = `
            <div class="unlock-selector-box">
                <span class="unlock-selector-indicator"></span>
                <p>Unlock tool is active. <strong>${instructions.toUpperCase()}</strong> to capture.</p>
            </div>
        `;
        document.body.appendChild(overlay);

        if (activeTool === 'region') {
            canvas = document.createElement('canvas');
            canvas.id = 'unlock-region-canvas';
            canvas.width = window.innerWidth * window.devicePixelRatio;
            canvas.height = window.innerHeight * window.devicePixelRatio;
            canvas.style.width = '100vw';
            canvas.style.height = '100vh';
            ctx = canvas.getContext('2d');
            ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
            document.body.appendChild(canvas);

            overlay.addEventListener('mousedown', handleMouseDown);
            overlay.addEventListener('mousemove', handleMouseMove);
            overlay.addEventListener('mouseup', handleMouseUp);
        }

        document.body.classList.add('unlock-tool-active');
    }

    function handleMouseDown(e) {
        if (activeTool !== 'region') return;
        isSelecting = true;
        startX = e.clientX;
        startY = e.clientY;
        const p = overlay.querySelector('p');
        if (p) p.innerHTML = 'Release to capture region.';
    }

    function handleMouseMove(e) {
        if (!isSelecting) return;
        currentX = e.clientX;
        currentY = e.clientY;
        drawSelection();
    }

    function handleMouseUp(e) {
        if (!isSelecting) return;
        isSelecting = false;

        // Final draw to ensure capture aligns
        currentX = e.clientX;
        currentY = e.clientY;

        const rect = {
            x: Math.min(startX, e.clientX),
            y: Math.min(startY, e.clientY),
            width: Math.abs(e.clientX - startX),
            height: Math.abs(e.clientY - startY)
        };

        if (rect.width > 5 && rect.height > 5) {
            chrome.runtime.sendMessage({
                action: 'region_captured_from_content',
                data: {
                    rect: rect,
                    devicePixelRatio: window.devicePixelRatio,
                    intent: activeIntent
                }
            });
            cleanup();
        } else {
            drawSelection();
            const p = overlay.querySelector('p');
            if (p) p.innerHTML = 'Selection too small. Try again.';
        }
    }

    function drawSelection() {
        if (!ctx) return;
        ctx.clearRect(0, 0, innerWidth, innerHeight);

        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fillRect(0, 0, innerWidth, innerHeight);

        if (isSelecting) {
            const x = Math.min(startX, currentX);
            const y = Math.min(startY, currentY);
            const w = Math.abs(currentX - startX);
            const h = Math.abs(currentY - startY);

            ctx.clearRect(x, y, w, h);
            ctx.strokeStyle = '#64b5f6';
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, w, h);
        }
    }

    function cleanup() {
        console.log('[Selector] Cleanup called. Active tool:', activeTool);
        document.body.classList.remove('unlock-text-tool-active', 'unlock-image-tool-active', 'unlock-region-tool-active');
        document.removeEventListener('mouseup', handleTextSelection);
        document.removeEventListener('dragstart', handleImageDrag, true);
        activeTool = null;
        activeIntent = null;
        isSelecting = false;
        removeOverlay();
    }

    function activateTool(toolType, intent) {
        console.log('[Selector] Activate tool:', toolType, 'Intent:', intent);
        cleanup(); // Clean up previous state/tools
        activeTool = toolType;
        activeIntent = intent;
        document.body.classList.add(`unlock-${toolType}-tool-active`);
        createOverlay();

        if (toolType === 'text') {
            document.addEventListener('mouseup', handleTextSelection);
        } else if (toolType === 'image') {
            document.addEventListener('dragstart', handleImageDrag, true);
        }
    }

    function handleTextSelection(e) {
        if (activeTool !== 'text') return;
        const selectedText = window.getSelection().toString().trim();
        if (selectedText) {
            chrome.runtime.sendMessage({
                action: 'content_script_data_captured',
                data: { type: 'text/plain', payload: selectedText }
            });
            cleanup();
        }
    }

    function handleImageDrag(e) {
        if (activeTool !== 'image' || e.target.tagName !== 'IMG') return;
        chrome.runtime.sendMessage({
            action: 'content_script_data_captured',
            data: { type: 'image/png', payload: e.target.src }
        });
        cleanup();
    }

    // 5. Listener Attachment
    const msgListener = (message, sender, sendResponse) => {
        console.log('[Selector] Message received:', message.action);
        if (message.action === 'activate_selector_tool') {
            activateTool(message.data.toolType, message.data.intent);
        } else if (message.action === 'deactivate_selector_tool') {
            cleanup();
        }
    };

    window.unlockSelectorMsgListener = msgListener;
    chrome.runtime.onMessage.addListener(msgListener);

    // Log success
    console.log('[Selector] Initialized and listening.');

})();