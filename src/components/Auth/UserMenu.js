import React, { useEffect, useRef } from 'react';
import { logOut } from '../../services/firebase';

function UserMenu({ user, onClose }) {
  const menuRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        onClose();
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const handleSignOut = async () => {
    try {
      await logOut();
      onClose();
    } catch (error) {
      console.error('Sign out error:', error);
    }
  };

  return (
    <div 
      ref={menuRef}
      className="user-menu-dropdown"
      style={{
        position: 'absolute',
        top: '100%',
        right: 0,
        marginTop: 'var(--unit-2)',
        backgroundColor: 'var(--surface)',
        border: '1px solid var(--outline-variant)',
        borderRadius: 'var(--unit-2)',
        boxShadow: '0 4px 6px -1px var(--shadow)',
        minWidth: '200px',
        zIndex: 1000
      }}
    >
      <div className="p-3" style={{ borderBottom: '1px solid var(--outline-variant)' }}>
        <p className="font-medium">{user.displayName}</p>
        <p className="text-sm text-muted">{user.email}</p>
      </div>
      
      <div className="p-2">
        <button
          onClick={handleSignOut}
          className="flex items-center gap-2 w-full p-2 rounded transition-colors"
          style={{
            width: '100%',
            textAlign: 'left',
            backgroundColor: 'transparent',
            border: 'none',
            cursor: 'pointer'
          }}
          onMouseEnter={(e) => e.target.style.backgroundColor = 'var(--surface-container)'}
          onMouseLeave={(e) => e.target.style.backgroundColor = 'transparent'}
        >
          <span className="icon">logout</span>
          <span>Sign out</span>
        </button>
      </div>
    </div>
  );
}

export default UserMenu;
