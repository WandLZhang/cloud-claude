import React, { useState, useEffect, useRef } from 'react';
import { updateChatTitle, deleteChat, toggleChatStar } from '../../services/firebase';
import { auth } from '../../services/firebase';
import SearchResults from './SearchResults';
import StarIcon from '../Common/StarIcon';
import { relativeTime } from './format';
import './ChatSidebar.css';

function ChatSidebar({ 
  userChats, 
  currentChatId, 
  onSelectChat, 
  onNewChat,
  loading,
  isOpen,
  onToggle,
  onOpen,
  onStarredChatsClick,
  onSelectSearchResult 
}) {
  const [editingChatId, setEditingChatId] = useState(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [hoveredChatId, setHoveredChatId] = useState(null);
  const [openMenuChatId, setOpenMenuChatId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearchResults, setShowSearchResults] = useState(false);
  const searchRef = useRef(null);
  const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac');

  // Ctrl+K (Cmd+K on a Mac) jumps to search from anywhere; on a phone it opens the sidebar first.
  useEffect(() => {
    const handleShortcut = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (onOpen) onOpen();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [onOpen]);

  const stripHtml = (text) => {
    if (!text || !text.includes('<')) return text || '';
    const doc = new DOMParser().parseFromString(text, 'text/html');
    return doc.body.textContent || '';
  };

  const truncateText = (text, maxLength = 50) => {
    if (!text) return 'New Chat';
    const clean = stripHtml(text);
    return clean.length > maxLength ? clean.substring(0, maxLength) + '...' : clean;
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

  const handleSearchChange = (e) => {
    const query = e.target.value;
    setSearchQuery(query);
    setShowSearchResults(query.trim().length > 0);
  };

  const handleClearSearch = () => {
    setSearchQuery('');
    setShowSearchResults(false);
  };

  const handleSearchResultClick = (result) => {
    // Don't clear search query or hide results
    // Just close the sidebar
    onSelectSearchResult(result);
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
      {/* Sidebar; on a phone the header's menu button opens it */}
      <div className={`chat-sidebar ${isOpen ? 'open' : ''}`}>
        {/* Search, Starred and New chat in one row */}
        <div className="sidebar-top">
          <div className="search-input-wrapper">
            <span className="icon search-icon">search</span>
            <input
              ref={searchRef}
              type="text"
              placeholder="Search chats and messages..."
              value={searchQuery}
              onChange={handleSearchChange}
              className="search-input"
            />
            {searchQuery ? (
              <button 
                className="clear-search-button"
                onClick={handleClearSearch}
                aria-label="Clear search"
              >
                <span className="icon">close</span>
              </button>
            ) : (
              <kbd className="search-kbd hide-mobile">{isMac ? '\u2318K' : 'Ctrl K'}</kbd>
            )}
          </div>
          <button
            className="icon-button small"
            onClick={() => {
              handleClearSearch();
              onStarredChatsClick();
            }}
            aria-label="Starred chats"
            title="Starred chats"
          >
            <span className="icon">star</span>
          </button>
          <button
            className="icon-button small"
            onClick={() => {
              handleClearSearch();
              onNewChat();
            }}
            aria-label="New chat"
            title="New chat"
          >
            <span className="icon">add</span>
          </button>
        </div>

        {/* Search Results */}
        {showSearchResults && (
          <SearchResults
            searchQuery={searchQuery}
            userId={auth.currentUser.uid}
            onSelectResult={handleSearchResultClick}
          />
        )}

        {/* Regular Chat List */}
        {!showSearchResults && (
          <>
            <div className="chat-list">
              {userChats.length === 0 ? (loading ? null : (
                <div className="empty-state">
                  <p>No previous chats</p>
                  <button 
                    onClick={() => {
                      handleClearSearch();
                      onNewChat();
                    }}
                  >
                    Start New Chat
                  </button>
                </div>
              )) : (
                <>
                  {userChats.map((chat) => (
                  <div
                    key={chat.id}
                    className={`chat-item ${currentChatId === chat.id ? 'active' : ''}`}
                    onClick={() => {
                      handleClearSearch();
                      onSelectChat(chat);
                    }}
                    onMouseEnter={() => setHoveredChatId(chat.id)}
                    onMouseLeave={() => setHoveredChatId(null)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && editingChatId !== chat.id) {
                        handleClearSearch();
                        onSelectChat(chat);
                      }
                    }}
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
                            {chat.isStarred && <StarIcon filled size={14} className="starred-icon" />}
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
                            {relativeTime(chat.updatedAt)}
                          </span>
                          {/* Desktop hover actions */}
                          {hoveredChatId === chat.id && (
                            <div className="chat-hover-actions hide-mobile">
                              <button
                                className="icon-button small"
                                onClick={(e) => handleStarClick(e, chat)}
                                title={chat.isStarred ? "Unstar chat" : "Star chat"}
                              >
                                <StarIcon filled={!!chat.isStarred} size={18} />
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
                                  <StarIcon filled={!!chat.isStarred} size={18} />
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
                  </div>
                ))}
                </>
              )}
            </div>
          </>
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
