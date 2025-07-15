// ext/llm_service.js

import { logger, storage, CONFIG, MPI_PARAMS } from './utils.js'; // CONFIG for TEMPERATURE, MPI_PARAMS for event URL

// --- Helper functions ---
function _cleanHtmlOutput(contentStr) {
    const originalLength = contentStr?.length || 0;
    if (originalLength < 50 && CONFIG.DEBUG) {
        logger.warn('LLMService:_cleanHtmlOutput', 'Received very short content string for HTML cleaning.', { originalContent: contentStr });
    }

    let cleanHtml = String(contentStr || "").trim();
    // If LLM still tries to return full HTML for body content requests, try to extract body
    const bodyMatch = cleanHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch && bodyMatch[1]) {
        cleanHtml = bodyMatch[1].trim();
    } else if (cleanHtml.startsWith('```html')) {
        cleanHtml = cleanHtml.substring(7);
        if (cleanHtml.endsWith('```')) {
            cleanHtml = cleanHtml.substring(0, cleanHtml.length - 3);
        }
        // Check again for body tag after removing markdown
        const nestedBodyMatch = cleanHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        if (nestedBodyMatch && nestedBodyMatch[1]) {
            cleanHtml = nestedBodyMatch[1].trim();
        }
    } else if (cleanHtml.startsWith('```')) { // Generic markdown fence
        cleanHtml = cleanHtml.substring(3);
        if (cleanHtml.endsWith('```')) {
            cleanHtml = cleanHtml.substring(0, cleanHtml.length - 3);
        }
    }
    
    cleanHtml = cleanHtml.trim();
    const cleanedLength = cleanHtml.length;
    if (cleanedLength === 0 && originalLength > 0 && CONFIG.DEBUG) {
        logger.warn('LLMService:_cleanHtmlOutput', 'Content became empty after HTML cleaning.', { originalContent: contentStr });
    } else if (cleanedLength < 50 && cleanedLength > 0 && CONFIG.DEBUG) {
        logger.warn('LLMService:_cleanHtmlOutput', 'Cleaned HTML content is very short.', { cleanedHtmlPreview: cleanHtml.substring(0,100) });
    }
    return cleanHtml;
}

function _cleanFullHtmlOutput(contentStr) {
    let html = String(contentStr || "").trim();

    const firstFence = html.indexOf('```');
    const lastFence = html.lastIndexOf('```');

    // If we have a starting and ending fence, and they are not the same
    if (firstFence !== -1 && lastFence > firstFence) {
        // Find the first newline after the first fence to skip the language specifier (e.g., "html")
        const startOfCode = html.indexOf('\n', firstFence) + 1;
        // The content is between the start of the code and the last fence
        html = html.substring(startOfCode, lastFence);
    }
    
    if (html.startsWith('```')) {
        const firstNewline = html.indexOf('\n');
        if (firstNewline !== -1) html = html.substring(firstNewline + 1);
    }
    if (html.endsWith('```')) {
        html = html.substring(0, html.length - 3);
    }

    return html.trim();
}


function _parseJsonArticleResponse(contentStr, providerNameForLog) {
    try {
        let jsonString = String(contentStr || "").trim();
        if (jsonString.startsWith('```json')) {
            jsonString = jsonString.substring(7).trim();
            if (jsonString.endsWith('```')) {
                jsonString = jsonString.substring(0, jsonString.length - 3).trim();
            }
        } else if (jsonString.startsWith('```')) {
            jsonString = jsonString.substring(3).trim();
            if (jsonString.endsWith('```')) {
                jsonString = jsonString.substring(0, jsonString.length - 3).trim();
            }
        }

        const firstBrace = jsonString.indexOf('{');
        const firstBracket = jsonString.indexOf('[');
        let potentialJsonStart = -1;

        if (firstBrace === -1 && firstBracket === -1) {
            logger.error(`LLMService:_parseJsonArticleResponse[${providerNameForLog}]`, `No JSON object or array structure detected. Content: "${jsonString.substring(0,500)}"`);
            throw new Error("No JSON object or array structure detected in the response.");
        } else if (firstBrace === -1) { potentialJsonStart = firstBracket; }
        else if (firstBracket === -1) { potentialJsonStart = firstBrace; }
        else { potentialJsonStart = Math.min(firstBrace, firstBracket); }

        if (potentialJsonStart > 0) {
            const prefix = jsonString.substring(0, potentialJsonStart);
            logger.warn(`LLMService:_parseJsonArticleResponse[${providerNameForLog}]`, `JSON content did not start at the beginning. Discarded prefix: "${prefix}". Attempting to parse from first '{' or '['.`);
            jsonString = jsonString.substring(potentialJsonStart);
        }

        let potentialJsonEnd = jsonString.length;
        if (jsonString.startsWith('{')) { const lastBrace = jsonString.lastIndexOf('}'); if (lastBrace > -1) potentialJsonEnd = lastBrace + 1; }
        else if (jsonString.startsWith('[')) { const lastBracket = jsonString.lastIndexOf(']'); if (lastBracket > -1) potentialJsonEnd = lastBracket + 1;}

        if (potentialJsonEnd < jsonString.length) {
             const suffix = jsonString.substring(potentialJsonEnd);
             logger.warn(`LLMService:_parseJsonArticleResponse[${providerNameForLog}]`, `JSON content might have trailing characters. Discarded suffix: "${suffix}"`);
             jsonString = jsonString.substring(0, potentialJsonEnd);
        }

        if (!jsonString) {
            logger.warn(`LLMService:_parseJsonArticleResponse[${providerNameForLog}]`, 'Content string became empty after attempting to isolate JSON.');
            throw new Error('LLM returned empty or unparsable content for article suggestions.');
        }

        let parsedJson = JSON.parse(jsonString);
        if (Array.isArray(parsedJson)) { 
            logger.warn(`LLMService:_parseJsonArticleResponse[${providerNameForLog}]`, `Returned JSON array directly for articles. Wrapping it.`);
            return { contents: parsedJson };
        }
        if (parsedJson.topic && parsedJson.contentSummary) { // For extract_topic_from_html
            return parsedJson;
        }
        // MODIFICATION START: Make the check more flexible
        if (parsedJson && (Array.isArray(parsedJson.contents) || Array.isArray(parsedJson.podcasts) || Array.isArray(parsedJson.media))) {
            return parsedJson;
        }
        // MODIFICATION END

        logger.error(`LLMService:_parseJsonArticleResponse[${providerNameForLog}]`, `Parsed JSON does not contain the expected "contents", "podcasts", or "media" array.`, parsedJson);
        throw new Error(`Parsed JSON is not in the expected format (missing "contents", "podcasts", or "media" array).`);

    } catch (parseError) {
        logger.error(`LLMService:_parseJsonArticleResponse[${providerNameForLog}]`, `Failed to parse JSON. Content that caused error (first 500 chars): "${contentStr.substring(0,500)}"`, { parseError });
        throw new Error(`Invalid JSON response format from ${providerNameForLog} for articles: ${parseError.message}`);
    }
}

// --- Core Prompt Text Definitions ---
function getExtractTopicPromptText(htmlContent) {
    const systemPrompt = `You are an expert web page analyzer. Your task is to analyze the provided text content of a webpage to identify its main topic and create a concise summary.
Your response MUST be a single, valid JSON object.
This JSON object MUST have exactly two keys:
- "topic": A string representing a short, descriptive title for the main subject of the page (e.g., "The History of Quantum Computing").
- "contentSummary": A string (2-3 sentences) summarizing the key points of the page's content.
Do NOT include any introductory text, apologies, or markdown formatting like \`\`\`json around your JSON output.
Adhere strictly to this JSON output format.`;

    const userPrompt = `Analyze the following webpage content and return the 'topic' and 'contentSummary' in the specified JSON format.
Page Content:
---
${htmlContent.substring(0, 15000)}
---`;
    return { systemPrompt, userPrompt };
}


function getArticlePromptText(context) {
      const { topic, contentSummary } = context;
      const systemPrompt = `You are a helpful assistant that curates Wikipedia learning guides. Based on the topic and summary of a source web page, you will return a list of 5-7 highly relevant English Wikipedia articles that expand on the topic.
Your response MUST be a single, valid JSON object.
This JSON object MUST have a single top-level key named "contents".
The value of "contents" MUST be an array of article objects.
Each article object in the "contents" array must have exactly these keys:
- "url": A string representing the canonical Wikipedia URL (starting with https://en.wikipedia.org/wiki/). The URL must resolve directly to the article and must NOT contain fragments (#) or query parameters (?). Verify page existence.
- "title": A string representing the exact title of the Wikipedia article.
- "relevance": A string (1-2 sentences) explaining the article's direct relevance to the topic and its role in the learning guide (e.g., overview, sub-topic, application).
Do NOT include disambiguation pages or "List of..." pages unless truly central.
Do NOT include any introductory text, explanations, apologies, or markdown formatting like \`\`\`json around your JSON output.
Adhere strictly to this JSON output format.`;
      const userPrompt = `The source page's topic is: "${topic}".
The summary of the source page is: "${contentSummary}".
Generate the Wikipedia learning guide.
Follow ALL instructions and formatting requirements precisely.
Ensure URLs are canonical and pages exist.
Your entire response must be a single JSON object as specified.`;
      return { systemPrompt, userPrompt };
}

function getSummaryPromptText(context) {
    const { topic, allPacketContents } = context;
    const externalArticlesForSynthesis = allPacketContents.filter(item => item.type === 'external' && item.url);
    const articleSynthesisInfo = externalArticlesForSynthesis.map(a => `- ${a.title}: ${a.url} (Relevance: ${a.relevance || 'N/A'})`).join('\n');

    // --- FIX START: Logic related to the quiz is removed. ---
    const systemPrompt = `You are an expert content creator and a knowledgeable guide. Your task is to generate the BODY HTML for a summary page that acts as a narrative guide to a topic, using a set of provided articles.

CRITICAL REQUIREMENTS:
1.  **Output ONLY HTML BODY Content:** Your entire response MUST be only the HTML content that would go INSIDE the \`<body>\` tags. Do NOT include \`<!DOCTYPE html>\`, \`<html>\`, \`<head>\`, or \`<body>\` tags themselves.
2.  **Narrative Structure:** Write in a conversational and engaging tone. Instead of a dry summary, act as a guide leading the user through the topic. Use headings (<h2>, <h3>) to create a logical flow.
3.  **Interweave Links Naturally:** You MUST link to every provided article within the flow of the text. Do not just list the links at the end. Introduce each link contextually. For example, instead of "Here is a link about X," write something like, "To get a foundational understanding, a great place to start is the article on <a href='...'>The History of X</a>, which covers the key milestones..."
4.  **Synthesize, Don't Just List:** Your narrative should connect the ideas from the different articles, showing how they relate to each other to build a complete picture of the topic.`;

    const userPrompt = `Generate the HTML body content for a narrative guide on "${topic}".
Your guide should naturally introduce and link to the following articles as part of the text:
${articleSynthesisInfo || "No primary external articles provided."}

**All Packet Contents Data (for context of what the user has):**
${allPacketContents.map(item => `- Title: ${item.title || 'Untitled'}, URL: ${item.predictedUrl || item.url || '#'}`).join('\n')}

Follow ALL instructions from the system prompt precisely. Create an engaging narrative, not a simple list.`;
    // --- FIX END ---
    
    return { systemPrompt, userPrompt };
}

function getQuizPromptText(context) {
    const { topic, articlesData } = context;
    const articleInfo = articlesData.map(a => `- ${a.title}: ${a.url} (Relevance: ${a.relevance || 'N/A'})`).join('\n');
  
    const systemPrompt = `You are an expert educational content creator and web developer. Your task is to generate the BODY HTML content for an interactive, client-side quiz.
CRITICAL REQUIREMENTS:
1.  **Content:** Create 5-7 multiple-choice questions testing key concepts from the provided Wikipedia articles.
2.  **Output Format:** Your entire response MUST be only the HTML content that would go INSIDE the \`<body>\` tag. Do NOT include \`<html>\`, \`<head>\`, or \`<body>\` tags.
3.  **HTML Structure:** Use semantic HTML. For each question, use a container div, a paragraph for the question text, and an unordered list of radio button options. Include a single "Submit Quiz" button at the end and a div for results.
4.  **Embedded JavaScript:** All JavaScript logic MUST be embedded within a single \`<script>\` tag at the end of your HTML output. Use plain, vanilla JavaScript.
5.  **Completion Event (Most Important):** The script you write MUST contain the full definition of the \`notifyExtensionOnCompletion()\` function, and you must call this function when the quiz is successfully completed. This is the ONLY way the extension knows the user is done.`;
  
    const userPrompt = `Generate the HTML body content (including an embedded script with the function definition) for an interactive quiz on the topic "${topic}".
Base the quiz questions on the key information from these Wikipedia articles:
${articleInfo}

Your output MUST be ONLY the content for the \`<body>\` tag.
**IMPORTANT CONTEXT:** The parent extension will load this HTML page and automatically append a query parameter \`?extensionId=...\` to the URL. Your script must read this ID from the URL to communicate back.

**REQUIRED FUNCTION DEFINITION AND USAGE:**
Your script must include the complete definition of the following function:
\`\`\`javascript
function notifyExtensionOnCompletion() {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      const params = new URLSearchParams(window.location.search);
      const extensionId = params.get('extensionId');
      if (extensionId) {
        console.log('Notifying extension of completion:', extensionId);
        chrome.runtime.sendMessage(extensionId, {
          action: 'page_interaction_complete',
          data: { url: window.location.href }
        });
      } else {
        console.warn('Unlock Extension ID not found in URL, cannot notify completion.');
      }
    }
  } catch (e) {
    console.error('Error notifying extension:', e);
  }
}
\`\`\`
Then, your quiz logic must call \`notifyExtensionOnCompletion()\` only when the user has answered all questions correctly. Adhere strictly to all requirements.`;
    return { systemPrompt, userPrompt };
}

function getCustomPagePromptText(prompt, context) {
    const contextInfo = context && context.length > 0
        ? `For context, here are the other pages already in this packet:\n${context.map(c => `- ${c.title} (${c.url || 'Generated Page'})`).join('\n')}`
        : "There are no other pages in the packet yet.";

    const systemPrompt = `You are a highly skilled senior web developer. Your task is to create a complete, self-contained, and functional single-page HTML application based on the user's request.

CRITICAL REQUIREMENTS:
1.  **Single File Output:** You MUST return only a single, complete HTML file. Do not wrap it in markdown fences like \`\`\`.
2.  **Self-Contained:** All CSS and JavaScript MUST be embedded directly into the HTML file.
3.  **No External Resources:** Do not use external URLs for scripts, stylesheets, or images.
4.  **Best Practices:** Write clean, readable, and efficient code.
5.  **Fulfill the Prompt:** Directly address the user's request to build the application they have described.`;
    
    const userPrompt = `Generate a complete HTML page for the following request: "${prompt}"\n\n${contextInfo}`;

    return { systemPrompt, userPrompt };
}

function getModificationPromptText(htmlContent) {
    const systemPrompt = `You are an expert web developer specializing in analyzing and modifying HTML code. You will be given a self-contained HTML document.
Your task is to determine if there is a natural point of completion in the user's journey on this page (e.g., submitting a quiz, clicking a final 'I'm Done' button, finishing a game).

- **IF a logical completion event exists:** You MUST modify the page's existing \`<script>\` tag. First, **ensure the full definition of the \`notifyExtensionOnCompletion()\` function is present** within the script. Then, add a call to it at the appropriate completion event (e.g., inside a submit handler). Do NOT add a new \`<script>\` tag.
- **IF NO single, clear completion event exists** (e.g., it is a static informational page): You MUST return the original HTML code completely unmodified.

**The required function definition to include is:**
\`\`\`javascript
function notifyExtensionOnCompletion() {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      const params = new URLSearchParams(window.location.search);
      const extensionId = params.get('extensionId');
      if (extensionId) {
        console.log('Notifying extension of completion:', extensionId);
        chrome.runtime.sendMessage(extensionId, {
          action: 'page_interaction_complete',
          data: { url: window.location.href }
        });
      } else {
        console.warn('Unlock Extension ID not found in URL, cannot notify completion.');
      }
    }
  } catch (e) {
    console.error('Error notifying extension:', e);
  }
}
\`\`\`

Your entire response MUST be ONLY the final, complete HTML code, either modified or unmodified. Do not add explanations or markdown fences.`;

    const userPrompt = `Analyze and, if appropriate, modify the following HTML to include the completion trigger and its definition. Otherwise, return it unchanged.
\`\`\`html
${htmlContent}
\`\`\``;
    return { systemPrompt, userPrompt };
}

function getMediaPromptText(context) {
    const { htmlContent } = context;
    const systemPrompt = `You are an expert at finding direct links to media files within HTML content.
Your response MUST be a single, valid JSON object.
This JSON object MUST have a single top-level key named "media".
The value of "media" MUST be an array of objects, where each object has two keys:
- "url": The value of the src attribute of the media tag, even if it is a relative path.
- "title": A suitable title for the media, derived from the surrounding text.
If no media files are found, return an empty array for the "media" value.
Do NOT include any introductory text, apologies, or markdown formatting like \`\`\`json around your JSON output.`;
    const userPrompt = `Analyze the following webpage content and extract all media links in the specified JSON format.
Page Content:
---
${htmlContent.substring(0, 15000)}
---`;
    return { systemPrompt, userPrompt };
}

const llmService = {
    prepareOpenAIPayload(promptType, context, activeModelConfig) {
        let systemPrompt, userPrompt;
        let responseFormat = undefined;
        let maxTokensForTask = 8192;

        if (promptType === 'extract_topic_from_html') {
            ({ systemPrompt, userPrompt } = getExtractTopicPromptText(context.htmlContent));
            responseFormat = { type: "json_object" };
            maxTokensForTask = 1024;
        } else if (promptType === 'article_suggestions') {
            ({ systemPrompt, userPrompt } = getArticlePromptText(context));
            responseFormat = { type: "json_object" };
            maxTokensForTask = 2048;
        } else if (promptType === 'extract_media') {
            ({ systemPrompt, userPrompt } = getMediaPromptText(context));
            responseFormat = { type: "json_object" };
            maxTokensForTask = 2048;
        } else if (promptType === 'summary_page' || promptType === 'quiz_page') {
             if (promptType === 'summary_page') ({ systemPrompt, userPrompt } = getSummaryPromptText(context));
             if (promptType === 'quiz_page') ({ systemPrompt, userPrompt } = getQuizPromptText(context));
        } else if (promptType === 'custom_page') {
            ({ systemPrompt, userPrompt } = getCustomPagePromptText(context.prompt, context.context));
        } else if (promptType === 'modify_html_for_completion') {
            ({ systemPrompt, userPrompt } = getModificationPromptText(context.htmlContent));
        } else { throw new Error(`Invalid promptType for OpenAI: ${promptType}`); }
        
        const messages = [];
        if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
        messages.push({ role: "user", content: userPrompt });
        const payload = { model: activeModelConfig.modelName, messages, temperature: CONFIG.TEMPERATURE, max_tokens: maxTokensForTask };
        if (responseFormat) payload.response_format = responseFormat;
        return payload;
    },
    parseOpenAIResponse(promptType, responseData) {
        if (!responseData.choices?.[0]?.message?.content) {
            logger.error('LLMService:parseOpenAIResponse', 'Invalid OpenAI response structure', { responseData });
            throw new Error('Invalid OpenAI response structure: Missing content.');
        }
        const contentStr = responseData.choices[0].message.content;

        if (promptType === 'custom_page' || promptType === 'modify_html_for_completion') {
            return _cleanFullHtmlOutput(contentStr);
        }
        if (promptType === 'article_suggestions' || promptType === 'extract_topic_from_html' || promptType === 'extract_media') {
            return _parseJsonArticleResponse(contentStr, `OpenAI (${responseData.model || ''})`);
        }
        if (promptType === 'summary_page' || promptType === 'quiz_page') {
            return _cleanHtmlOutput(contentStr);
        }
        throw new Error(`Invalid promptType for OpenAI parsing: ${promptType}`);
    },
    prepareGeminiPayload(promptType, context, activeModelConfig) {
        let systemPrompt, userPrompt, promptText;
        let maxOutputTokensForTask = 8192; // Default high for Gemini
        let generationConfig = { temperature: CONFIG.TEMPERATURE, maxOutputTokens: maxOutputTokensForTask };
        let responseMimeType = "text/plain"; 
        
        if (promptType === 'extract_topic_from_html') {
            ({ systemPrompt, userPrompt } = getExtractTopicPromptText(context.htmlContent));
            responseMimeType = "application/json";
        } else if (promptType === 'article_suggestions') {
            ({ systemPrompt, userPrompt } = getArticlePromptText(context));
            responseMimeType = "application/json"; 
        } else if (promptType === 'extract_media') {
            ({ systemPrompt, userPrompt } = getMediaPromptText(context));
            responseMimeType = "application/json";
        } else if (promptType === 'summary_page') {
            ({ systemPrompt, userPrompt } = getSummaryPromptText(context));
        } else if (promptType === 'quiz_page') {
            ({ systemPrompt, userPrompt } = getQuizPromptText(context));
        } else if (promptType === 'custom_page') {
             ({ systemPrompt, userPrompt } = getCustomPagePromptText(context.prompt, context.context));
        } else if (promptType === 'modify_html_for_completion') {
            ({ systemPrompt, userPrompt } = getModificationPromptText(context.htmlContent));
        } else { throw new Error(`Invalid promptType for Gemini: ${promptType}`); }
        
        promptText = `${systemPrompt}\n\n${userPrompt}`; 
        
        if (responseMimeType === "application/json") {
            generationConfig.responseMimeType = responseMimeType;
        }
        
        return { contents: [{ parts: [{ text: promptText }] }], generationConfig };
    },
    parseGeminiResponse(promptType, responseData) {
        const candidate = responseData?.candidates?.[0];
        if (!candidate || !candidate.content?.parts?.[0]?.text) {
            const finishReason = candidate?.finishReason; const safetyRatings = candidate?.safetyRatings;
            logger.error('LLMService:parseGeminiResponse', `Gemini response missing content/blocked.`, { finishReason, safetyRatings, responseData });
            let eMsg = 'Gemini response missing content.';
            if (finishReason === 'SAFETY') eMsg = `Gemini blocked due to safety. Ratings: ${JSON.stringify(safetyRatings)}`;
            else if (finishReason) eMsg = `Gemini terminated due to: ${finishReason}.`;
            throw new Error(eMsg);
        }
        const contentStr = candidate.content.parts[0].text;
        
        if (promptType === 'custom_page' || promptType === 'modify_html_for_completion') {
            return _cleanFullHtmlOutput(contentStr);
        }
        if (promptType === 'article_suggestions' || promptType === 'extract_topic_from_html' || promptType === 'extract_media') return _parseJsonArticleResponse(contentStr, `Gemini (${responseData.model || ''})`);
        else if (promptType === 'summary_page' || promptType === 'quiz_page') return _cleanHtmlOutput(contentStr);
        else throw new Error(`Invalid promptType for Gemini parsing: ${promptType}`);
    },
    prepareChromeAiPayload(promptType, context, activeModelConfig) {
        let systemPrompt, userPrompt, fullPrompt;
        if (promptType === 'extract_topic_from_html') {
            ({ systemPrompt, userPrompt } = getExtractTopicPromptText(context.htmlContent));
            userPrompt += "\n\nIMPORTANT: Your entire response MUST be only the valid JSON object as described, without any surrounding text or markdown.";
        } else if (promptType === 'article_suggestions') {
            ({ systemPrompt, userPrompt } = getArticlePromptText(context));
            userPrompt += "\n\nIMPORTANT: Your entire response MUST be only the valid JSON object as described, without any surrounding text or markdown.";
        } else if (promptType === 'extract_media') {
            ({ systemPrompt, userPrompt } = getMediaPromptText(context));
            userPrompt += "\n\nIMPORTANT: Your entire response MUST be only the valid JSON object as described, without any surrounding text or markdown.";
        } else if (promptType === 'summary_page') {
            ({ systemPrompt, userPrompt } = getSummaryPromptText(context));
        } else if (promptType === 'quiz_page') {
            ({ systemPrompt, userPrompt } = getQuizPromptText(context));
        } else if (promptType === 'custom_page') {
             ({ systemPrompt, userPrompt } = getCustomPagePromptText(context.prompt, context.context));
        } else if (promptType === 'modify_html_for_completion') {
            ({ systemPrompt, userPrompt } = getModificationPromptText(context.htmlContent));
        } else { throw new Error(`Invalid promptType for Chrome AI: ${promptType}`); }
        fullPrompt = `${systemPrompt}\n\n${userPrompt}`;
        return fullPrompt; 
    },
    parseChromeAiResponse(promptType, responseString) {
        if (promptType === 'custom_page' || promptType === 'modify_html_for_completion') {
            return _cleanFullHtmlOutput(responseString);
        }
        if (promptType === 'article_suggestions' || promptType === 'extract_topic_from_html' || promptType === 'extract_media') return _parseJsonArticleResponse(responseString, 'ChromeAI-Nano');
        else if (promptType === 'summary_page' || promptType === 'quiz_page') return _cleanHtmlOutput(responseString);
        else throw new Error(`Invalid promptType for Chrome AI parsing: ${promptType}`);
    },
    preparePerplexityPayload(promptType, context, activeModelConfig) {
        return this.prepareOpenAIPayload(promptType, context, activeModelConfig);
    },
    parsePerplexityResponse(promptType, responseData, activeModelConfig) {
        return this.parseOpenAIResponse(promptType, { ...responseData, model: responseData.model || activeModelConfig.modelName });
    },
    prepareAnthropicPayload(promptType, context, activeModelConfig) {
        let systemPromptText = ""; let userMessages = [];
        let maxTokensForTask = 8192;  

        if (promptType === 'extract_topic_from_html') {
            const { systemPrompt, userPrompt } = getExtractTopicPromptText(context.htmlContent);
            systemPromptText = systemPrompt;
            userMessages = [{role: "user", content: userPrompt }];
            maxTokensForTask = 1024;
        } else if (promptType === 'article_suggestions') {
            const { systemPrompt, userPrompt } = getArticlePromptText(context);
            systemPromptText = systemPrompt;
            userMessages = [{role: "user", content: userPrompt }];
            maxTokensForTask = 2048;
        } else if (promptType === 'extract_media') {
            const { systemPrompt, userPrompt } = getMediaPromptText(context);
            systemPromptText = systemPrompt;
            userMessages = [{role: "user", content: userPrompt }];
            maxTokensForTask = 2048;
        } else if (promptType === 'summary_page') {
            const { systemPrompt, userPrompt } = getSummaryPromptText(context);
            systemPromptText = systemPrompt;
            userMessages = [{role: "user", content: userPrompt }];
        } else if (promptType === 'quiz_page') {
            const { systemPrompt, userPrompt } = getQuizPromptText(context);
            systemPromptText = systemPrompt;
            userMessages = [{role: "user", content: userPrompt }];
        } else if (promptType === 'custom_page') {
             const { systemPrompt, userPrompt } = getCustomPagePromptText(context.prompt, context.context);
             systemPromptText = systemPrompt;
             userMessages = [{role: "user", content: userPrompt }];
        } else if (promptType === 'modify_html_for_completion') {
            const { systemPrompt, userPrompt } = getModificationPromptText(context.htmlContent);
            systemPromptText = systemPrompt;
            userMessages = [{role: "user", content: userPrompt }];
        } else { throw new Error(`Invalid promptType for Anthropic: ${promptType}`); }

        const payload = {
            model: activeModelConfig.modelName,
            messages: userMessages,
            max_tokens: maxTokensForTask,
            temperature: CONFIG.TEMPERATURE
        };
        if (systemPromptText) {
            payload.system = systemPromptText; 
        }
        return payload;
    },
    parseAnthropicResponse(promptType, responseData) {
        const contentBlock = responseData?.content?.[0];
        if (!contentBlock || typeof contentBlock.text !== 'string') {
             logger.error('LLMService:parseAnthropicResponse', 'Invalid Anthropic response structure', { responseData, stopReason: responseData?.stop_reason });
             let eMsg = 'Invalid Anthropic response structure: Missing content text.';
             if(responseData?.stop_reason && responseData.stop_reason !== "end_turn" && responseData.stop_reason !== "max_tokens") {
                eMsg = `Anthropic request failed or was blocked. Reason: ${responseData.stop_reason}`;
             } else if (responseData?.error?.message) {
                eMsg = `Anthropic API error: ${responseData.error.message}`;
             } else if (responseData?.type === 'error' && responseData?.error?.type) {
                eMsg = `Anthropic API error: ${responseData.error.type} - ${responseData.error.message}`;
             }
            throw new Error(eMsg);
        }
        const contentStr = contentBlock.text;
        
        if (promptType === 'custom_page' || promptType === 'modify_html_for_completion') {
            return _cleanFullHtmlOutput(contentStr);
        }
        if (promptType === 'article_suggestions' || promptType === 'extract_topic_from_html' || promptType === 'extract_media') return _parseJsonArticleResponse(contentStr, `Anthropic (${responseData.model || ''})`);
        else if (promptType === 'summary_page' || promptType === 'quiz_page') return _cleanHtmlOutput(contentStr);
        else throw new Error(`Invalid promptType for Anthropic parsing: ${promptType}`);
    },
    prepareGrokPayload(promptType, context, activeModelConfig) {
        return this.prepareOpenAIPayload(promptType, context, activeModelConfig);
    },
    parseGrokResponse(promptType, responseData, activeModelConfig) { 
        return this.parseOpenAIResponse(promptType, { ...responseData, model: responseData.model || activeModelConfig.modelName });
    },
    LLM_PROCESSORS: {
      'openai': {
        preparePayload: (pt, c, amc) => llmService.prepareOpenAIPayload(pt, c, amc),
        parseResponse: (pt, rd, amc) => llmService.parseOpenAIResponse(pt, rd, amc),
        constructApiUrl: (endpoint, modelName, apiKey) => endpoint,
        getHeaders: (apiKey) => ({ 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }),
        isLocalApi: false
      },
      'gemini': {
        preparePayload: (pt, c, amc) => llmService.prepareGeminiPayload(pt, c, amc),
        parseResponse: (pt, rd, amc) => llmService.parseGeminiResponse(pt, rd, amc),
        constructApiUrl: (endpoint, modelName, apiKey) => `${endpoint.replace(/\/$/, '')}/${modelName}:generateContent?key=${apiKey}`,
        getHeaders: (apiKey) => ({'Content-Type': 'application/json'}),
        isLocalApi: false
      },
      'perplexity': {
        preparePayload: (pt, c, amc) => llmService.preparePerplexityPayload(pt, c, amc),
        parseResponse: (pt, rd, amc) => llmService.parsePerplexityResponse(pt, rd, amc),
        constructApiUrl: (endpoint, modelName, apiKey) => endpoint,
        getHeaders: (apiKey) => ({
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }),
        isLocalApi: false
      },
      'deepseek': {
        preparePayload: (pt, c, amc) => llmService.prepareOpenAIPayload(pt, c, amc),
        parseResponse: (pt, rd, amc) => llmService.parseOpenAIResponse(pt, rd, amc),
        constructApiUrl: (endpoint, modelName, apiKey) => endpoint,
        getHeaders: (apiKey) => ({ 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', }),
        isLocalApi: false
      },
      'llama': {
        preparePayload: (pt, c, amc) => llmService.prepareOpenAIPayload(pt, c, amc),
        parseResponse: (pt, rd, amc) => llmService.parseOpenAIResponse(pt, rd, amc),
        constructApiUrl: (endpoint, modelName, apiKey) => endpoint,
        getHeaders: (apiKey) => ({ 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', }),
        isLocalApi: false
      },
      'chrome-ai-gemini-nano': {
        preparePayload: (pt, c, amc) => llmService.prepareChromeAiPayload(pt, c, amc),
        parseResponse: (pt, rs, amc) => llmService.parseChromeAiResponse(pt, rs, amc),
        constructApiUrl: () => null, 
        getHeaders: () => ({}),    
        isLocalApi: true
      },
      'anthropic': {
        preparePayload: (pt, c, amc) => llmService.prepareAnthropicPayload(pt, c, amc),
        parseResponse: (pt, rd, amc) => llmService.parseAnthropicResponse(pt, rd, amc),
        constructApiUrl: (endpoint, modelName, apiKey) => endpoint,
        getHeaders: (apiKey) => ({
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01', 
            'content-type': 'application/json',
            'anthropic-dangerous-direct-browser-access': 'true' 
        }),
        isLocalApi: false
      },
      'openai-compatible': { 
        preparePayload: (pt, c, amc) => llmService.prepareOpenAIPayload(pt, c, amc),
        parseResponse: (pt, rd, amc) => llmService.parseOpenAIResponse(pt, rd, amc),
        constructApiUrl: (endpoint, modelName, apiKey) => endpoint, 
        getHeaders: (apiKey) => ({ 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }),
        isLocalApi: false
      },
      'grok': {
        preparePayload: (pt, c, amc) => llmService.prepareOpenAIPayload(pt, c, amc),
        parseResponse: (pt, rd, amc) => llmService.parseOpenAIResponse(pt, rd, amc), 
        constructApiUrl: (endpoint, modelName, apiKey) => endpoint, 
        getHeaders: (apiKey) => ({ 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }),
        isLocalApi: false
      }
    },

    async callLLM(promptType, context) {
        const activeModelConfig = await storage.getActiveModelConfig();
        if (!activeModelConfig) {
            return { success: false, error: 'No active LLM model configured. Please check settings.' };
        }
    
        const { id: modelId, name: modelFriendlyName, providerType, apiKey, modelName, apiEndpoint } = activeModelConfig;
        const processor = this.LLM_PROCESSORS[providerType];
    
        if (!processor) {
            const errorMsg = `Unsupported providerType: '${providerType}' for model '${modelFriendlyName}' (${modelId}). Check model configuration or implement support.`;
            logger.error('LLMService:callLLM', errorMsg);
            return { success: false, error: errorMsg };
        }
    
        try {
            const llmInput = processor.preparePayload(promptType, context, activeModelConfig);
            let llmOutput;
    
            if (processor.isLocalApi) {
                const languageModelAPI = LanguageModel;
                if (!languageModelAPI || typeof languageModelAPI.create !== 'function') {
                    throw new Error('Chrome LanguageModel API (chrome.languageModel.create) is not available. Ensure Chrome is updated and relevant flags (if any) are enabled.');
                }
                const session = await languageModelAPI.create({});
                if (typeof session.prompt !== 'function') {
                    if(typeof session.destroy === 'function') session.destroy();
                    throw new Error("The created LanguageModel session does not have a 'prompt' method.");
                }
                llmOutput = await session.prompt(llmInput);
                if(typeof session.destroy === 'function') session.destroy();
            } else {
                const effectiveApiUrl = processor.constructApiUrl(apiEndpoint, modelName, apiKey);
                if (!effectiveApiUrl) {
                    throw new Error(`Could not construct API URL for provider ${providerType} with endpoint ${apiEndpoint}`);
                }
                const headers = { ...processor.getHeaders(apiKey) };
                if (!headers['Content-Type'] && typeof llmInput === 'object') {
                     headers['Content-Type'] = 'application/json';
                }
    
                const response = await fetch(effectiveApiUrl, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(llmInput)
                });
    
                if (!response.ok) {
                    let errorResponseMessage = await response.text();
                    let errorDataForLog = { error: { message: errorResponseMessage } };
                    try { errorDataForLog = JSON.parse(errorResponseMessage); } catch (e) { /* ignore */ }
                    let detailedErrorMsg = errorDataForLog?.error?.message || errorResponseMessage || `HTTP error ${response.status}`;
                    logger.error('LLMService:callLLM', `LLM API call failed for ${providerType}`, { status: response.status, errorMsg: detailedErrorMsg });
                    throw new Error(detailedErrorMsg);
                }
    
                llmOutput = await response.json();
            }
    
            const parsedData = processor.parseResponse(promptType, llmOutput, activeModelConfig);
            return { success: true, data: parsedData };
    
        } catch (error) {
            logger.error('LLMService:callLLM', `Error during LLM API call for ${providerType}`, error);
            return { success: false, error: error.message || 'An unknown error occurred.' };
        }
    }
};

export default llmService;