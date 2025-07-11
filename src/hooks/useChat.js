import { useState, useEffect, useCallback } from 'react';
import { 
  subscribeToChat, 
  addMessage, 
  createChat 
} from '../services/firebase';
import { sendMessageToClaud } from '../services/messageService';

export function useChat(userId) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [currentChatId, setCurrentChatId] = useState(null);

  useEffect(() => {
    if (!userId || !currentChatId) return;

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
      
      // Create chat only on first message
      if (!chatId) {
        chatId = await createChat(userId, { title: 'New Chat' });
        setCurrentChatId(chatId);
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

      // Get Claude's response
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

    } catch (error) {
      console.error('Error sending message:', error);
      throw error;
    }
  }, [userId, currentChatId, messages]);

  return {
    messages,
    sendMessage,
    loading,
    currentChatId
  };
}
