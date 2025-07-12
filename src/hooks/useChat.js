import { useState, useEffect, useCallback, useRef } from 'react';
import { 
  subscribeToChat, 
  addMessage, 
  createChat,
  updateMessage,
  uploadImage
} from '../services/firebase';
import { streamMessageToClaud } from '../services/messageService';

export function useChat(userId, selectedChatId = null) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [currentChatId, setCurrentChatId] = useState(selectedChatId);
  const messagesRef = useRef([]);
  
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
          // Always sort messages by timestamp to ensure correct order
          const sortedMessages = [...newMessages].sort((a, b) => {
            // Handle both Date objects and Firestore timestamps
            const timeA = a.timestamp?.toDate ? a.timestamp.toDate() : new Date(a.timestamp);
            const timeB = b.timestamp?.toDate ? b.timestamp.toDate() : new Date(b.timestamp);
            return timeA - timeB;
          });
          
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

  const sendMessage = useCallback(async (content, image) => {
    if (!userId || (!content.trim() && !image)) return;

    try {
      let chatId = currentChatId;
      let isNewChat = false;
      
      // Use the latest messages from ref to avoid stale closure
      const currentMessages = messagesRef.current;
      
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
        
        chatId = await createChat(userId, { title });
        setCurrentChatId(chatId);
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

      await addMessage(userId, chatId, userMessage);

      // If this is a new chat, return immediately so the UI can navigate
      if (isNewChat) {
        // Stream Claude's response asynchronously (don't wait for it)
        (async () => {
          try {
            // Add placeholder message
            const assistantMessage = {
              role: 'assistant',
              content: '',
              timestamp: new Date(),
              isStreaming: true
            };

            const messageId = await addMessage(userId, chatId, assistantMessage);
            
            let fullContent = '';
            let finalResponse = null;

            // Stream the response - use current messages from ref
            const stream = streamMessageToClaud(currentMessages, content || '', userMessage.image);
            
            for await (const data of stream) {
              if (data.type === 'chunk') {
                fullContent += data.text;
                // Update the message in Firebase with accumulated content
                await updateMessage(userId, chatId, messageId, {
                  content: fullContent,
                  isStreaming: true
                });
              } else if (data.type === 'done') {
                finalResponse = data;
              }
            }

            // Final update with complete message
            const finalUpdate = {
              content: finalResponse?.content || fullContent,
              isStreaming: false,
              timestamp: new Date()
            };

            if (finalResponse?.thinking) {
              finalUpdate.thinking = finalResponse.thinking;
            }

            await updateMessage(userId, chatId, messageId, finalUpdate);
          } catch (error) {
            console.error('Error getting Claude response:', error);
            // Optionally add an error message to the chat
          }
        })();

        // Return immediately for navigation
        return { chatId, isNewChat };
      }

      // For existing chats, stream Claude's response
      // First add a placeholder message
      const assistantMessage = {
        role: 'assistant',
        content: '',
        timestamp: new Date(),
        isStreaming: true
      };

      const messageId = await addMessage(userId, chatId, assistantMessage);
      
      let fullContent = '';
      let finalResponse = null;

      // Stream the response - use current messages from ref
      const stream = streamMessageToClaud(currentMessages, content || '', userMessage.image);
      
      for await (const data of stream) {
        if (data.type === 'chunk') {
          fullContent += data.text;
          // Update the message in Firebase with accumulated content
          await updateMessage(userId, chatId, messageId, {
            content: fullContent,
            isStreaming: true
          });
        } else if (data.type === 'done') {
          finalResponse = data;
        }
      }

      // Final update with complete message
      const finalUpdate = {
        content: finalResponse?.content || fullContent,
        isStreaming: false,
        timestamp: new Date()
      };

      if (finalResponse?.thinking) {
        finalUpdate.thinking = finalResponse.thinking;
      }

      await updateMessage(userId, chatId, messageId, finalUpdate);

      return { chatId, isNewChat };

    } catch (error) {
      console.error('Error sending message:', error);
      throw error;
    }
  }, [userId, currentChatId]);

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
