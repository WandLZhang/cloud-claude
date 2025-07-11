import React, { useState, useRef, useEffect } from 'react';

function ChatInput({ onSendMessage, disabled }) {
  const [message, setMessage] = useState('');
  const [selectedImage, setSelectedImage] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    // Auto-resize textarea
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [message]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if ((message.trim() || selectedImage) && !disabled) {
      onSendMessage(message.trim(), selectedImage);
      setMessage('');
      setSelectedImage(null);
      
      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleImageSelect = (file) => {
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (e) => {
        setSelectedImage({
          file,
          url: e.target.result,
          type: file.type
        });
      };
      reader.readAsDataURL(file);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    
    const file = e.dataTransfer.files[0];
    if (file) {
      handleImageSelect(file);
    }
  };

  return (
    <div className="input-container">
      <form onSubmit={handleSubmit} className="input-wrapper">
        {selectedImage && (
          <div style={{
            position: 'relative',
            marginBottom: 'var(--unit-2)',
            display: 'inline-block'
          }}>
            <img 
              src={selectedImage.url} 
              alt="Selected" 
              style={{
                maxHeight: '100px',
                borderRadius: 'var(--unit-2)',
                border: '1px solid var(--outline-variant)'
              }}
            />
            <button
              type="button"
              onClick={() => setSelectedImage(null)}
              className="icon-button"
              style={{
                position: 'absolute',
                top: '-8px',
                right: '-8px',
                backgroundColor: 'var(--surface)',
                border: '1px solid var(--outline-variant)',
                width: '24px',
                height: '24px',
                padding: 0
              }}
            >
              <span className="icon" style={{ fontSize: '16px' }}>close</span>
            </button>
          </div>
        )}
        
        <div 
          className="flex gap-2 items-end"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{
            border: isDragging ? '2px dashed var(--primary)' : 'none',
            borderRadius: 'var(--unit-3)',
            padding: isDragging ? 'var(--unit-2)' : 0,
            backgroundColor: isDragging ? 'var(--primary-container)' : 'transparent',
            transition: 'all 0.2s ease'
          }}
        >
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            className="icon-button"
            aria-label="Attach image"
          >
            <span className="icon">attach_file</span>
          </button>
          
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={(e) => e.target.files[0] && handleImageSelect(e.target.files[0])}
            style={{ display: 'none' }}
          />
          
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your message..."
            disabled={disabled}
            className="chat-input"
            rows="1"
          />
          
          <button
            type="submit"
            disabled={disabled || (!message.trim() && !selectedImage)}
            className="icon-button primary"
            aria-label="Send message"
          >
            <span className="icon">send</span>
          </button>
        </div>
      </form>
    </div>
  );
}

export default ChatInput;
