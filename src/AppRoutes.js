import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import ChatInterface from './components/Chat/ChatInterface';

// The signed-in routes. Every path renders the same ChatInterface element, so React keeps one
// instance across navigations; ChatInterface picks the view from the URL.
function AppRoutes({ user, onThemeToggle, theme }) {
  const chatInterface = (
    <ChatInterface
      user={user}
      onThemeToggle={onThemeToggle}
      theme={theme}
    />
  );
  return (
    <Routes>
      <Route path="/" element={chatInterface} />
      <Route path="/chat/:chatId" element={chatInterface} />
      <Route path="/starred" element={chatInterface} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default AppRoutes;
