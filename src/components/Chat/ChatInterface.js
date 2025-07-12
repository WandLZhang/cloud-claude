import React, { useState, useEffect, useRef } from 'react';
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
  const [isThinking, setIsThinking] = useState(false);
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [viewMode, setViewMode] = useState('home'); // 'home', 'chat', 'starred'
  const messagesEndRef = useRef(null);

  const { userChats, currentChat, clearCurrentChat, selectChat, createNewChat } = useFirestore(user.uid);
  const { messages, sendMessage, loading, switchChat } = useChat(user.uid, currentChat?.id);
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
    
    const timeoutId = setTimeout(() => {
      scrollToBottom(scrollBehavior);
    }, scrollDelay);

    // Update refs
    previousMessagesLength.current = messages.length;
    isStreamingRef.current = isCurrentlyStreaming;

    return () => clearTimeout(timeoutId);
  }, [messages]);

  // Additional scroll trigger specifically for chat switching
  useEffect(() => {
    if (currentChat?.id && messages.length > 0) {
      // Multiple attempts to ensure scrolling works
      // Immediate attempt
      scrollToBottom('auto');
      
      // After next frame
      requestAnimationFrame(() => {
        scrollToBottom('auto');
      });
      
      // After a delay
      const timeoutId = setTimeout(() => {
        scrollToBottom('auto');
      }, 500);
      
      return () => clearTimeout(timeoutId);
    }
  }, [currentChat?.id, messages]);

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
  };

  const handleStarredChatsClick = () => {
    setSidebarOpen(false);
    setViewMode('starred');
  };

  const handleBackFromStarred = () => {
    setViewMode('home');
  };

  const handleSelectChat = (chat) => {
    selectChat(chat);
    switchChat(chat.id);
    setSidebarOpen(false);
    setViewMode('chat');
  };

  const handleStartNewChat = async () => {
    try {
      const chatId = await createNewChat('New Chat');
      const newChat = userChats.find(chat => chat.id === chatId);
      if (newChat) {
        selectChat(newChat);
        switchChat(chatId);
        setViewMode('chat');
      }
    } catch (error) {
      console.error('Error creating new chat:', error);
      setError('Failed to create new chat. Please try again.');
    }
  };

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
      />
      
      {renderContent()}
    </div>
  );
}

export default ChatInterface;
