import { useState, useEffect, useCallback } from 'react';
import { 
  getUserChats, 
  createChat,
  subscribeToUserChats 
} from '../services/firebase';

export function useFirestore(userId) {
  const [userChats, setUserChats] = useState([]);
  const [currentChat, setCurrentChat] = useState(null);
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

  const selectChat = useCallback((chat) => {
    setCurrentChat(chat);
  }, []);

  return {
    userChats,
    currentChat,
    createNewChat,
    selectChat,
    loading
  };
}
