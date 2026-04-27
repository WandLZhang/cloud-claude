const CLOUD_FUNCTION_URL = process.env.REACT_APP_CLOUD_FUNCTION_URL;

const DEFAULT_SYSTEM_PROMPT = `You are Claude, a helpful AI assistant. Engage in natural conversation,
be helpful, harmless, and honest. Provide thoughtful and detailed responses when appropriate.`;

const CHINESE_FORMAT_SUFFIX = `

When your response includes Chinese characters with phonetic transcription (jyutping or pinyin), format them with HTML wrappers so the UI can render phonetics above characters:

CANTONESE (jyutping = ASCII letters + tone digit 1-6):
- Wrap each Chinese-character line in <span class="zh-yue">…</span>
- Keep the jyutping line OUTSIDE the span on the next line
- Example:
  <span class="zh-yue">從前，喺一個好遠嘅國度</span>
  cung4 cin4, hai2 jat1 go3 hou2 jyun5 ge3 gwok3 dou6

MANDARIN (pinyin = diacritics like nǐ hǎo):
- Convert to inline <ruby> tags, one <rt> per character. DELETE the standalone pinyin line.
- Example: <ruby>你<rt>nǐ</rt>好<rt>hǎo</rt></ruby>
- For interleaved format (鸟niǎo儿ér), also convert: <ruby>鸟<rt>niǎo</rt>儿<rt>ér</rt></ruby>

BOTH in one response:
  **Mandarin:** <ruby>你<rt>nǐ</rt>好<rt>hǎo</rt></ruby>
  **Cantonese:**
  <span class="zh-yue">你好</span>
  nei5 hou2

If no Chinese phonetics in the response, ignore these rules entirely.`;

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

    // Use custom system prompt if provided, otherwise use default.
    // Append the Chinese formatting suffix only when the prompt is
    // Chinese-related (mentions Mandarin/Cantonese/pinyin/jyutping).
    // For all other cases, the wrap_content post-processor catches any
    // Chinese responses that slip through without wrappers.
    const basePrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    const promptLower = (basePrompt + ' ' + (newContent || '')).toLowerCase();
    const isChinese = /mandarin|cantonese|pinyin|jyutping|粵|普通話|广东话|翻译|翻譯/.test(promptLower);
    payload.system_prompt = isChinese ? basePrompt + CHINESE_FORMAT_SUFFIX : basePrompt;

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
      let content = finalData.content;

      // Always normalize Chinese+phonetic responses through wrap_content
      // mode on the chat Cloud Function. Ensures consistent rendering.
      if (content && CLOUD_FUNCTION_URL) {
        const hasCJK = /[一-鿿]/.test(content);
        const hasWrapper = content.includes('class="zh-yue"') || content.includes('<ruby>') || content.includes('<rt>');
        const hasPhonetic = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/.test(content) || /\b[a-z]{1,6}[1-6]\b/.test(content);
        if (hasCJK && !hasWrapper && hasPhonetic) {
          try {
            console.log('[messageService] CJK without wrappers detected — calling wrap_content safety net');
            const wrapResp = await fetch(CLOUD_FUNCTION_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ wrap_content: content, use_fast_model: true })
            });
            if (wrapResp.ok) {
              const wrapData = await wrapResp.json();
              if (wrapData.wrapped) {
                content = wrapData.wrapped;
                console.log('[messageService] wrap_content normalization applied');
              }
            }
          } catch (wrapErr) {
            console.error('[messageService] wrap_content normalization failed (non-fatal):', wrapErr);
          }
        }
      }

      yield {
        type: 'done',
        content,
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
