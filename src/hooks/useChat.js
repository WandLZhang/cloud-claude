import { useState, useEffect, useCallback } from 'react';
import { 
  subscribeToChat, 
  addMessage, 
  createChat 
} from '../services/firebase';
import { sendMessageToClaud } from '../services/messageService';

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

      if (image) {
        userMessage.image = {
          url: image.url,
          type: image.type
        };
      }

      await addMessage(userId, chatId, userMessage);

      // If this is a new chat, return immediately so the UI can navigate
      if (isNewChat) {
        // Get Claude's response asynchronously (don't wait for it)
        sendMessageToClaud(messages, content, image).then(async (response) => {
          // Add Claude's response
          const assistantMessage = {
            role: 'assistant',
            content: response.content,
            timestamp: new Date(),
          };

          if (response.thinking) {
            assistantMessage.thinking = response.thinking;
          }

          await addMessage(userId, chatId, assistantMessage);
        }).catch(error => {
          console.error('Error getting Claude response:', error);
          // Optionally add an error message to the chat
        });

        // Return immediately for navigation
        return { chatId, isNewChat };
      }

      // For existing chats, wait for Claude's response as before
      const response = await sendMessageToClaud(messages, content, image);

      // Add Claude's response
      const assistantMessage = {
        role: 'assistant',
        content: response.content,
        timestamp: new Date(),
      };

      if (response.thinking) {
        assistantMessage.thinking = response.thinking;
      }

      await addMessage(userId, chatId, assistantMessage);

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
