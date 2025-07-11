import React, { useState } from 'react';
import UserMenu from '../Auth/UserMenu';

function Header({ user, onThemeToggle, theme }) {
  const [showUserMenu, setShowUserMenu] = useState(false);

  return (
    <header className="app-header">
      <h1 className="app-title">Cloud Claude Chat</h1>
      
      <div className="flex items-center gap-3">
        <button 
          className="theme-toggle"
          onClick={onThemeToggle}
          aria-label="Toggle theme"
        >
          <span className="icon">
            {theme === 'light' ? 'dark_mode' : 'light_mode'}
          </span>
        </button>
        
        {user && (
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
        )}
      </div>
    </header>
  );
}

export default Header;
