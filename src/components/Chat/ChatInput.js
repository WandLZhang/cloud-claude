import React, { useState, useRef, useEffect } from 'react';

function ChatInput({ onSendMessage, disabled, placeholder = "Type your message...", value = '' }) {
  const [message, setMessage] = useState(value);
  const [selectedImage, setSelectedImage] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);

  useEffect(() => {
    // Update message when value prop changes
    setMessage(value);
  }, [value]);

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
      const messageToSend = message.trim();
      const imageToSend = selectedImage;
      
      // Clear state immediately before sending
      setMessage('');
      setSelectedImage(null);
      
      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.value = ''; // Force clear the textarea value
      }
      
      // Send the message after clearing state
      onSendMessage(messageToSend, imageToSend);
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
      // Check if file has actual content
      if (file.size === 0) {
        alert('This image is not accessible. Please download it to your device first.');
        return;
      }
      
      const reader = new FileReader();
      reader.onload = (e) => {
        setSelectedImage({
          file,
          url: e.target.result,
          type: file.type
        });
      };
      reader.onerror = (error) => {
        console.error('Error reading image:', error);
        alert('Unable to read this image. If it\'s from Google Photos or another cloud service, please download it to your device first.');
      };
      reader.readAsDataURL(file);
    }
  };

  const handleCameraCapture = async () => {
    try {
      // Check if we can access camera
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        // Fallback to file input if camera API not available
        cameraInputRef.current?.click();
        return;
      }

      // Create a video element to show camera stream
      const video = document.createElement('video');
      video.style.position = 'fixed';
      video.style.top = '50%';
      video.style.left = '50%';
      video.style.transform = 'translate(-50%, -50%)';
      video.style.width = '90%';
      video.style.maxWidth = '600px';
      video.style.height = 'auto';
      video.style.zIndex = '10000';
      video.style.borderRadius = 'var(--unit-6)';
      video.style.boxShadow = '0 8px 32px var(--shadow)';
      
      // Create overlay
      const overlay = document.createElement('div');
      overlay.style.position = 'fixed';
      overlay.style.top = '0';
      overlay.style.left = '0';
      overlay.style.width = '100%';
      overlay.style.height = '100%';
      overlay.style.backgroundColor = 'var(--scrim)';
      overlay.style.backdropFilter = 'blur(8px)';
      overlay.style.zIndex = '9999';
      
      // Create capture button
      const captureBtn = document.createElement('button');
      captureBtn.innerHTML = '<span class="icon" style="font-size: 36px;">photo_camera</span>';
      captureBtn.style.position = 'fixed';
      captureBtn.style.bottom = 'var(--unit-10)';
      captureBtn.style.left = '50%';
      captureBtn.style.transform = 'translateX(-50%)';
      captureBtn.style.width = '72px';
      captureBtn.style.height = '72px';
      captureBtn.style.borderRadius = '50%';
      captureBtn.style.backgroundColor = 'var(--primary-container)';
      captureBtn.style.color = 'var(--on-primary-container)';
      captureBtn.style.border = '4px solid var(--surface)';
      captureBtn.style.cursor = 'pointer';
      captureBtn.style.zIndex = '10001';
      captureBtn.style.display = 'flex';
      captureBtn.style.alignItems = 'center';
      captureBtn.style.justifyContent = 'center';
      captureBtn.style.boxShadow = '0 4px 16px var(--shadow)';
      captureBtn.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
      captureBtn.className = 'material-icons-round';
      
      // Add hover effect for capture button
      captureBtn.onmouseenter = () => {
        captureBtn.style.transform = 'translateX(-50%) scale(1.1)';
        captureBtn.style.backgroundColor = 'var(--primary)';
        captureBtn.style.color = 'var(--on-primary)';
      };
      captureBtn.onmouseleave = () => {
        captureBtn.style.transform = 'translateX(-50%) scale(1)';
        captureBtn.style.backgroundColor = 'var(--primary-container)';
        captureBtn.style.color = 'var(--on-primary-container)';
      };
      
      // Create cancel button
      const cancelBtn = document.createElement('button');
      cancelBtn.innerHTML = '<span class="icon">close</span>';
      cancelBtn.style.position = 'fixed';
      cancelBtn.style.top = 'var(--unit-6)';
      cancelBtn.style.right = 'var(--unit-6)';
      cancelBtn.style.width = '48px';
      cancelBtn.style.height = '48px';
      cancelBtn.style.borderRadius = '50%';
      cancelBtn.style.backgroundColor = 'var(--surface-container)';
      cancelBtn.style.color = 'var(--on-surface-variant)';
      cancelBtn.style.border = 'none';
      cancelBtn.style.cursor = 'pointer';
      cancelBtn.style.zIndex = '10001';
      cancelBtn.style.display = 'flex';
      cancelBtn.style.alignItems = 'center';
      cancelBtn.style.justifyContent = 'center';
      cancelBtn.style.boxShadow = '0 2px 8px var(--shadow)';
      cancelBtn.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
      cancelBtn.className = 'material-icons-round';
      
      // Add hover effect for cancel button
      cancelBtn.onmouseenter = () => {
        cancelBtn.style.backgroundColor = 'var(--surface-container-high)';
        cancelBtn.style.transform = 'scale(1.1)';
      };
      cancelBtn.onmouseleave = () => {
        cancelBtn.style.backgroundColor = 'var(--surface-container)';
        cancelBtn.style.transform = 'scale(1)';
      };
      
      document.body.appendChild(overlay);
      document.body.appendChild(video);
      document.body.appendChild(captureBtn);
      document.body.appendChild(cancelBtn);
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment' } // Use rear camera by default
      });
      
      video.srcObject = stream;
      video.play();
      
      const cleanup = () => {
        stream.getTracks().forEach(track => track.stop());
        document.body.removeChild(video);
        document.body.removeChild(overlay);
        document.body.removeChild(captureBtn);
        document.body.removeChild(cancelBtn);
      };
      
      captureBtn.onclick = () => {
        // Create canvas to capture image
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        // Convert to blob
        canvas.toBlob((blob) => {
          const file = new File([blob], 'camera-capture.jpg', { type: 'image/jpeg' });
          handleImageSelect(file);
          cleanup();
        }, 'image/jpeg', 0.9);
      };
      
      cancelBtn.onclick = cleanup;
      overlay.onclick = cleanup;
      
    } catch (error) {
      console.error('Camera access denied or not available:', error);
      // Fallback to file input
      cameraInputRef.current?.click();
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
            border: 'none',
            borderRadius: 'var(--unit-6)',
            padding: isDragging ? 'var(--unit-2)' : 0,
            backgroundColor: isDragging ? 'var(--primary-container)' : 'transparent',
            boxShadow: isDragging ? '0 0 0 2px var(--primary)' : 'none',
            transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
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
          
          <button
            type="button"
            onClick={handleCameraCapture}
            disabled={disabled}
            className="icon-button"
            aria-label="Take photo"
          >
            <span className="icon">photo_camera</span>
          </button>
          
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={(e) => e.target.files[0] && handleImageSelect(e.target.files[0])}
            style={{ display: 'none' }}
          />
          
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="camera"
            onChange={(e) => e.target.files[0] && handleImageSelect(e.target.files[0])}
            style={{ display: 'none' }}
          />
          
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            className="chat-input"
            rows="1"
          />
          
          <button
            type="submit"
            disabled={disabled || (!message.trim() && !selectedImage)}
            className="icon-button"
            aria-label="Send message"
            style={{
              width: '40px',
              height: '40px',
              minWidth: '40px',
              minHeight: '40px',
              flexShrink: 0,
              backgroundColor: 'var(--surface-container)',
              color: 'var(--on-surface-variant)'
            }}
          >
            <span className="icon" style={{ fontSize: '24px' }}>send</span>
          </button>
        </div>
      </form>
    </div>
  );
}

export default ChatInput;
