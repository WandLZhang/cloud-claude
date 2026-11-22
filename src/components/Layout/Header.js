import React, { useState } from 'react';
import UserMenu from '../Auth/UserMenu';
import StarIcon from '../Common/StarIcon';

// The phone's top bar: the menu, what's open, and the actions for it. CSS hides it on desktop,
// where the sidebar is always on screen.
function Header({ title, onOpenSidebar, chat, onToggleStar, onNewChat, user, theme, onThemeToggle }) {
  const [showUserMenu, setShowUserMenu] = useState(false);

  return (
    <header className="mobile-header">
      <button type="button" className="icon-button" onClick={onOpenSidebar} aria-label="Open sidebar">
        <span className="icon">menu</span>
      </button>
      <h1 className="mobile-header-title">{title}</h1>
      {chat && (
        <button
          type="button"
          className="icon-button"
          onClick={onToggleStar}
          aria-label={chat.isStarred ? 'Unstar chat' : 'Star chat'}
        >
          <StarIcon filled={!!chat.isStarred} size={22} />
        </button>
      )}
      {onNewChat && (
        <button type="button" className="icon-button" onClick={onNewChat} aria-label="New chat">
          <span className="icon">add</span>
        </button>
      )}
      {user && (
        <>
          <button type="button" className="icon-button" onClick={onThemeToggle} aria-label="Toggle theme">
            <span className="icon">{theme === 'light' ? 'dark_mode' : 'light_mode'}</span>
          </button>
          <div className="user-menu">
            <img
              src={user.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.displayName || 'User')}&background=5c5853&color=fff`}
              alt={user.displayName || 'User'}
              className="user-avatar small"
              onClick={() => setShowUserMenu(!showUserMenu)}
            />
            {showUserMenu && <UserMenu user={user} onClose={() => setShowUserMenu(false)} />}
          </div>
        </>
      )}
    </header>
  );
}

export default Header;
