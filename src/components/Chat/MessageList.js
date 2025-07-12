import React from 'react';
import MessageItem from './MessageItem';
import LoadingSpinner from '../Common/LoadingSpinner';

function MessageList({ messages, isThinking, loading, onUpdateMessage, onDeleteMessage, userId, chatId }) {
  if (loading) {
    return (
      <div className="messages-container scrollbar-custom flex items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="messages-container scrollbar-custom">
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
          {messages.map((message, index) => (
            <MessageItem 
              key={`${message.id}-${index}`} 
              message={message}
              onUpdateMessage={onUpdateMessage}
              onDeleteMessage={onDeleteMessage}
              userId={userId}
              chatId={chatId}
            />
          ))}
        </>
      )}
    </div>
  );
}

export default MessageList;
