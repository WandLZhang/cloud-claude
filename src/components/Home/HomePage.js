import React, { useState } from 'react';
import UserMenu from '../Auth/UserMenu';
import ChatInput from '../Chat/ChatInput';
import { useChat } from '../../hooks/useChat';
import './HomePage.css';

function HomePage({ user, onThemeToggle, theme, onStartNewChat, userChats, onSelectChat }) {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [error, setError] = useState('');
  const { sendMessage } = useChat(user.uid, null);

  const handleSendMessage = async (content, image) => {
    setError('');
    setIsThinking(true);
    
    try {
      // sendMessage will create a new chat and the parent component will handle the redirect
      await sendMessage(content, image);
    } catch (err) {
      console.error('Error starting chat:', err);
      setError('Failed to start chat. Please try again.');
    } finally {
      setIsThinking(false);
    }
  };

  return (
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

        {/* Recent chats section */}
        {userChats && userChats.length > 0 && (
          <div className="recent-chats-section">
            <h3 className="recent-chats-title">Recent Chats</h3>
            <div className="recent-chats-grid">
              {userChats.slice(0, 6).map((chat) => (
                <button
                  key={chat.id}
                  className="recent-chat-card"
                  onClick={() => onSelectChat(chat)}
                >
                  <h4>{chat.title || 'New Chat'}</h4>
                  <p className="text-muted">
                    {chat.lastMessage || 'No messages yet'}
                  </p>
                </button>
              ))}
            </div>
          </div>
        )}
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
  );
}

export default HomePage;
