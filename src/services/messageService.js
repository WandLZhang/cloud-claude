const CLOUD_FUNCTION_URL = process.env.REACT_APP_CLOUD_FUNCTION_URL;

const DEFAULT_SYSTEM_PROMPT = `You are Claude, a helpful AI assistant. Engage in natural conversation,
be helpful, harmless, and honest. Provide thoughtful and detailed responses when appropriate.`;

export async function* streamMessageToClaud(previousMessages, newContent, image, config = {}) {
  try {
    // Prepare messages array for Claude.
    // Pass image/document Storage URLs through per-message so historical
    // attachments are visible to the model on follow-up turns. The backend
    // re-downloads each Storage URL and embeds it as an image/document block.
    const messages = previousMessages.map(msg => {
      const out = { role: msg.role, content: msg.content || '' };
      if (msg.image && msg.image.url) {
        out.image = { url: msg.image.url, type: msg.image.type };
      }
      if (msg.document && msg.document.url) {
        out.document = {
          url: msg.document.url,
          type: msg.document.type,
          name: msg.document.name
        };
      }
      return out;
    });

    // Add the new message
    messages.push({
      role: 'user',
      content: newContent || ''
    });

    // Prepare request payload
    const payload = {
      messages,
      use_cache: true
    };

    // Use custom system prompt if provided, otherwise use default
    payload.system_prompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

    // Add image if provided
    if (image) {
      payload.image = {
        url: image.url,
        type: image.type
      };
    }

    // Add document (PDF) if provided
    if (config.document) {
      payload.document = {
        url: config.document.url,
        type: config.document.type
      };
      console.log('[messageService] Sending with document:', config.document.name);
    }

    // Add disable_thinking flag if specified in config.
    // BUT override to false when any image is in play (current turn or history) -
    // Opus 4.7 with thinking disabled tends to stop early on image translation
    // tasks, mid-syllable. Image turns get full adaptive thinking even for the
    // "Everyday Chinese" prompt; text-only turns stay fast.
    if (config.disableThinking) {
      const hasAnyImage = !!image || previousMessages.some(m => m && m.image);
      if (hasAnyImage) {
        console.log('[messageService] Image attached - overriding disableThinking, enabling adaptive thinking');
      } else {
        payload.disable_thinking = true;
        console.log('[messageService] Sending with disable_thinking=true');
      }
    }

    // Use fast model (Sonnet) if specified
    if (config.useFastModel) {
      payload.use_fast_model = true;
      console.log('[messageService] Using fast model (Sonnet 4.6)');
    }

    // Enable web search if specified
    if (config.enableWebSearch) {
      payload.enable_web_search = true;
      console.log('[messageService] Web search enabled');
    }

    console.log('[messageService] Payload keys:', Object.keys(payload));

    // Use fetch for streaming support
    const response = await fetch(CLOUD_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Read the streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalData = null;

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);

          if (data.trim()) {
            try {
              const parsed = JSON.parse(data);

              if (parsed.type === 'chunk') {
                yield { type: 'chunk', text: parsed.text };
              } else if (parsed.type === 'done') {
                finalData = parsed;
              } else if (parsed.type === 'error') {
                throw new Error(parsed.error);
              }
            } catch (e) {
              console.error('Failed to parse SSE data:', e);
            }
          }
        }
      }
    }

    // Return final data with complete response
    if (finalData) {
      yield {
        type: 'done',
        content: finalData.content,
        thinking: finalData.thinking,
        usage: finalData.usage,
        cached: finalData.cached,
        model: finalData.model,
        citations: finalData.citations || null,
        web_search_queries: finalData.web_search_queries || null
      };
    }

  } catch (error) {
    console.error('Error calling Claude API:', error);
    throw new Error(error.message || 'Failed to get response from Claude');
  }
}

// Legacy non-streaming function for backward compatibility
export async function sendMessageToClaud(previousMessages, newContent, image) {
  let fullContent = '';
  let finalResponse = null;

  const stream = streamMessageToClaud(previousMessages, newContent, image);

  for await (const data of stream) {
    if (data.type === 'chunk') {
      fullContent += data.text;
    } else if (data.type === 'done') {
      finalResponse = data;
    }
  }

  return finalResponse || { content: fullContent };
}
