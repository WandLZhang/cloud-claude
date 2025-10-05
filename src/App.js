import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { auth } from './services/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import ChatInterface from './components/Chat/ChatInterface';
import SignIn from './components/Auth/SignIn';
import LoadingSpinner from './components/Common/LoadingSpinner';
import './App.css';

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState('light');

  useEffect(() => {
    // Check for saved theme preference
    const savedTheme = localStorage.getItem('theme') || 'light';
    setTheme(savedTheme);
    document.body.className = savedTheme;

    // Set up auth state listener
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    document.body.className = newTheme;
    localStorage.setItem('theme', newTheme);
  };

  if (loading) {
    return (
      <div className="app-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <LoadingSpinner />
      </div>
    );
  }

  if (!user) {
    return (
      <BrowserRouter>
        <div className="app-container">
          <SignIn />
        </div>
      </BrowserRouter>
    );
  }

  // Always render ChatInterface when authenticated with routing
  return (
    <BrowserRouter>
      <div className="app-container">
        <Routes>
          <Route path="/" element={
            <ChatInterface 
              user={user} 
              onThemeToggle={toggleTheme} 
              theme={theme} 
            />
          } />
          <Route path="/chat/:chatId" element={
            <ChatInterface 
              user={user} 
              onThemeToggle={toggleTheme} 
              theme={theme} 
            />
          } />
          <Route path="/starred" element={
            <ChatInterface 
              user={user} 
              onThemeToggle={toggleTheme} 
              theme={theme} 
            />
          } />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default App;
