import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import MessageList from './MessageList';
import ChatInput from './ChatInput';
import ChatSidebar from './ChatSidebar';
import HomePage from '../Home/HomePage';
import StarredChats from './StarredChats';
import { useChat } from '../../hooks/useChat';
import { useFirestore } from '../../hooks/useFirestore';
import { updateMessage, deleteMessage } from '../../services/firebase';
import './ChatInterface.css';

function ChatInterface({ user, onThemeToggle, theme }) {
  const { chatId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [isThinking, setIsThinking] = useState(false);
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [viewMode, setViewMode] = useState('home'); // 'home', 'chat', 'starred'
  const [targetMessageId, setTargetMessageId] = useState(null);
  const [scrollTrigger, setScrollTrigger] = useState(0);
  const messagesEndRef = useRef(null);

  const { userChats, currentChat, clearCurrentChat, selectChat, createNewChat } = useFirestore(user.uid);
  
  // Extract chat config from currentChat (e.g., disableThinking for "Everyday Chinese" chats)
  // Use useMemo to prevent creating new object reference on every render (avoids infinite loop)
  const currentChatConfig = useMemo(() => {
    return currentChat?.disableThinking ? { disableThinking: true } : {};
  }, [currentChat?.disableThinking]);
  
  const { messages, sendMessage, loading, switchChat } = useChat(user.uid, currentChat?.id, currentChatConfig);
  const previousMessagesLength = useRef(0);
  const isStreamingRef = useRef(false);

  const scrollToBottom = (behavior = 'smooth') => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior, block: 'end' });
    }
    // Also try scrolling the container directly as a fallback
    const container = document.querySelector('.messages-container');
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  };

  // Scroll when messages change
  useEffect(() => {
    if (messages.length === 0) return;
    
    // Don't scroll to bottom if we have a target message
    if (targetMessageId) {
      console.log('[ChatInterface] Skipping scroll to bottom - targetMessageId is set:', targetMessageId);
      return;
    }

    // Check if we're streaming (last message has isStreaming flag)
    const lastMessage = messages[messages.length - 1];
    const isCurrentlyStreaming = lastMessage?.isStreaming === true;
    
    // Determine if this is initial load or new messages
    const isInitialLoad = previousMessagesLength.current === 0 && messages.length > 0;
    const hasNewMessages = messages.length > previousMessagesLength.current;
    
    // Use instant scroll for streaming, smooth for other cases
    const scrollBehavior = isCurrentlyStreaming ? 'auto' : 'smooth';
    
    // Increase delay for initial load to ensure proper rendering
    const scrollDelay = isInitialLoad ? 300 : 0;
    
    console.log('[ChatInterface] Scheduling scroll to bottom - delay:', scrollDelay, 'streaming:', isCurrentlyStreaming);
    
    const timeoutId = setTimeout(() => {
      console.log('[ChatInterface] Executing scrollToBottom from messages effect');
      scrollToBottom(scrollBehavior);
    }, scrollDelay);

    // Update refs
    previousMessagesLength.current = messages.length;
    isStreamingRef.current = isCurrentlyStreaming;

    return () => clearTimeout(timeoutId);
  }, [messages, targetMessageId]);

  // Additional scroll trigger specifically for chat switching
  useEffect(() => {
    if (currentChat?.id && messages.length > 0 && !targetMessageId) {
      console.log('[ChatInterface] Chat switch scroll triggered - chatId:', currentChat.id);
      
      // Multiple attempts to ensure scrolling works
      // Immediate attempt
      console.log('[ChatInterface] Immediate scrollToBottom on chat switch');
      scrollToBottom('auto');
      
      // After next frame
      requestAnimationFrame(() => {
        console.log('[ChatInterface] RequestAnimationFrame scrollToBottom');
        scrollToBottom('auto');
      });
      
      // After a delay
      const timeoutId = setTimeout(() => {
        console.log('[ChatInterface] 500ms timeout scrollToBottom');
        scrollToBottom('auto');
      }, 500);
      
      return () => clearTimeout(timeoutId);
    } else if (targetMessageId) {
      console.log('[ChatInterface] Skipping chat switch scroll - targetMessageId is set:', targetMessageId);
    }
  }, [currentChat?.id, messages, targetMessageId]);

  // Reset message count when chat changes
  useEffect(() => {
    previousMessagesLength.current = 0;
  }, [currentChat?.id]);

  const handleSendMessage = async (content, image) => {
    setError('');
    setIsThinking(true);
    
    try {
      await sendMessage(content, image);
    } catch (err) {
      console.error('Error sending message:', err);
      setError('Failed to send message. Please try again.');
    } finally {
      setIsThinking(false);
    }
  };

  const handleNewChat = () => {
    // Clear current chat to go back to home page
    clearCurrentChat();
    setSidebarOpen(false);
    setViewMode('home');
    navigate('/');
  };

  const handleStarredChatsClick = () => {
    setSidebarOpen(false);
    setViewMode('starred');
    navigate('/starred');
  };

  const handleBackFromStarred = () => {
    setViewMode('home');
    navigate('/');
  };

  const handleSelectChat = (chat) => {
    selectChat(chat);
    switchChat(chat.id);
    setSidebarOpen(false);
    setViewMode('chat');
    setTargetMessageId(null);
    navigate(`/chat/${chat.id}`);
  };

  const handleStartNewChat = async () => {
    try {
      const chatId = await createNewChat('New Chat');
      const newChat = userChats.find(chat => chat.id === chatId);
      if (newChat) {
        selectChat(newChat);
        switchChat(chatId);
        setViewMode('chat');
        navigate(`/chat/${chatId}`);
      }
    } catch (error) {
      console.error('Error creating new chat:', error);
      setError('Failed to create new chat. Please try again.');
    }
  };

  const handleSelectSearchResult = async (result) => {
    console.log('[ChatInterface] handleSelectSearchResult called - messageId:', result.messageId);
    
    // First, select the chat
    const chat = userChats.find(c => c.id === result.chatId);
    if (chat) {
      // Store the target message ID
      const targetId = result.messageId;
      
      // If we're already on this chat, just set the targetMessageId
      if (currentChat?.id === result.chatId) {
        console.log('[ChatInterface] Already on chat, setting targetMessageId:', targetId);
        // Set the target and trigger a new scroll
        setTargetMessageId(targetId);
        setScrollTrigger(Date.now()); // Force re-trigger
        setSidebarOpen(false);
      } else {
        // Otherwise, switch to the chat
        console.log('[ChatInterface] Switching to different chat:', result.chatId);
        selectChat(chat);
        await switchChat(result.chatId);
        setSidebarOpen(false);
        setViewMode('chat');
        
        // Set targetMessageId after a delay to ensure messages are loaded
        console.log('[ChatInterface] Scheduling targetMessageId set after 1000ms');
        setTimeout(() => {
          console.log('[ChatInterface] Setting targetMessageId after delay:', targetId);
          setTargetMessageId(targetId);
          setScrollTrigger(Date.now());
        }, 1000);
        
        navigate(`/chat/${result.chatId}`);
      }
    }
  };

  // Load chat from URL parameter on mount or when chatId changes
  useEffect(() => {
    if (chatId && userChats.length > 0) {
      const chat = userChats.find(c => c.id === chatId);
      if (chat && (!currentChat || currentChat.id !== chatId)) {
        selectChat(chat);
        switchChat(chatId);
        setViewMode('chat');
        
        // Check if we have a targetMessageId in navigation state
        if (location.state?.targetMessageId) {
          setTargetMessageId(location.state.targetMessageId);
        }
      } else if (!chat) {
        // Chat not found, redirect to home
        navigate('/');
      }
    } else if (location.pathname === '/starred') {
      setViewMode('starred');
    } else if (!chatId) {
      setViewMode('home');
    }
  }, [chatId, userChats, location.pathname, location.state]);

  // Update viewMode when currentChat changes
  useEffect(() => {
    if (currentChat) {
      setViewMode('chat');
    }
  }, [currentChat]);

  // Render content based on view mode
  const renderContent = () => {
    switch (viewMode) {
      case 'starred':
        return (
          <StarredChats
            onSelectChat={handleSelectChat}
            onBack={handleBackFromStarred}
          />
        );
      case 'chat':
        if (!currentChat) {
          // If viewMode is 'chat' but no chat selected, go to home
          setViewMode('home');
          return null;
        }
        return (
          <div className="chat-container">
            <MessageList 
              messages={messages} 
              isThinking={isThinking}
              loading={loading}
              onUpdateMessage={updateMessage}
              onDeleteMessage={deleteMessage}
              userId={user.uid}
              chatId={currentChat.id}
              targetMessageId={targetMessageId}
              scrollTrigger={scrollTrigger}
              onScrollComplete={() => setTargetMessageId(null)}
            />
            <div ref={messagesEndRef} />
            
            {error && (
              <div className="error-message mx-4 mb-2">
                <span className="icon">error</span>
                <span>{error}</span>
              </div>
            )}
            
            <ChatInput 
              onSendMessage={handleSendMessage}
              disabled={loading || isThinking}
            />
          </div>
        );
      case 'home':
      default:
        return (
          <HomePage 
            user={user} 
            onThemeToggle={onThemeToggle} 
            theme={theme}
            onStartNewChat={handleStartNewChat}
            userChats={userChats}
            onSelectChat={handleSelectChat}
          />
        );
    }
  };

  return (
    <div className="chat-interface-wrapper">
      <ChatSidebar
        userChats={userChats}
        currentChatId={currentChat?.id}
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        onStarredChatsClick={handleStarredChatsClick}
        onSelectSearchResult={handleSelectSearchResult}
      />
      
      {renderContent()}
    </div>
  );
}

export default ChatInterface;
