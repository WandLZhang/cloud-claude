import React, { useState, useEffect, useRef } from 'react';
import './UserMessageMenu.css';

function UserMessageMenu({ onEdit, onDelete }) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    // Close menu when clicking outside
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('click', handleClickOutside);
      return () => document.removeEventListener('click', handleClickOutside);
    }
  }, [isOpen]);

  const handleMenuClick = (e) => {
    e.stopPropagation();
    setIsOpen(!isOpen);
  };

  const handleEdit = () => {
    onEdit();
    setIsOpen(false);
  };

  const handleDelete = () => {
    onDelete();
    setIsOpen(false);
  };

  return (
    <div className="user-message-menu-wrapper" ref={menuRef}>
      <button
        className="icon-button small user-message-menu-button"
        onClick={handleMenuClick}
        title="Message options"
      >
        <span className="icon">more_vert</span>
      </button>
      
      {isOpen && (
        <div className="user-message-menu-dropdown">
          <button
            className="menu-item"
            onClick={handleEdit}
          >
            <span className="icon">edit</span>
            <span>Edit</span>
          </button>
          
          <button
            className="menu-item"
            onClick={handleDelete}
          >
            <span className="icon">delete</span>
            <span>Delete</span>
          </button>
        </div>
      )}
    </div>
  );
}

export default UserMessageMenu;
