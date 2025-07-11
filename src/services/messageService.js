import axios from 'axios';

const CLOUD_FUNCTION_URL = process.env.REACT_APP_CLOUD_FUNCTION_URL;

export async function sendMessageToClaud(previousMessages, newContent, image) {
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
      // Extract base64 data from data URL
      const base64Data = image.url.split(',')[1];
      payload.image = {
        data: base64Data,
        media_type: image.type
      };
    }

    // Call the Cloud Function
    const response = await axios.post(CLOUD_FUNCTION_URL, payload, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (response.data.error) {
      throw new Error(response.data.error);
    }

    return {
      content: response.data.content,
      thinking: response.data.thinking,
      usage: response.data.usage,
      cached: response.data.cached
    };

  } catch (error) {
    console.error('Error calling Claude API:', error);
    throw new Error(error.response?.data?.error || error.message || 'Failed to get response from Claude');
  }
}

// Simulate streaming for better UX (optional enhancement)
export async function* streamMessageToClaud(previousMessages, newContent, image) {
  try {
    const response = await sendMessageToClaud(previousMessages, newContent, image);
    
    // Simulate streaming by yielding chunks
    const chunks = response.chunks || [];
    
    if (chunks.length > 0) {
      // If we have chunks from the backend, use them
      for (const chunk of chunks) {
        yield chunk.text;
        await new Promise(resolve => setTimeout(resolve, 10)); // Small delay for effect
      }
    } else {
      // Otherwise, simulate chunking the full response
      const words = response.content.split(' ');
      let currentChunk = '';
      
      for (let i = 0; i < words.length; i++) {
        currentChunk += words[i] + ' ';
        
        // Yield chunks of ~5 words
        if (i % 5 === 0 || i === words.length - 1) {
          yield currentChunk;
          currentChunk = '';
          await new Promise(resolve => setTimeout(resolve, 30));
        }
      }
    }
    
    return response;
  } catch (error) {
    throw error;
  }
}
