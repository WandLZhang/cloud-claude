import React, { useState, useEffect, useRef } from 'react';
import MessageList from './MessageList';
import ChatInput from './ChatInput';
import ChatSidebar from './ChatSidebar';
import { useChat } from '../../hooks/useChat';
import { useFirestore } from '../../hooks/useFirestore';
import './ChatInterface.css';

function ChatInterface({ user }) {
  const [isThinking, setIsThinking] = useState(false);
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const messagesEndRef = useRef(null);

  const { userChats, currentChat, clearCurrentChat, selectChat } = useFirestore(user.uid);
  const { messages, sendMessage, loading, switchChat } = useChat(user.uid, currentChat?.id);

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

  const handleNewChat = () => {
    // Clear current chat to go back to home page
    clearCurrentChat();
    setSidebarOpen(false);
  };

  const handleSelectChat = (chat) => {
    selectChat(chat);
    setSidebarOpen(false);
  };

  return (
    <div className="chat-interface-wrapper">
      <ChatSidebar
        userChats={userChats}
        currentChatId={currentChat?.id}
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
      />
      
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
    </div>
  );
}

export default ChatInterface;
