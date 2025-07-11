import React, { useState } from 'react';
import { signInWithGoogle } from '../../services/firebase';

function SignIn() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSignIn = async () => {
    setLoading(true);
    setError('');
    
    try {
      await signInWithGoogle();
    } catch (error) {
      console.error('Sign in error:', error);
      setError('Failed to sign in. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="sign-in-container">
      <div className="sign-in-card">
        <h2 className="h3 text-center mb-4">Welcome to Cloud Claude Chat</h2>
        <p className="text-center text-muted mb-4">
          Sign in with your Google account to start chatting with Claude AI
        </p>
        
        {error && (
          <div className="error-message mb-4">
            <span className="icon">error</span>
            <span>{error}</span>
          </div>
        )}
        
        <button
          onClick={handleSignIn}
          disabled={loading}
          className="flex items-center justify-center gap-3 w-full"
          style={{ width: '100%' }}
        >
          <img 
            src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg"
            alt="Google"
            style={{ width: '20px', height: '20px' }}
          />
          {loading ? 'Signing in...' : 'Sign in with Google'}
        </button>
        
        <p className="text-sm text-muted text-center mt-4">
          By signing in, you agree to our Terms of Service and Privacy Policy
        </p>
      </div>
    </div>
  );
}

export default SignIn;
