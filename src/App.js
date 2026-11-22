import React, { useState, useEffect } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { auth } from './services/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import AppRoutes from './AppRoutes';
import SignIn from './components/Auth/SignIn';
import LoadingSpinner from './components/Common/LoadingSpinner';
import './App.css';

// The installed app's status bar takes this color.
function setThemeColor(theme) {
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#141414' : '#f9f9f8');
}

function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // index.html applied the saved theme before the first paint; this keeps the page in step with the toggle.
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light');

  useEffect(() => {
    document.body.className = theme;
    setThemeColor(theme);
  }, [theme]);

  useEffect(() => {
    // Test mode: skip auth with a mock user for Playwright / local UI testing
    if (process.env.REACT_APP_TEST_MODE === 'true') {
      setUser({ uid: 'test-user', displayName: 'Test User', photoURL: null });
      setLoading(false);
      return;
    }

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
        <AppRoutes user={user} onThemeToggle={toggleTheme} theme={theme} />
      </div>
    </BrowserRouter>
  );
}

export default App;
