import React, { useState } from 'react';
import UserMenu from '../Auth/UserMenu';
import ChatInput from '../Chat/ChatInput';
import SavedPrompts from './SavedPrompts';
import { useChat } from '../../hooks/useChat';
import './HomePage.css';

function HomePage({ user, onThemeToggle, theme, onStartNewChat, userChats, onSelectChat }) {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [error, setError] = useState('');
  const [selectedPromptContent, setSelectedPromptContent] = useState('');
  const { sendMessage } = useChat(user.uid, null);

  const handleSendMessage = async (content, image) => {
    setError('');
    setIsThinking(true);
    
    try {
      // sendMessage will create a new chat and return the chat ID
      const result = await sendMessage(content, image);
      
      if (result && result.chatId && result.isNewChat) {
        // Immediately navigate to the new chat with a temporary chat object
        const tempChat = {
          id: result.chatId,
          title: content.trim().length > 40 
            ? content.trim().substring(0, 40) + '...' 
            : content.trim(),
          createdAt: new Date(),
          lastMessage: content,
          lastMessageAt: new Date()
        };
        
        // Navigate immediately
        onSelectChat(tempChat);
      }
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
        <span className="icon text-muted" style={{ fontSize: '36px', marginBottom: 'var(--unit-3)' }}>
          chat
        </span>
        <h1 className="home-title">Start a conversation</h1>
        <p className="home-subtitle text-muted">
          Ask me anything! I can help with analysis, writing, coding, and more.
        </p>

        {/* Saved prompts section */}
        <SavedPrompts 
          userId={user.uid} 
          onSelectPrompt={setSelectedPromptContent}
        />

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
          value={selectedPromptContent}
        />
      </div>
    </div>
  );
}

export default HomePage;
