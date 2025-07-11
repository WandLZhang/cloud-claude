import React from 'react';
import './ChatSidebar.css';

function ChatSidebar({ 
  userChats, 
  currentChatId, 
  onSelectChat, 
  onNewChat,
  isOpen,
  onToggle 
}) {
  const formatDate = (timestamp) => {
    if (!timestamp) return '';
    
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date();
    const diffInMs = now - date;
    const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));
    
    if (diffInDays === 0) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffInDays === 1) {
      return 'Yesterday';
    } else if (diffInDays < 7) {
      return date.toLocaleDateString([], { weekday: 'short' });
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  };

  const truncateText = (text, maxLength = 50) => {
    if (!text) return 'New Chat';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  };

  return (
    <>
      {/* Sidebar toggle button - always visible */}
      <button 
        className="sidebar-toggle"
        onClick={onToggle}
        aria-label="Toggle sidebar"
      >
        <span className="icon">menu</span>
      </button>

      {/* Sidebar */}
      <div className={`chat-sidebar ${isOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <h2>Chats</h2>
          <button 
            className="icon-button"
            onClick={onNewChat}
            title="New Chat"
          >
            <span className="icon">add</span>
          </button>
        </div>

        <div className="chat-list">
          {userChats.length === 0 ? (
            <div className="empty-state">
              <p>No previous chats</p>
              <button 
                className="button button-primary"
                onClick={onNewChat}
              >
                Start New Chat
              </button>
            </div>
          ) : (
            userChats.map((chat) => (
              <button
                key={chat.id}
                className={`chat-item ${currentChatId === chat.id ? 'active' : ''}`}
                onClick={() => onSelectChat(chat)}
              >
                <div className="chat-item-content">
                  <h3>{truncateText(chat.title || 'New Chat', 30)}</h3>
                  <p className="chat-preview">
                    {truncateText(chat.lastMessage || 'No messages yet')}
                  </p>
                </div>
                <span className="chat-time">
                  {formatDate(chat.updatedAt)}
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Mobile overlay */}
      {isOpen && (
        <div 
          className="sidebar-overlay show-mobile"
          onClick={onToggle}
        />
      )}
    </>
  );
}

export default ChatSidebar;
