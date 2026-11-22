import React, { useMemo } from 'react';
import { toggleChatStar } from '../../services/firebase';
import { auth } from '../../services/firebase';
import './StarredChats.css';

const millis = (t) => (t?.toDate ? t.toDate().getTime() : t ? new Date(t).getTime() : 0);

// The starred chats come from the live chat list ChatInterface keeps, so this view opens at once,
// with no fetch, and follows star changes as they happen.
function StarredChats({ chats, onSelectChat, onBack }) {
  const starredChats = useMemo(
    () => chats.filter((c) => c.isStarred).sort((a, b) => millis(b.starredAt) - millis(a.starredAt)),
    [chats]
  );

  const handleUnstar = async (chatId, e) => {
    e.stopPropagation();
    try {
      await toggleChatStar(auth.currentUser.uid, chatId, false);
    } catch (error) {
      console.error('Error unstarring chat:', error);
    }
  };

  const formatDate = (timestamp) => {
    if (!timestamp) return '';
    
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date();
    const diffInMs = now - date;
    const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));
    
    if (diffInDays === 0) {
      return 'Today';
    } else if (diffInDays === 1) {
      return 'Yesterday';
    } else if (diffInDays < 7) {
      return date.toLocaleDateString([], { weekday: 'long' });
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    }
  };

  const truncateText = (text, maxLength = 100) => {
    if (!text) return 'New Chat';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
  };

  return (
    <div className="starred-chats-container">
      <div className="starred-chats-header">
        <button className="back-button" onClick={onBack}>
          <span className="icon">arrow_back</span>
        </button>
        <h1>Starred Chats</h1>
      </div>

      {starredChats.length === 0 ? (
        <div className="empty-starred">
          <span className="icon large">star_border</span>
          <h2>No starred chats yet</h2>
          <p>Star important conversations to access them quickly here</p>
        </div>
      ) : (
        <div className="starred-chats-grid">
          {starredChats.map((chat) => (
            <div
              key={chat.id}
              className="starred-chat-card"
              onClick={() => onSelectChat(chat)}
            >
              <div className="card-header">
                <h3>{truncateText(chat.title || 'Untitled Chat', 50)}</h3>
                <button
                  className="unstar-button"
                  onClick={(e) => handleUnstar(chat.id, e)}
                  title="Unstar this chat"
                >
                  <span className="icon">star</span>
                </button>
              </div>
              <p className="card-preview">
                {truncateText(chat.lastMessage || 'No messages yet', 150)}
              </p>
              <div className="card-footer">
                <span className="card-date">{formatDate(chat.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default StarredChats;
