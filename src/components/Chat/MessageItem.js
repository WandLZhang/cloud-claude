import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import ExportMenu from './ExportMenu';
import UserMessageMenu from './UserMessageMenu';
import { replyState } from './replyState';
import './ExportMenu.css';
import './UserMessageMenu.css';

// Statuses that come from web search get the search icon; the rest get a spinner.
const SEARCH_STATUS_PREFIXES = ['Searching', 'Reading'];

function MessageItem({ message, onUpdateMessage, onDeleteMessage, userId, chatId }) {
  const isUser = message.role === 'user';
  const isStreaming = message.isStreaming;
  const messageRef = useRef(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(message.content || '');
  const [now, setNow] = useState(() => Date.now());

  // A reply whose turn died never gets another Firestore update, so re-check its age on a timer.
  useEffect(() => {
    if (!isStreaming) return undefined;
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, [isStreaming]);

  const reply = isUser ? null : replyState(message, now);
  const status = reply?.kind === 'streaming' ? reply.status : null;
  const showThinking = reply?.kind === 'streaming' && !message.content && (!status || status === 'Thinking');
  const showStatus = reply?.kind === 'streaming' && status && !showThinking;
  const isSearchStatus = showStatus && SEARCH_STATUS_PREFIXES.some((p) => status.startsWith(p));

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
        {message.document && (
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--unit-2)',
            padding: 'var(--unit-2) var(--unit-3)',
            borderRadius: 'var(--unit-2)',
            border: '1px solid var(--outline-variant)',
            backgroundColor: 'var(--surface-container-low)',
            marginBottom: 'var(--unit-2)'
          }}>
            <span className="icon" style={{ fontSize: '20px', color: 'var(--primary)' }}>description</span>
            <span style={{ fontSize: '14px' }}>{message.document.name || 'Document'}</span>
          </div>
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
              rehypePlugins={[rehypeRaw]}
              components={components}
            >
              {message.content || ''}
            </ReactMarkdown>
            {showThinking && (
              <div className="typing-indicator-wrapper">
                <div className="typing-text">Claude is thinking</div>
                <div className="typing-indicator">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              </div>
            )}
            {showStatus && (
              <div className="retry-indicator">
                {isSearchStatus ? (
                  <span className="icon" style={{ fontSize: '16px' }}>travel_explore</span>
                ) : (
                  <span className="icon" style={{ fontSize: '16px', animation: 'spin 1s linear infinite' }}>refresh</span>
                )}
                <span>{status}</span>
              </div>
            )}
            {(reply?.kind === 'failed' || reply?.kind === 'stopped') && (
              <div className="error-message">
                <span className="icon">error</span>
                <span>
                  {reply.kind === 'failed'
                    ? `This reply failed: ${reply.error}`
                    : 'This reply stopped before it finished. Send your message again.'}
                </span>
              </div>
            )}
            {message.citations && message.citations.length > 0 && (
              <div style={{
                marginTop: 'var(--unit-3)',
                paddingTop: 'var(--unit-2)',
                borderTop: '1px solid var(--outline-variant)'
              }}>
                <div style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: 'var(--on-surface-variant)',
                  marginBottom: 'var(--unit-1)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--unit-1)'
                }}>
                  <span className="icon" style={{ fontSize: '14px' }}>travel_explore</span>
                  Sources
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {message.citations.map((citation, idx) => (
                    <a
                      key={idx}
                      href={citation.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        fontSize: '12px',
                        color: 'var(--primary)',
                        textDecoration: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px'
                      }}
                    >
                      <span className="icon" style={{ fontSize: '12px' }}>link</span>
                      {citation.title || citation.url}
                    </a>
                  ))}
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
