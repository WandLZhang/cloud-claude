import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import CodeBlock from './CodeBlock';
import ExportMenu from './ExportMenu';
import UserMessageMenu from './UserMessageMenu';
import { replyState } from './replyState';
import { codeFromNode, formatElapsed, modelLabel, thinkingLabel } from './format';
import './ExportMenu.css';
import './UserMessageMenu.css';

// Statuses that come from web search get the search icon; the rest get a spinner.
const SEARCH_STATUS_PREFIXES = ['Searching', 'Reading'];

const markdownComponents = {
  // A fenced block arrives as <pre><code class="language-x">; CodeBlock draws it as one dark block.
  pre({ node }) {
    const { language, text } = codeFromNode(node);
    return <CodeBlock language={language} text={text} />;
  },
  // Wide tables scroll sideways on a phone instead of squeezing their columns.
  table({ node, children, ...props }) {
    return (
      <div className="table-scroll">
        <table {...props}>{children}</table>
      </div>
    );
  },
};

function startedAt(message) {
  const ts = message.timestamp;
  if (ts && typeof ts.toDate === 'function') return ts.toDate().getTime();
  if (ts instanceof Date) return ts.getTime();
  return null;
}

function MessageItem({ message, onUpdateMessage, onDeleteMessage, userId, chatId, isLatestReply, onRetry }) {
  const isUser = message.role === 'user';
  const isStreaming = message.isStreaming;
  const messageRef = useRef(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(message.content || '');
  const [now, setNow] = useState(() => Date.now());
  const [showThinking, setShowThinking] = useState(false);

  // While a reply streams, tick each second: the status line shows how long it has run, and a reply
  // whose turn died never gets another Firestore update, so its age decides when it reads as stopped.
  useEffect(() => {
    if (!isStreaming) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isStreaming]);

  const reply = isUser ? null : replyState(message, now);
  const status = reply?.kind === 'streaming' ? reply.status : null;
  const showTyping = reply?.kind === 'streaming' && !message.content && (!status || status === 'Thinking');
  const showStatus = reply?.kind === 'streaming' && status && !showTyping;
  const isSearchStatus = showStatus && SEARCH_STATUS_PREFIXES.some((p) => status.startsWith(p));
  const started = reply?.kind === 'streaming' ? startedAt(message) : null;
  const elapsed = started !== null ? ` · ${formatElapsed(now - started)}` : '';
  const finished = reply && reply.kind !== 'streaming';
  const hasThinking = !isUser && !!message.thinking;

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

  // A finished reply keeps its actions in the corner ⋮ menu, so nothing sits under its text. Retry
  // is on the latest reply only; a failed reply has no text, so its menu holds just Retry and Delete.
  const menuItems = [];
  if (isLatestReply && onRetry) {
    menuItems.push({ icon: 'refresh', label: 'Retry', onClick: () => onRetry(message) });
  }
  if (hasThinking) {
    menuItems.push({
      icon: 'psychology',
      label: showThinking ? 'Hide thinking' : thinkingLabel(message.thinkingSeconds),
      onClick: () => setShowThinking(!showThinking),
    });
  }
  const showMenu = finished && (!!message.content || menuItems.length > 0);

  return (
    <div className={`message message-${isUser ? 'user' : 'assistant'}`}>
      <div className="message-bubble" ref={!isUser ? messageRef : null} style={{ position: 'relative' }}>
        {showMenu && (
          <div className="reply-menu">
            <ExportMenu
              message={message}
              messageRef={messageRef}
              onDelete={onDeleteMessage ? () => handleDelete() : null}
              extraItems={menuItems}
              modelName={modelLabel(message.model)}
            />
          </div>
        )}
        {isUser && !message.pending && (
          <UserMessageMenu
            onEdit={handleEdit}
            onDelete={handleDelete}
          />
        )}
        {message.image && (
          <img
            src={message.image.url}
            alt="Uploaded"
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
            <span className="icon" style={{ fontSize: '20px', color: 'var(--on-surface-variant)' }}>description</span>
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
            {hasThinking && showThinking && (
              <div className="thinking-text">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.thinking}</ReactMarkdown>
              </div>
            )}
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw]}
              components={markdownComponents}
            >
              {message.content || ''}
            </ReactMarkdown>
            {showTyping && (
              <div className="typing-indicator-wrapper">
                <div className="typing-text">Claude is thinking{elapsed}</div>
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
                <span>{status}{elapsed}</span>
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
                        color: 'var(--link)',
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
