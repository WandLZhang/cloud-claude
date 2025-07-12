import React, { useState, useEffect, useRef } from 'react';
import MessageList from './MessageList';
import ChatInput from './ChatInput';
import ChatSidebar from './ChatSidebar';
import HomePage from '../Home/HomePage';
import StarredChats from './StarredChats';
import { useChat } from '../../hooks/useChat';
import { useFirestore } from '../../hooks/useFirestore';
import './ChatInterface.css';

function ChatInterface({ user, onThemeToggle, theme }) {
  const [isThinking, setIsThinking] = useState(false);
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [viewMode, setViewMode] = useState('home'); // 'home', 'chat', 'starred'
  const messagesEndRef = useRef(null);

  const { userChats, currentChat, clearCurrentChat, selectChat, createNewChat } = useFirestore(user.uid);
  const { messages, sendMessage, loading, switchChat } = useChat(user.uid, currentChat?.id);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

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
