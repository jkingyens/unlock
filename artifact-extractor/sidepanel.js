
document.addEventListener('DOMContentLoaded', () => {
    const extractBtn = document.getElementById('extractBtn');
    const promptInput = document.getElementById('prompt');
    const statusDiv = document.getElementById('status');
    const resultsDiv = document.getElementById('results');

    let globalSession = null;

    extractBtn.addEventListener('click', async () => {
        const prompt = promptInput.value.trim();
        if (!prompt) {
            statusDiv.textContent = 'Please enter a prompt.';
            return;
        }

        try {
            statusDiv.textContent = 'Getting page content...';
            resultsDiv.innerHTML = '';
            extractBtn.disabled = true;

            // 1. Get Active Tab Content
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab) throw new Error('No active tab found.');

            const [{ result: pageContent }] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => document.body.innerText // Simpler for token limits than HTML
            });

            // Truncate to avoid context window explosion (approx 4k chars for now)
            const truncatedContent = pageContent.substring(0, 10000);

            // 2. Prepare Prompt
            const systemPrompt = `You are a helper that extracts URLs from text based on a user description.
            User Request: ${prompt}
            
            Content:
            ${truncatedContent}
            
            Return a JSON object with a key "artifacts" containing a list of objects with "text" and "url" properties. 
            Example: { "artifacts": [{ "text": "Product A", "url": "https://example.com/a" }] }
            Return ONLY JSON.`;

            // 3. Call Gemini Nano
            statusDiv.textContent = 'Analyzing with Gemini Nano...';

            if (!globalSession) {
                // 1. Feature Detect & Create Session
                if (window.ai && window.ai.languageModel) {
                    // Formatting for Chrome 128+
                    const capabilities = await window.ai.languageModel.capabilities();
                    if (capabilities.available === 'no') {
                        throw new Error('Gemini Nano available status is "no".');
                    }
                    globalSession = await window.ai.languageModel.create({
                        systemPrompt: "You are a helpful URL extractor that outputs valid JSON.",
                        expectedOutputLanguages: ['en']
                    });
                } else if (window.LanguageModel) {
                    // Legacy/Polyfill
                    const status = await window.LanguageModel.availability();
                    if (status === 'no') {
                        throw new Error('LanguageModel.availability() is "no".');
                    }
                    globalSession = await window.LanguageModel.create({
                        systemPrompt: "You are a helpful URL extractor that outputs valid JSON.",
                        expectedOutputLanguages: ['en']
                    });
                } else {
                    throw new Error('Gemini Nano is not available in this browser context.');
                }
            }

            const result = await globalSession.prompt(systemPrompt);
            console.log("LLM Raw Result:", result);
            // session.destroy(); // Keep alive for reuse

            // 4. Parse and Render
            const jsonStart = result.indexOf('{');
            const jsonEnd = result.lastIndexOf('}');
            if (jsonStart === -1 || jsonEnd === -1) throw new Error('Invalid JSON response from model.');

            const jsonStr = result.substring(jsonStart, jsonEnd + 1);
            const data = JSON.parse(jsonStr);

            statusDiv.textContent = `Found ${data.artifacts?.length || 0} artifacts.`;

            if (data.artifacts && Array.isArray(data.artifacts)) {
                data.artifacts.forEach(item => {
                    const link = document.createElement('a');
                    link.className = 'artifact-link';
                    link.href = item.url;
                    link.target = '_blank'; // Opens in new tab
                    link.innerHTML = `<span class="link-text">${item.text}</span><span class="link-url">${item.url}</span>`;
                    resultsDiv.appendChild(link);
                });
            } else {
                statusDiv.textContent = 'No artifacts found in response.';
            }

        } catch (error) {
            console.error(error);
            statusDiv.textContent = `Error: ${error.message}`;
            if (globalSession) {
                globalSession.destroy();
                globalSession = null;
            }
        } finally {
            extractBtn.disabled = false;
        }
    });
});
