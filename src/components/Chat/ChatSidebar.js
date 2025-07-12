import React, { useState, useEffect } from 'react';
import { updateChatTitle, deleteChat, toggleChatStar } from '../../services/firebase';
import { auth } from '../../services/firebase';
import './ChatSidebar.css';

function ChatSidebar({ 
  userChats, 
  currentChatId, 
  onSelectChat, 
  onNewChat,
  isOpen,
  onToggle,
  onStarredChatsClick 
}) {
  const [editingChatId, setEditingChatId] = useState(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [hoveredChatId, setHoveredChatId] = useState(null);
  const [openMenuChatId, setOpenMenuChatId] = useState(null);
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

  const handleEditClick = (e, chat) => {
    e.stopPropagation();
    setEditingChatId(chat.id);
    setEditingTitle(chat.title || 'New Chat');
  };

  const handleSaveEdit = async (e, chatId) => {
    e.stopPropagation();
    if (editingTitle.trim()) {
      try {
        await updateChatTitle(auth.currentUser.uid, chatId, editingTitle.trim());
      } catch (error) {
        console.error('Failed to update chat title:', error);
      }
    }
    setEditingChatId(null);
  };

  const handleCancelEdit = (e) => {
    e.stopPropagation();
    setEditingChatId(null);
    setEditingTitle('');
  };

  const handleDeleteClick = async (e, chatId) => {
    e.stopPropagation();
    if (window.confirm('Are you sure you want to delete this chat?')) {
      try {
        await deleteChat(auth.currentUser.uid, chatId);
        // If we're deleting the current chat, switch to a new chat
        if (currentChatId === chatId) {
          onNewChat();
        }
      } catch (error) {
        console.error('Failed to delete chat:', error);
      }
    }
  };

  const handleStarClick = async (e, chat) => {
    e.stopPropagation();
    try {
      await toggleChatStar(auth.currentUser.uid, chat.id, !chat.isStarred);
      setOpenMenuChatId(null);
    } catch (error) {
      console.error('Failed to star/unstar chat:', error);
    }
  };

  const handleKeyDown = (e, chatId) => {
    if (e.key === 'Enter') {
      handleSaveEdit(e, chatId);
    } else if (e.key === 'Escape') {
      handleCancelEdit(e);
    }
  };

  const handleMenuClick = (e, chatId) => {
    e.stopPropagation();
    setOpenMenuChatId(openMenuChatId === chatId ? null : chatId);
  };

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = () => {
      setOpenMenuChatId(null);
    };

    if (openMenuChatId) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [openMenuChatId]);

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
        {/* Starred Chats Section */}
        <div className="starred-chats-section">
          <button 
            className="starred-chats-button"
            onClick={onStarredChatsClick}
          >
            <span className="icon">star</span>
            <span>Starred Chats</span>
            <span className="icon chevron">chevron_right</span>
          </button>
        </div>
        
        <div className="chat-list">
          {userChats.length === 0 ? (
            <div className="empty-state">
              <p>No previous chats</p>
              <button 
                onClick={onNewChat}
              >
                Start New Chat
              </button>
            </div>
          ) : (
            <>
              {userChats.map((chat) => (
              <button
                key={chat.id}
                className={`chat-item ${currentChatId === chat.id ? 'active' : ''}`}
                onClick={() => onSelectChat(chat)}
                onMouseEnter={() => setHoveredChatId(chat.id)}
                onMouseLeave={() => setHoveredChatId(null)}
              >
                <div className="chat-item-content">
                  {editingChatId === chat.id ? (
                    <input
                      type="text"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onKeyDown={(e) => handleKeyDown(e, chat.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="chat-title-input"
                      autoFocus
                    />
                  ) : (
                    <>
                      <div className="chat-title-row">
                        <h3>{truncateText(chat.title || 'New Chat', 30)}</h3>
                        {chat.isStarred && <span className="icon starred-icon">star</span>}
                      </div>
                      <p className="chat-preview">
                        {truncateText(chat.lastMessage || 'No messages yet')}
                      </p>
                    </>
                  )}
                </div>
                <div className="chat-actions">
                  {editingChatId === chat.id ? (
                    <>
                      <button
                        className="icon-button small"
                        onClick={(e) => handleSaveEdit(e, chat.id)}
                        title="Save"
                      >
                        <span className="icon">check</span>
                      </button>
                      <button
                        className="icon-button small"
                        onClick={handleCancelEdit}
                        title="Cancel"
                      >
                        <span className="icon">close</span>
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="chat-time">
                        {formatDate(chat.updatedAt)}
                      </span>
                      {/* Desktop hover actions */}
                      {hoveredChatId === chat.id && (
                        <div className="chat-hover-actions hide-mobile">
                          <button
                            className="icon-button small"
                            onClick={(e) => handleStarClick(e, chat)}
                            title={chat.isStarred ? "Unstar chat" : "Star chat"}
                          >
                            <span className="icon">{chat.isStarred ? 'star' : 'star_border'}</span>
                          </button>
                          <button
                            className="icon-button small"
                            onClick={(e) => handleEditClick(e, chat)}
                            title="Rename chat"
                          >
                            <span className="icon">edit</span>
                          </button>
                          <button
                            className="icon-button small delete"
                            onClick={(e) => handleDeleteClick(e, chat.id)}
                            title="Delete chat"
                          >
                            <span className="icon">delete</span>
                          </button>
                        </div>
                      )}
                      
                      {/* Mobile menu button */}
                      <div className="chat-menu-wrapper show-mobile">
                        <button
                          className="icon-button small"
                          onClick={(e) => handleMenuClick(e, chat.id)}
                          title="More options"
                        >
                          <span className="icon">more_vert</span>
                        </button>
                        
                        {/* Dropdown menu */}
                        {openMenuChatId === chat.id && (
                          <div className="chat-menu-dropdown">
                            <button
                              className="menu-item"
                              onClick={(e) => handleStarClick(e, chat)}
                            >
                              <span className="icon">{chat.isStarred ? 'star' : 'star_border'}</span>
                              <span>{chat.isStarred ? 'Unstar' : 'Star'}</span>
                            </button>
                            <button
                              className="menu-item"
                              onClick={(e) => {
                                handleEditClick(e, chat);
                                setOpenMenuChatId(null);
                              }}
                            >
                              <span className="icon">edit</span>
                              <span>Rename</span>
                            </button>
                            <button
                              className="menu-item delete"
                              onClick={(e) => {
                                handleDeleteClick(e, chat.id);
                                setOpenMenuChatId(null);
                              }}
                            >
                              <span className="icon">delete</span>
                              <span>Delete</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </button>
            ))}
            </>
          )}
        </div>
        {userChats.length > 0 && (
          <div className="sidebar-bottom">
            <button 
              onClick={onNewChat}
            >
              Start New Chat
            </button>
          </div>
        )}
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
