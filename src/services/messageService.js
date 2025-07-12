const CLOUD_FUNCTION_URL = process.env.REACT_APP_CLOUD_FUNCTION_URL;

export async function* streamMessageToClaud(previousMessages, newContent, image) {
  try {
    // Prepare messages array for Claude
    const messages = previousMessages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));

    // Add the new message
    messages.push({
      role: 'user',
      content: newContent
    });

    // Prepare request payload
    const payload = {
      messages,
      max_tokens: 8192,  // Maximum output tokens for Claude Opus 4
      use_cache: true
    };

    // Add system prompt for better responses
    payload.system_prompt = `You are Claude, a helpful AI assistant. Engage in natural conversation, 
    be helpful, harmless, and honest. Provide thoughtful and detailed responses when appropriate.`;

    // Add image if provided
    if (image) {
      payload.image = {
        url: image.url,
        type: image.type
      };
    }

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
      
      // Decode the chunk and add to buffer
      buffer += decoder.decode(value, { stream: true });
      
      // Process complete SSE events
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6); // Remove 'data: ' prefix
          
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
        cached: finalData.cached
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
