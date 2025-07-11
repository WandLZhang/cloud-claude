import React, { useState, useEffect, useRef } from 'react';
import MessageList from './MessageList';
import ChatInput from './ChatInput';
import { useChat } from '../../hooks/useChat';
import { useFirestore } from '../../hooks/useFirestore';

function ChatInterface({ user }) {
  const [isThinking, setIsThinking] = useState(false);
  const [error, setError] = useState('');
  const messagesEndRef = useRef(null);

  const { messages, sendMessage, loading } = useChat(user.uid);
  const { currentChat, createNewChat } = useFirestore(user.uid);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSendMessage = async (content, image) => {
    setError('');
    setIsThinking(true);
    
    try {
      await sendMessage(content, image);
    } catch (err) {
      console.error('Error sending message:', err);
      setError('Failed to send message. Please try again.');
    } finally {
      setIsThinking(false);
    }
  };

  return (
    <div className="chat-container">
      <MessageList 
        messages={messages} 
        isThinking={isThinking}
        loading={loading}
      />
      <div ref={messagesEndRef} />
      
      {error && (
        <div className="error-message mx-4 mb-2">
          <span className="icon">error</span>
          <span>{error}</span>
        </div>
      )}
      
      <ChatInput 
        onSendMessage={handleSendMessage}
        disabled={loading || isThinking}
      />
    </div>
  );
}

export default ChatInterface;
