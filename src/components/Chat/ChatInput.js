import React, { useState, useRef, useEffect } from 'react';

function ChatInput({ onSendMessage, onBatchRelease, disabled, placeholder = "Type your message...", value = '', defaultWebSearch = false }) {
  const [message, setMessage] = useState(value);
  const [selectedImage, setSelectedImage] = useState(null);
  const [selectedDocument, setSelectedDocument] = useState(null);
  const [webSearchEnabled, setWebSearchEnabled] = useState(defaultWebSearch);
  const [batchMode, setBatchMode] = useState(false);
  const [batchQueue, setBatchQueue] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);

  useEffect(() => {
    setMessage(value);
  }, [value]);

  useEffect(() => {
    setWebSearchEnabled(defaultWebSearch);
  }, [defaultWebSearch]);

  useEffect(() => {
    // Auto-resize textarea
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [message]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if ((message.trim() || selectedImage || selectedDocument) && !disabled) {
      const messageToSend = message.trim();
      const imageToSend = selectedImage;
      const documentToSend = selectedDocument;
      const webSearch = webSearchEnabled;

      // Clear state immediately before sending
      setMessage('');
      setSelectedImage(null);
      setSelectedDocument(null);

      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.value = '';
      }

      // Build extra options — only include keys that are set
      const extraOptions = {};
      if (documentToSend) extraOptions.document = documentToSend;
      if (webSearch) extraOptions.enableWebSearch = true;

      if (batchMode) {
        setBatchQueue(prev => [...prev, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          content: messageToSend,
          image: imageToSend,
          extraOptions,
        }]);
      } else {
        onSendMessage(messageToSend, imageToSend, extraOptions);
      }
    }
  };

  const handleBatchToggle = () => {
    if (batchMode && batchQueue.length > 0) {
      // Releasing a non-empty queue
      if (onBatchRelease) {
        onBatchRelease(batchQueue);
      }
      setBatchQueue([]);
    }
    setBatchMode(!batchMode);
  };

  const removeFromQueue = (id) => {
    setBatchQueue(prev => prev.filter(item => item.id !== id));
  };

  const isMobile = () => {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !isMobile()) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleFileSelect = (file) => {
    if (!file || file.size === 0) {
      alert('This file is not accessible. Please download it to your device first.');
      return;
    }

    if (file.type === 'application/pdf') {
      // Handle PDF document
      const reader = new FileReader();
      reader.onload = (e) => {
        setSelectedDocument({
          file,
          url: e.target.result,
          type: file.type,
          name: file.name
        });
        setSelectedImage(null); // Can't have both at once
      };
      reader.onerror = () => {
        alert('Unable to read this PDF. Please try again.');
      };
      reader.readAsDataURL(file);
    } else if (file.type.startsWith('image/')) {
      // Handle image
      const reader = new FileReader();
      reader.onload = (e) => {
        setSelectedImage({
          file,
          url: e.target.result,
          type: file.type
        });
        setSelectedDocument(null); // Can't have both at once
      };
      reader.onerror = () => {
        alert('Unable to read this image. If it\'s from Google Photos or another cloud service, please download it to your device first.');
      };
      reader.readAsDataURL(file);
    }
  };

  // Keep backward compat alias
  const handleImageSelect = handleFileSelect;

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
      handleFileSelect(file);
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

        {selectedDocument && (
          <div style={{
            position: 'relative',
            marginBottom: 'var(--unit-2)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--unit-2)',
            padding: 'var(--unit-2) var(--unit-3)',
            borderRadius: 'var(--unit-2)',
            border: '1px solid var(--outline-variant)',
            backgroundColor: 'var(--surface-container-low)'
          }}>
            <span className="icon" style={{ fontSize: '20px', color: 'var(--primary)' }}>description</span>
            <span style={{ fontSize: '14px', color: 'var(--on-surface)' }}>{selectedDocument.name}</span>
            <button
              type="button"
              onClick={() => setSelectedDocument(null)}
              className="icon-button"
              style={{
                width: '24px',
                height: '24px',
                padding: 0,
                marginLeft: 'var(--unit-1)'
              }}
            >
              <span className="icon" style={{ fontSize: '16px' }}>close</span>
            </button>
          </div>
        )}

        {batchMode && batchQueue.length === 0 && (
          <div style={{
            marginBottom: 'var(--unit-2)',
            padding: 'var(--unit-2) var(--unit-3)',
            borderRadius: 'var(--unit-2)',
            backgroundColor: 'var(--primary-container)',
            color: 'var(--on-primary-container)',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--unit-2)'
          }}>
            <span className="icon" style={{ fontSize: '18px' }}>playlist_add</span>
            <span>Batch mode — messages queue here. Tap the batch button again to release them all.</span>
          </div>
        )}

        {batchQueue.length > 0 && (
          <div style={{
            marginBottom: 'var(--unit-1)',
            padding: 'var(--unit-1) var(--unit-2)',
            borderRadius: 'var(--unit-2)',
            backgroundColor: 'var(--surface-container-low)',
            border: '1px solid var(--outline-variant)',
            maxHeight: '100px',
            overflowY: 'auto',
            width: '100%',
            boxSizing: 'border-box',
          }}>
            <div style={{
              fontSize: '11px',
              color: 'var(--on-surface-variant)',
              marginBottom: 'var(--unit-1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}>
              <span>{batchQueue.length} queued</span>
              <span style={{ fontStyle: 'italic' }}>Tap batch to release</span>
            </div>
            <div style={{
              display: 'flex',
              gap: 'var(--unit-1)',
              overflowX: 'auto',
              paddingBottom: '2px'
            }}>
              {batchQueue.map((item, idx) => (
                <div key={item.id} style={{
                  position: 'relative',
                  flexShrink: 0,
                  width: '56px',
                  height: '56px',
                  borderRadius: 'var(--unit-2)',
                  border: '1px solid var(--outline-variant)',
                  backgroundColor: 'var(--surface)',
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 'var(--unit-1)'
                }}>
                  {item.image ? (
                    <img
                      src={item.image.url}
                      alt={`Queue ${idx + 1}`}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : item.extraOptions?.document ? (
                    <>
                      <span className="icon" style={{ fontSize: '22px', color: 'var(--primary)' }}>description</span>
                      <span style={{ fontSize: '9px', color: 'var(--on-surface-variant)', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '50px' }}>
                        {item.extraOptions.document.name}
                      </span>
                    </>
                  ) : (
                    <span style={{
                      fontSize: '9px',
                      color: 'var(--on-surface)',
                      textAlign: 'center',
                      overflow: 'hidden',
                      display: '-webkit-box',
                      WebkitLineClamp: 4,
                      WebkitBoxOrient: 'vertical',
                      lineHeight: 1.2
                    }}>
                      {item.content || '(empty)'}
                    </span>
                  )}
                  <div style={{
                    position: 'absolute',
                    top: '2px',
                    left: '2px',
                    backgroundColor: 'var(--scrim)',
                    color: 'var(--inverse-on-surface)',
                    fontSize: '10px',
                    fontWeight: 600,
                    padding: '1px 4px',
                    borderRadius: '4px',
                    lineHeight: 1
                  }}>{idx + 1}</div>
                  <button
                    type="button"
                    onClick={() => removeFromQueue(item.id)}
                    className="icon-button"
                    style={{
                      position: 'absolute',
                      top: '-6px',
                      right: '-6px',
                      width: '20px',
                      height: '20px',
                      padding: 0,
                      backgroundColor: 'var(--surface)',
                      border: '1px solid var(--outline-variant)'
                    }}
                    aria-label={`Remove queue item ${idx + 1}`}
                  >
                    <span className="icon" style={{ fontSize: '14px' }}>close</span>
                  </button>
                </div>
              ))}
            </div>
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
            aria-label="Attach file"
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

          <button
            type="button"
            onClick={() => setWebSearchEnabled(!webSearchEnabled)}
            disabled={disabled}
            className="icon-button"
            aria-label="Toggle web search"
            title={webSearchEnabled ? 'Web search ON' : 'Web search OFF'}
            style={{
              backgroundColor: webSearchEnabled ? 'var(--primary-container)' : 'transparent',
              color: webSearchEnabled ? 'var(--on-primary-container)' : 'var(--on-surface-variant)',
              borderRadius: 'var(--unit-3)',
              transition: 'all 0.2s ease'
            }}
          >
            <span className="icon">travel_explore</span>
          </button>

          <button
            type="button"
            onClick={handleBatchToggle}
            disabled={disabled}
            className="icon-button"
            aria-label="Toggle batch mode"
            title={batchMode ? (batchQueue.length > 0 ? `Release ${batchQueue.length} queued` : 'Batch mode ON — click to exit') : 'Batch mode OFF'}
            style={{
              backgroundColor: batchMode ? 'var(--primary-container)' : 'transparent',
              color: batchMode ? 'var(--on-primary-container)' : 'var(--on-surface-variant)',
              borderRadius: 'var(--unit-3)',
              transition: 'all 0.2s ease',
              position: 'relative'
            }}
          >
            <span className="icon">playlist_add</span>
            {batchQueue.length > 0 && (
              <span style={{
                position: 'absolute',
                top: '-4px',
                right: '-4px',
                minWidth: '18px',
                height: '18px',
                borderRadius: '9px',
                backgroundColor: 'var(--primary)',
                color: 'var(--on-primary)',
                fontSize: '11px',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 5px',
                lineHeight: 1,
                pointerEvents: 'none'
              }}>{batchQueue.length}</span>
            )}
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.pdf,application/pdf"
            onChange={(e) => e.target.files[0] && handleFileSelect(e.target.files[0])}
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
            disabled={disabled || (!message.trim() && !selectedImage && !selectedDocument)}
            className="icon-button"
            aria-label={batchMode ? "Add to batch" : "Send message"}
            title={batchMode ? "Add to batch queue" : "Send message"}
            style={{
              width: '40px',
              height: '40px',
              minWidth: '40px',
              minHeight: '40px',
              flexShrink: 0,
              backgroundColor: batchMode ? 'var(--primary-container)' : 'var(--surface-container)',
              color: batchMode ? 'var(--on-primary-container)' : 'var(--on-surface-variant)'
            }}
          >
            <span className="icon" style={{ fontSize: '24px' }}>{batchMode ? 'add' : 'send'}</span>
          </button>
        </div>
      </form>
    </div>
  );
}

export default ChatInput;
