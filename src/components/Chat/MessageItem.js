import React, { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import ExportMenu from './ExportMenu';
import UserMessageMenu from './UserMessageMenu';
import './ExportMenu.css';
import './UserMessageMenu.css';

function MessageItem({ message, onUpdateMessage, onDeleteMessage, userId, chatId }) {
  const isUser = message.role === 'user';
  const isStreaming = message.isStreaming;
  const messageRef = useRef(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(message.content || '');

  const components = {
    code({ node, inline, className, children, ...props }) {
      const match = /language-(\w+)/.exec(className || '');
      return !inline && match ? (
        <SyntaxHighlighter
          style={vscDarkPlus}
          language={match[1]}
          PreTag="div"
          customStyle={{
            margin: 'var(--unit-3) 0',
            borderRadius: 'var(--unit-2)',
            fontSize: '0.9em'
          }}
          {...props}
        >
          {String(children).replace(/\n$/, '')}
        </SyntaxHighlighter>
      ) : (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
  };

  const handleEdit = () => {
    setIsEditing(true);
    setEditedContent(message.content || '');
  };

  const handleSave = async () => {
    if (editedContent.trim() !== message.content) {
      await onUpdateMessage(userId, chatId, message.id, { content: editedContent.trim() });
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditedContent(message.content || '');
    setIsEditing(false);
  };

  const handleDelete = async () => {
    await onDeleteMessage(userId, chatId, message.id);
  };

  return (
    <div className={`message message-${isUser ? 'user' : 'assistant'}`}>
      <div className="message-bubble" ref={!isUser ? messageRef : null} style={{ position: 'relative' }}>
        {!isUser && !isStreaming && message.content && (
          <div style={{ position: 'absolute', top: 'var(--unit-2)', right: 'var(--unit-2)' }}>
            <ExportMenu 
              message={message} 
              messageRef={messageRef} 
              onDelete={onDeleteMessage ? () => handleDelete() : null}
            />
          </div>
        )}
        {isUser && (
          <UserMessageMenu 
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        )}
        {message.image && (
          <img 
            src={message.image.url} 
            alt="Uploaded image" 
            style={{
              maxWidth: '200px',
              maxHeight: '200px',
              borderRadius: 'var(--unit-2)',
              marginBottom: 'var(--unit-2)'
            }}
          />
        )}
        {isUser ? (
          isEditing ? (
            <div className="message-edit-mode">
              <textarea
                className="message-edit-textarea"
                value={editedContent}
                onChange={(e) => setEditedContent(e.target.value)}
                autoFocus
              />
              <div className="message-edit-actions">
                <button className="cancel-button" onClick={handleCancel}>
                  Cancel
                </button>
                <button className="save-button" onClick={handleSave}>
                  Save
                </button>
              </div>
            </div>
          ) : (
            <div>{message.content}</div>
          )
        ) : (
          <div className="message-content">
            <ReactMarkdown 
              remarkPlugins={[remarkGfm]}
              components={components}
            >
              {message.content || ''}
            </ReactMarkdown>
            {isStreaming && !message.content && (
              <div className="typing-indicator-wrapper">
                <div className="typing-text">Claude is thinking</div>
                <div className="typing-indicator">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default MessageItem;
