import React, { useEffect, useRef } from 'react';
import MessageItem from './MessageItem';
import LoadingSpinner from '../Common/LoadingSpinner';

function MessageList({ messages, isThinking, loading, onUpdateMessage, onDeleteMessage, userId, chatId, targetMessageId, onScrollComplete }) {
  const containerRef = useRef(null);
  const prevMessagesLength = useRef(0);
  const messageRefs = useRef({});

  // Scroll to bottom when messages load or change
  useEffect(() => {
    if (!loading && messages.length > 0 && containerRef.current) {
      const scrollToBottom = () => {
        if (containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
      };

      // Check if streaming just ended
      const lastMessage = messages[messages.length - 1];
      const isStreaming = lastMessage?.isStreaming === true;
      
      // Scroll if this is initial load, new messages, or streaming
      if (prevMessagesLength.current === 0 || messages.length !== prevMessagesLength.current || isStreaming) {
        // Immediate scroll
        scrollToBottom();
        
        // For non-streaming, use MutationObserver to ensure DOM is ready
        if (!isStreaming) {
          // Observe DOM changes to ensure messages are rendered
          const observer = new MutationObserver(() => {
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
  }, [messages, loading]);

  // Reset when chatId changes and force scroll
  useEffect(() => {
    prevMessagesLength.current = 0;
    if (chatId && containerRef.current && messages.length > 0) {
      // Force scroll after chat change
      setTimeout(() => {
        if (containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
      }, 100);
    }
  }, [chatId]);

  // Scroll to target message when provided
  useEffect(() => {
    if (targetMessageId && messages.length > 0 && messageRefs.current[targetMessageId]) {
      const timeoutId = setTimeout(() => {
        const targetElement = messageRefs.current[targetMessageId];
        if (targetElement) {
          targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
          
          // Add highlight effect
          targetElement.classList.add('highlight-message');
          
          // Remove highlight after animation
          setTimeout(() => {
            targetElement.classList.remove('highlight-message');
            if (onScrollComplete) {
              onScrollComplete();
            }
          }, 2000);
        }
      }, 500); // Wait for messages to render
      
      return () => clearTimeout(timeoutId);
    }
  }, [targetMessageId, messages]);

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
              ref={(el) => messageRefs.current[message.id] = el}
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
