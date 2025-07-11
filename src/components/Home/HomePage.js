import React, { useState, useEffect } from 'react';
import UserMenu from '../Auth/UserMenu';
import ChatInput from '../Chat/ChatInput';
import ChatSidebar from '../Chat/ChatSidebar';
import { useFirestore } from '../../hooks/useFirestore';
import { useChat } from '../../hooks/useChat';
import './HomePage.css';

function HomePage({ user, onThemeToggle, theme }) {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [error, setError] = useState('');
  const [hasSentMessage, setHasSentMessage] = useState(false);
  const { userChats, selectChat, clearCurrentChat } = useFirestore(user.uid);
  const { sendMessage, currentChatId } = useChat(user.uid, null);

  // Watch for chat creation after sending first message
  useEffect(() => {
    if (hasSentMessage && currentChatId) {
      selectChat({ id: currentChatId, title: 'New Chat' });
      setHasSentMessage(false);
    }
  }, [currentChatId, hasSentMessage, selectChat]);

  const handleSendMessage = async (content, image) => {
    setError('');
    setIsThinking(true);
    
    try {
      // sendMessage will create a new chat if none exists
      await sendMessage(content, image);
      setHasSentMessage(true);
    } catch (err) {
      console.error('Error starting chat:', err);
      setError('Failed to start chat. Please try again.');
    } finally {
      setIsThinking(false);
    }
  };

  const handleSelectChat = (chat) => {
    selectChat(chat);
    setSidebarOpen(false);
  };

  const handleNewChat = () => {
    // Already on home page, just close sidebar
    setSidebarOpen(false);
  };

  return (
    <div className="home-page-wrapper">
      <ChatSidebar
        userChats={userChats}
        currentChatId={null}
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
      />
      
      <div className="home-page">
        <div className="home-controls">
          <button 
            className="theme-toggle"
            onClick={onThemeToggle}
            aria-label="Toggle theme"
          >
            <span className="icon">
              {theme === 'light' ? 'dark_mode' : 'light_mode'}
            </span>
          </button>
          
          <div className="user-menu">
            <img
              src={user.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.displayName || 'User')}&background=0b57d0&color=fff`}
              alt={user.displayName || 'User'}
              className="user-avatar"
              onClick={() => setShowUserMenu(!showUserMenu)}
            />
            {showUserMenu && (
              <UserMenu 
                user={user} 
                onClose={() => setShowUserMenu(false)} 
              />
            )}
          </div>
        </div>

        <div className="home-main-content">
          <span className="icon text-muted" style={{ fontSize: '48px', marginBottom: 'var(--unit-4)' }}>
            chat
          </span>
          <h1 className="home-title">Start a conversation</h1>
          <p className="home-subtitle text-muted">
            Ask me anything! I can help with analysis, writing, coding, and more.
          </p>
        </div>
        
        {error && (
          <div className="error-message home-error">
            <span className="icon">error</span>
            <span>{error}</span>
          </div>
        )}
        
        <div className="home-input-area">
          <ChatInput 
            onSendMessage={handleSendMessage}
            disabled={isThinking}
            placeholder="Message Claude..."
          />
        </div>
      </div>
    </div>
  );
}

export default HomePage;
