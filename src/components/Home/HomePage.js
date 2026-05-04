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
  const [selectedPrompt, setSelectedPrompt] = useState(null);
  const { sendMessage } = useChat(user.uid, null);

  // Determine if thinking should be disabled based on prompt title
  const shouldDisableThinking = selectedPrompt?.title?.toLowerCase().includes('everyday chinese');

  const handleSendMessage = async (content, image, extraOptions = {}) => {
    setError('');
    setIsThinking(true);

    try {
      // Build chat config based on selected prompt
      const chatConfig = {};
      if (shouldDisableThinking || selectedPrompt?.disableThinking) {
        chatConfig.disableThinking = true;
      }
      if (selectedPrompt?.useFastModel) {
        chatConfig.useFastModel = true;
      }
      if (selectedPrompt?.enableWebSearch) {
        chatConfig.enableWebSearch = true;
      }
      if (selectedPrompt?.systemPrompt) {
        chatConfig.systemPrompt = selectedPrompt.systemPrompt;
      }
      // Merge extra options from ChatInput (web search, document, etc.)
      Object.assign(chatConfig, extraOptions);

      // sendMessage will create a new chat and return the chat ID
      const result = await sendMessage(content, image, chatConfig);

      if (result && result.chatId && result.isNewChat) {
        // Immediately navigate to the new chat with a temporary chat object
        const tempChat = {
          id: result.chatId,
          title: content.trim().length > 40
            ? content.trim().substring(0, 40) + '...'
            : content.trim(),
          createdAt: new Date(),
          lastMessage: content,
          lastMessageAt: new Date(),
          ...(chatConfig.enableWebSearch && { enableWebSearch: true }),
          ...(chatConfig.disableThinking && { disableThinking: true }),
          ...(chatConfig.useFastModel && { useFastModel: true }),
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

  const handleBatchRelease = async (items) => {
    if (!items || items.length === 0) return;
    const [firstItem, ...remaining] = items;

    // Stash remaining items so ChatInterface picks them up after the chat exists.
    // The first item creates the chat (and navigates); the rest get released in
    // the chat view once the first response has settled.
    if (remaining.length > 0) {
      try {
        sessionStorage.setItem(`pendingBatch-${user.uid}`, JSON.stringify(remaining.map(item => ({
          content: item.content,
          // Image needs to be re-uploaded from a fresh File reference, but
          // sessionStorage can't hold File objects. We store the data URL and
          // type so ChatInterface can reconstruct a File before sending.
          image: item.image ? { url: item.image.url, type: item.image.type, name: item.image.file?.name } : null,
          extraOptions: item.extraOptions || {},
        }))));
      } catch (e) {
        console.error('Failed to stash batch items:', e);
        setError('Could not queue all batch items.');
      }
    }

    await handleSendMessage(firstItem.content, firstItem.image, firstItem.extraOptions);
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
          onSelectPromptFull={setSelectedPrompt}
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
          onBatchRelease={handleBatchRelease}
          disabled={isThinking}
          placeholder="Message Claude..."
          value={selectedPromptContent}
          defaultWebSearch={!!selectedPrompt?.enableWebSearch}
        />
      </div>
    </div>
  );
}

export default HomePage;
