import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

function MessageItem({ message }) {
  const isUser = message.role === 'user';
  const isStreaming = message.isStreaming;

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
