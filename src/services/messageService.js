const CLOUD_FUNCTION_URL = process.env.REACT_APP_CLOUD_FUNCTION_URL;

const DEFAULT_SYSTEM_PROMPT = `You are Claude, a helpful AI assistant. Engage in natural conversation,
be helpful, harmless, and honest. Provide thoughtful and detailed responses when appropriate.`;

// Appended when a turn is a bare photo. Photographing book pages means every turn after the first
// carried an EMPTY user message, so in a 70-page chat the only instruction the model ever saw was
// the first turn's one-liner — which is how it drifted into continuing a story it recognised
// instead of translating the page in front of it.
const IMAGE_TURN_HINT = 'The text is in the attached photo. Work only from what is on THIS image.';

/** Reuse the chat's opening instruction (the saved-prompt text) for a photo-only turn. */
function instructionForImageTurn(previousMessages) {
  const opener = previousMessages.find((m) => m.role === 'user' && (m.content || '').trim());
  const lead = opener ? opener.content.trim() : '';
  return lead ? `${lead}\n\n${IMAGE_TURN_HINT}` : IMAGE_TURN_HINT;
}

/**
 * Stream one turn from the chat function, yielding chunk / status / error / done events.
 *
 * `persist` ({ chatId, messageId, idToken }) asks the function to save the reply to Firestore
 * itself. A thrown error carries `serverStarted`: false when the request never got a response (the
 * function never started the turn), true when the stream broke after it started (the function
 * keeps going and saves the outcome).
 */
export async function* streamMessageToClaud(previousMessages, newContent, image, config = {}, persist = null) {
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

  // Add the new message. A photo with no typed text gets the chat's opening instruction restated
  // — the Firestore message stays empty so the UI still shows just the photo.
  const outgoing = (newContent || '').trim();
  const turnText = (!outgoing && image) ? instructionForImageTurn(previousMessages) : (newContent || '');
  if (!outgoing && image) {
    console.log('[messageService] Photo-only turn — restating instruction:', turnText);
  }
  messages.push({
    role: 'user',
    content: turnText
  });

  // Prepare request payload
  const payload = {
    messages,
    use_cache: true
  };

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

  const headers = { 'Content-Type': 'application/json' };
  if (persist) {
    payload.persist = { chat_id: persist.chatId, message_id: persist.messageId };
    headers.Authorization = `Bearer ${persist.idToken}`;
    console.log('[messageService] persist:', payload.persist);
  }

  console.log('[messageService] Payload keys:', Object.keys(payload));

  // Use fetch for streaming support
  let response;
  try {
    response = await fetch(CLOUD_FUNCTION_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.error('[messageService] the request never reached the function:', error);
    throw Object.assign(error, { serverStarted: false });
  }

  if (!response.ok) {
    console.error('[messageService] the function refused the request:', response.status);
    throw Object.assign(new Error(`HTTP error! status: ${response.status}`), { serverStarted: false });
  }

  // Read the streaming response
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalData = null;

  while (true) {
    let result;
    try {
      result = await reader.read();
    } catch (error) {
      console.error('[messageService] lost the stream after the function started:', error);
      throw Object.assign(error, { serverStarted: true });
    }
    const { done, value } = result;

    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      // Skips blank separators and ': keepalive' comments.
      if (!line.startsWith('data: ')) continue;

      let parsed;
      try {
        parsed = JSON.parse(line.slice(6));
      } catch (e) {
        console.error('Failed to parse SSE data:', e);
        continue;
      }

      if (parsed.type === 'chunk') {
        yield { type: 'chunk', text: parsed.text };
      } else if (parsed.type === 'status') {
        yield { type: 'status', status: parsed.status };
      } else if (parsed.type === 'error') {
        console.error('[messageService] the function reported an error:', parsed.error);
        yield { type: 'error', error: parsed.error };
      } else if (parsed.type === 'done') {
        finalData = parsed;
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
      thinkingSeconds: finalData.thinking_seconds ?? null,
      citations: finalData.citations || null,
      web_search_queries: finalData.web_search_queries || null
    };
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
