import React, { useState, useEffect } from 'react';
import { searchMessages } from '../../services/firebase';
import LoadingSpinner from '../Common/LoadingSpinner';
import './SearchResults.css';

function SearchResults({ searchQuery, userId, onSelectResult }) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const performSearch = async () => {
      if (!searchQuery.trim()) {
        setResults([]);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const searchResults = await searchMessages(userId, searchQuery);
        // Sort by most recent first
        const sortedResults = searchResults.sort((a, b) => {
          const aTime = a.timestamp?.toDate ? a.timestamp.toDate() : new Date(a.timestamp);
          const bTime = b.timestamp?.toDate ? b.timestamp.toDate() : new Date(b.timestamp);
          return bTime - aTime;
        });
        setResults(sortedResults);
      } catch (err) {
        console.error('Search error:', err);
        setError('Failed to search messages');
        setResults([]);
      } finally {
        setLoading(false);
      }
    };

    // Debounce search
    const timeoutId = setTimeout(performSearch, 300);
    return () => clearTimeout(timeoutId);
  }, [searchQuery, userId]);

  const formatTimestamp = (timestamp) => {
    if (!timestamp) return '';
    
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date();
    const diffInMs = now - date;
    const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));
    
    if (diffInDays === 0) {
      return `Today at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } else if (diffInDays === 1) {
      return `Yesterday at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    }
  };

  const highlightText = (text, query) => {
    if (!query.trim()) return text;
    
    const regex = new RegExp(`(${query})`, 'gi');
    const parts = text.split(regex);
    
    return parts.map((part, index) => 
      regex.test(part) ? <mark key={index}>{part}</mark> : part
    );
  };

  if (loading) {
    return (
      <div className="search-results loading">
        <LoadingSpinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="search-results error">
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="search-results">
      {results.length === 0 ? (
        <div className="no-results">
          <p>No messages found for "{searchQuery}"</p>
        </div>
      ) : (
        <div className="results-list">
          <div className="results-header">
            <span>{results.length} result{results.length !== 1 ? 's' : ''} found</span>
          </div>
          {results.map((result) => (
            <button
              key={`${result.chatId}-${result.messageId}`}
              className="search-result-item"
              onClick={() => onSelectResult(result)}
            >
              <div className="result-chat-title">
                {result.chatTitle || 'Untitled Chat'}
              </div>
              <div className="result-message-preview">
                {highlightText(result.content, searchQuery)}
              </div>
              <div className="result-timestamp">
                {formatTimestamp(result.timestamp)}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default SearchResults;
