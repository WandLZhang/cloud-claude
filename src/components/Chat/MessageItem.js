import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

function MessageItem({ message }) {
  const isUser = message.role === 'user';

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

  return (
    <div className={`message message-${isUser ? 'user' : 'assistant'}`}>
      <div className="message-bubble">
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
          <div>{message.content}</div>
        ) : (
          <div className="message-content">
            <ReactMarkdown 
              remarkPlugins={[remarkGfm]}
              components={components}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        )}
        {message.thinking && (
          <details style={{ marginTop: 'var(--unit-3)' }}>
            <summary style={{ cursor: 'pointer', color: 'var(--on-surface-variant)' }}>
              <span className="icon" style={{ fontSize: '14px', marginRight: 'var(--unit-1)' }}>
                psychology
              </span>
              Claude's thinking process
            </summary>
            <div style={{ 
              marginTop: 'var(--unit-2)', 
              padding: 'var(--unit-3)',
              backgroundColor: 'var(--surface-container-low)',
              borderRadius: 'var(--unit-2)',
              fontSize: '0.9em',
              whiteSpace: 'pre-wrap'
            }}>
              {message.thinking}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

export default MessageItem;
