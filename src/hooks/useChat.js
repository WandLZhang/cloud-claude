import { useState, useEffect, useCallback, useRef } from 'react';
import { 
  subscribeToChat, 
  addMessage, 
  createChat,
  updateMessage,
  uploadImage
} from '../services/firebase';
import { streamMessageToClaud } from '../services/messageService';

// Mid-stream Firestore writes are throttled to this interval. Every chunk used to be written
// immediately, which is far past what a single document sustains.
const CHUNK_WRITE_MS = 700;

/**
 * Put every assistant reply directly under the user message it answers.
 *
 * Timestamp order alone is not enough. Before commit f0eb3d4 the final update overwrote the
 * assistant's timestamp with its COMPLETION time, so shooting the next book page before the
 * previous translation finished left the reply sorted after the next photo — which is why the
 * starred story chats read out of order and the text under a picture is not the text in it.
 * Assistant messages now carry `replyTo`; anchor on that and the display order is correct no
 * matter what the timestamps say. Messages without `replyTo` (older chats) keep their timestamp
 * position, so nothing regresses.
 */
function anchorReplies(sorted) {
  const userIds = new Set(sorted.filter((m) => m.role === 'user').map((m) => m.id));
  const childrenOf = new Map();
  for (const m of sorted) {
    if (m.replyTo && userIds.has(m.replyTo)) {
      if (!childrenOf.has(m.replyTo)) childrenOf.set(m.replyTo, []);
      childrenOf.get(m.replyTo).push(m);
    }
  }
  if (childrenOf.size === 0) return sorted;

  const anchored = [];
  for (const m of sorted) {
    if (m.replyTo && userIds.has(m.replyTo)) continue;   // emitted under its parent instead
    anchored.push(m);
    const kids = childrenOf.get(m.id);
    if (kids) anchored.push(...kids);
  }
  return anchored;
}

export function useChat(userId, selectedChatId = null, selectedChatConfig = {}) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [currentChatId, setCurrentChatId] = useState(selectedChatId);
  const [chatConfig, setChatConfig] = useState(selectedChatConfig); // Store chat-level config (e.g., disableThinking)
  const messagesRef = useRef([]);
  const chatConfigRef = useRef(selectedChatConfig);
  
  // Keep chatConfigRef in sync with chatConfig state
  useEffect(() => {
    chatConfigRef.current = chatConfig;
  }, [chatConfig]);
  
  // Update chatConfig when selectedChatConfig changes (e.g., when switching to existing chat)
  useEffect(() => {
    if (selectedChatConfig && Object.keys(selectedChatConfig).length > 0) {
      console.log('[useChat] Updating chatConfig from selectedChatConfig:', selectedChatConfig);
      setChatConfig(selectedChatConfig);
    }
  }, [selectedChatConfig]);
  
  // Keep messagesRef in sync with messages state
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    // Update currentChatId when selectedChatId changes
    setCurrentChatId(selectedChatId);
  }, [selectedChatId]);

  useEffect(() => {
    if (!userId || !currentChatId) {
      setMessages([]);
      setLoading(false);
      return;
    }

    // Clear messages and set loading state when switching chats
    setMessages([]);
    setLoading(true);
    
    let unsubscribe = null;
    let updateTimeoutId = null;
    
    // Add a small delay to ensure proper cleanup
    const timeoutId = setTimeout(() => {
      // Subscribe to messages only if we have a chat ID
      unsubscribe = subscribeToChat(userId, currentChatId, (newMessages) => {
        // Clear any pending update
        if (updateTimeoutId) {
          clearTimeout(updateTimeoutId);
        }
        
        // Debounce rapid updates to prevent rendering issues
        updateTimeoutId = setTimeout(() => {
          // Sort by timestamp, then pull every reply under the message it answers.
          const byTime = [...newMessages].sort((a, b) => {
            // Handle both Date objects and Firestore timestamps
            const timeA = a.timestamp?.toDate ? a.timestamp.toDate() : new Date(a.timestamp);
            const timeB = b.timestamp?.toDate ? b.timestamp.toDate() : new Date(b.timestamp);
            return timeA - timeB;
          });
          const sortedMessages = anchorReplies(byTime);

          // Check if any message just finished streaming
          const wasStreaming = messagesRef.current.some(msg => msg.isStreaming);
          const nowNotStreaming = !sortedMessages.some(msg => msg.isStreaming);
          
          if (wasStreaming && nowNotStreaming) {
            // Force a final sort when streaming completes
            console.log('Streaming completed, locking message order');
          }
          
          setMessages(sortedMessages);
          setLoading(false);
        }, 50); // Increased debounce for mobile stability
      });
    }, 50);

    return () => {
      clearTimeout(timeoutId);
      if (updateTimeoutId) {
        clearTimeout(updateTimeoutId);
      }
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [userId, currentChatId]);

  /**
   * Create the assistant placeholder, stream into it, and finalise it.
   *
   * One implementation for both the new-chat and existing-chat paths — they used to be copy-pasted,
   * which is how the timestamp-overwrite bug survived in one branch after being fixed in the other.
   *
   * `replyTo` binds the reply to the user message it answers, so display order no longer depends on
   * the timestamps lining up. The placeholder's timestamp is never overwritten.
   */
  const streamAssistantTurn = useCallback(async ({
    chatId, userMessageId, history, content, image, config,
  }) => {
    const messageId = await addMessage(userId, chatId, {
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      isStreaming: true,
      replyTo: userMessageId,
    });

    let fullContent = '';
    let finalResponse = null;
    let lastWrite = 0;

    const stream = streamMessageToClaud(history, content || '', image, config);

    for await (const data of stream) {
      if (data.type === 'chunk') {
        fullContent += data.text;
        // Throttled: the reader only needs to see the text growing, not every token.
        if (Date.now() - lastWrite >= CHUNK_WRITE_MS) {
          lastWrite = Date.now();
          await updateMessage(userId, chatId, messageId,
            { content: fullContent, isStreaming: true }, { touchChat: false });
        }
      } else if (data.type === 'retry') {
        lastWrite = Date.now();
        await updateMessage(userId, chatId, messageId,
          { content: fullContent, isStreaming: true, retryStatus: data.reason }, { touchChat: false });
      } else if (data.type === 'done') {
        finalResponse = data;
      }
    }

    // Final update — keep the placeholder's original timestamp; only this write touches the
    // parent chat doc's lastMessage/updatedAt.
    const finalUpdate = {
      content: finalResponse?.content || fullContent,
      isStreaming: false,
      retryStatus: null,
    };
    if (finalResponse?.thinking) finalUpdate.thinking = finalResponse.thinking;
    if (finalResponse?.citations) finalUpdate.citations = finalResponse.citations;
    if (finalResponse?.model) finalUpdate.model = finalResponse.model;

    await updateMessage(userId, chatId, messageId, finalUpdate);
    return messageId;
  }, [userId]);

  const sendMessage = useCallback(async (content, image, newChatConfig = {}) => {
    if (!userId || (!content.trim() && !image && !newChatConfig.document)) return;

    try {
      let chatId = currentChatId;
      let isNewChat = false;
      
      // Use the latest messages from ref to avoid stale closure
      const currentMessages = messagesRef.current;
      
      // Merge stored config with new config (new values override stored ones)
      const effectiveConfig = { ...chatConfigRef.current, ...newChatConfig };
      
      // Create chat only on first message
      if (!chatId) {
        // Generate title from first message
        let title = 'New Chat';
        if (content && content.trim()) {
          const cleanContent = content.trim().replace(/\n+/g, ' ');
          title = cleanContent.length > 40 
            ? cleanContent.substring(0, 40) + '...' 
            : cleanContent;
        } else if (image) {
          title = 'Image Chat';
        }
        
        // Include config in chat document for persistence across reloads
        const chatData = { title };
        if (newChatConfig.disableThinking) chatData.disableThinking = true;
        if (newChatConfig.useFastModel) chatData.useFastModel = true;
        if (newChatConfig.enableWebSearch) chatData.enableWebSearch = true;
        if (newChatConfig.systemPrompt) chatData.systemPrompt = newChatConfig.systemPrompt;
        
        chatId = await createChat(userId, chatData);
        setCurrentChatId(chatId);
        setChatConfig(newChatConfig); // Store config for subsequent messages
        isNewChat = true;
      }

      // Add user message
      const userMessage = {
        role: 'user',
        content,
        timestamp: new Date(),
      };

      // Upload image if present
      if (image && image.file) {
        try {
          const uploadedImage = await uploadImage(userId, image.file);
          userMessage.image = uploadedImage;
        } catch (error) {
          console.error('Error uploading image:', error);
          throw new Error('Failed to upload image. Please try again.');
        }
      }

      // Upload document (PDF) if present
      if (newChatConfig.document && newChatConfig.document.file) {
        try {
          const uploadedDoc = await uploadImage(userId, newChatConfig.document.file);
          userMessage.document = uploadedDoc;
          // Add document to the effective config for the API call
          effectiveConfig.document = uploadedDoc;
        } catch (error) {
          console.error('Error uploading document:', error);
          throw new Error('Failed to upload document. Please try again.');
        }
      }

      // Pass web search flag through config
      if (newChatConfig.enableWebSearch) {
        effectiveConfig.enableWebSearch = true;
      }

      const userMessageId = await addMessage(userId, chatId, userMessage);

      const turn = {
        chatId,
        userMessageId,
        history: currentMessages,
        content,
        image: userMessage.image,
        config: effectiveConfig,
      };

      // If this is a new chat, return immediately so the UI can navigate
      if (isNewChat) {
        // Stream Claude's response asynchronously (don't wait for it)
        streamAssistantTurn(turn).catch((error) => {
          console.error('Error getting Claude response:', error);
        });
        return { chatId, isNewChat };
      }

      await streamAssistantTurn(turn);
      return { chatId, isNewChat };

    } catch (error) {
      console.error('Error sending message:', error);
      throw error;
    }
  }, [userId, currentChatId, streamAssistantTurn]);

  const switchChat = useCallback((chatId) => {
    if (chatId !== currentChatId) {
      setMessages([]);
      setLoading(true);
      setCurrentChatId(chatId);
    }
  }, [currentChatId]);

  return {
    messages,
    sendMessage,
    loading,
    currentChatId,
    switchChat
  };
}
