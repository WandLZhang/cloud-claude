import { useState, useEffect, useCallback } from 'react';
import {
  createChat,
  subscribeToUserChats
} from '../services/firebase';

// The user's chat list. Which chat is open comes from the URL (ChatInterface), not from here.
export function useFirestore(userId) {
  const [userChats, setUserChats] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) return;

    // Subscribe to user's chats
    const unsubscribe = subscribeToUserChats(userId, (chats) => {
      setUserChats(chats);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [userId]);

  const createNewChat = useCallback(async (title = 'New Chat') => {
    if (!userId) return;

    try {
      const chatId = await createChat(userId, { title });
      // The subscription will automatically update userChats
      return chatId;
    } catch (error) {
      console.error('Error creating chat:', error);
      throw error;
    }
  }, [userId]);

  return {
    userChats,
    createNewChat,
    loading
  };
}
