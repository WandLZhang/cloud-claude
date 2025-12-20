import React, { useEffect, useRef } from 'react';
import MessageItem from './MessageItem';
import LoadingSpinner from '../Common/LoadingSpinner';

function MessageList({ messages, isThinking, loading, onUpdateMessage, onDeleteMessage, userId, chatId, targetMessageId, scrollTrigger, onScrollComplete }) {
  const containerRef = useRef(null);
  const prevMessagesLength = useRef(0);
  const messageRefs = useRef({});

  // Scroll to bottom when messages load or change
  useEffect(() => {
    if (!loading && messages.length > 0 && containerRef.current && !targetMessageId) {
      const scrollToBottom = () => {
        if (containerRef.current) {
          console.log('[SCROLL DOWN] Scrolling to bottom - called from messages effect');
          containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
      };

      // Check if streaming just ended
      const lastMessage = messages[messages.length - 1];
      const isStreaming = lastMessage?.isStreaming === true;
      
      // Scroll if this is initial load, new messages, or streaming
      if (prevMessagesLength.current === 0 || messages.length !== prevMessagesLength.current || isStreaming) {
        // Immediate scroll
        console.log('[SCROLL DOWN] Initial/new messages scroll - streaming:', isStreaming);
        scrollToBottom();
        
        // For non-streaming, use MutationObserver to ensure DOM is ready
        if (!isStreaming) {
          // Observe DOM changes to ensure messages are rendered
          const observer = new MutationObserver(() => {
            console.log('[SCROLL DOWN] MutationObserver triggered scroll');
            scrollToBottom();
          });
          
          observer.observe(containerRef.current, {
            childList: true,
            subtree: true,
          });
          
          // Disconnect after a short delay
          const timeoutId = setTimeout(() => {
            observer.disconnect();
            // Final scroll attempt
            console.log('[SCROLL DOWN] Final timeout scroll');
            scrollToBottom();
          }, 1000);
          
          return () => {
            clearTimeout(timeoutId);
            observer.disconnect();
          };
        }
      }
      prevMessagesLength.current = messages.length;
    }
  }, [messages, loading, targetMessageId]);

  // Reset when chatId changes and force scroll
  useEffect(() => {
    prevMessagesLength.current = 0;
    if (chatId && containerRef.current && messages.length > 0 && !targetMessageId) {
      // Force scroll after chat change
      setTimeout(() => {
        if (containerRef.current) {
          console.log('[SCROLL DOWN] Chat change scroll - chatId:', chatId);
          containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
      }, 100);
    }
  }, [chatId, messages.length, targetMessageId]);

  // Scroll to target message when provided
  useEffect(() => {
    if (!targetMessageId || messages.length === 0) return;

    console.log('[SCROLL UP] Target scroll initiated - targetMessageId:', targetMessageId, 'scrollTrigger:', scrollTrigger);
    
    const scrollToElement = (targetElement) => {
      if (!targetElement || !containerRef.current) return false;
      
      console.log('[SCROLL UP] Scrolling to element');
      
      // Calculate the position to scroll to (center the message)
      const containerRect = containerRef.current.getBoundingClientRect();
      const elementRect = targetElement.getBoundingClientRect();
      const relativeTop = elementRect.top - containerRect.top;
      const scrollTop = containerRef.current.scrollTop + relativeTop - (containerRect.height / 2) + (elementRect.height / 2);
      
      console.log('[SCROLL UP] Scrolling to position:', scrollTop);
      
      // Scroll the container
      containerRef.current.scrollTo({
        top: scrollTop,
        behavior: 'smooth'
      });
      
      // Add highlight effect
      targetElement.classList.add('highlight-message');
      
      // Remove highlight after animation
      setTimeout(() => {
        targetElement.classList.remove('highlight-message');
        // Don't clear targetMessageId here - let user interaction clear it
      }, 2000);
      
      return true;
    };
    
    // Check if element already exists
    const existingElement = document.getElementById(`message-${targetMessageId}`);
    if (existingElement) {
      console.log('[SCROLL UP] Element already exists in DOM, scrolling immediately');
      // Small delay to ensure layout is stable
      setTimeout(() => {
        scrollToElement(existingElement);
      }, 100);
      return;
    }
    
    console.log('[SCROLL UP] Element not found, starting MutationObserver');
    
    // Use MutationObserver to wait for the element to appear
    const observer = new MutationObserver((mutations, obs) => {
      const targetElement = document.getElementById(`message-${targetMessageId}`);
      
      if (targetElement) {
        console.log('[SCROLL UP] Target element found via observer');
        obs.disconnect();
        scrollToElement(targetElement);
      }
    });

    // Start observing
    if (containerRef.current) {
      observer.observe(containerRef.current, {
        childList: true,
        subtree: true
      });
    }

    // Fallback timeout
    const timeoutId = setTimeout(() => {
      observer.disconnect();
      console.log('[SCROLL UP] Observer timeout reached, element not found');
      if (onScrollComplete) {
        onScrollComplete();
      }
    }, 5000);

    return () => {
      observer.disconnect();
      clearTimeout(timeoutId);
    };
  }, [targetMessageId, messages.length, scrollTrigger, onScrollComplete]);

  if (loading) {
    return (
      <div className="messages-container scrollbar-custom flex items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="messages-container scrollbar-custom" ref={containerRef}>
      {messages.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-center p-4">
          <span className="icon text-muted" style={{ fontSize: '48px', marginBottom: 'var(--unit-4)' }}>
            chat
          </span>
          <h3 className="h5 mb-2">Start a conversation</h3>
          <p className="text-muted">
            Ask me anything! I can help with analysis, writing, coding, and more.
          </p>
        </div>
      ) : (
        <>
          {messages.map((message) => (
            <div 
              key={message.id}
              ref={(el) => {
                if (el) {
                  messageRefs.current[message.id] = el;
                }
              }}
              id={`message-${message.id}`}
            >
              <MessageItem 
                message={message}
                onUpdateMessage={onUpdateMessage}
                onDeleteMessage={onDeleteMessage}
                userId={userId}
                chatId={chatId}
              />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export default MessageList;
