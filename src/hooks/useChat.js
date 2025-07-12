import { useState, useEffect, useCallback } from 'react';
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

  useEffect(() => {
    // Update currentChatId when selectedChatId changes
    setCurrentChatId(selectedChatId);
  }, [selectedChatId]);

  useEffect(() => {
    if (!userId || !currentChatId) {
      setMessages([]);
      return;
    }

    // Subscribe to messages only if we have a chat ID
    setLoading(true);
    const unsubscribe = subscribeToChat(userId, currentChatId, (messages) => {
      setMessages(messages);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [userId, currentChatId]);

  const sendMessage = useCallback(async (content, image) => {
    if (!userId || !content.trim()) return;

    try {
      let chatId = currentChatId;
      let isNewChat = false;
      
      // Create chat only on first message
      if (!chatId) {
        // Generate title from first message
        const cleanContent = content.trim().replace(/\n+/g, ' ');
        const title = cleanContent.length > 40 
          ? cleanContent.substring(0, 40) + '...' 
          : cleanContent;
        
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

            // Stream the response
            const stream = streamMessageToClaud(messages, content, userMessage.image);
            
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

      // Stream the response
      const stream = streamMessageToClaud(messages, content, userMessage.image);
      
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
  }, [userId, currentChatId, messages]);

  const switchChat = useCallback((chatId) => {
    setCurrentChatId(chatId);
    setMessages([]);
  }, []);

  return {
    messages,
    sendMessage,
    loading,
    currentChatId,
    switchChat
  };
}
