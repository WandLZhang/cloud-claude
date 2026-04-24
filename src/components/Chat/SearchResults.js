import React, { useState, useEffect, useRef } from 'react';
import { fetchAllUserMessages } from '../../services/firebase';
import LoadingSpinner from '../Common/LoadingSpinner';
import './SearchResults.css';

// Per-user cache of the full message corpus. Keyed by userId. The corpus is
// fetched once per session (or on TTL expiry) and every keystroke filters it
// in-memory — no network call per query.
const datasetCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function SearchResults({ searchQuery, userId, onSelectResult }) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const inFlightRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    const performSearch = async () => {
      const trimmed = searchQuery.trim();
      if (!trimmed) {
        setResults([]);
        setError(null);
        return;
      }
      if (!userId) return;

      const needle = trimmed.toLowerCase();

      const filterAndSet = (dataset) => {
        if (cancelled) return;
        const filtered = dataset
          .filter((m) => m.content && m.content.toLowerCase().includes(needle))
          .slice(0, 50);
        console.log(
          `[SearchResults] query="${trimmed}" matched ${filtered.length} of ${dataset.length} messages`
        );
        setResults(filtered);
      };

      const cached = datasetCache.get(userId);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
        filterAndSet(cached.messages);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        // Coalesce concurrent fetches for the same user so rapid keystrokes
        // during the initial load don't trigger multiple full-corpus reads.
        if (!inFlightRef.current) {
          inFlightRef.current = fetchAllUserMessages(userId).finally(() => {
            inFlightRef.current = null;
          });
        }
        const messages = await inFlightRef.current;
        if (cancelled) return;

        datasetCache.set(userId, { messages, fetchedAt: Date.now() });
        filterAndSet(messages);
      } catch (err) {
        if (cancelled) return;
        console.error('Search error:', err);
        setError('Failed to search messages');
        setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    // 300ms debounce — keeps the in-memory filter from re-running for every
    // keystroke during fast typing (filter is cheap, but React re-render isn't).
    const timeoutId = setTimeout(performSearch, 300);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
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

    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
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
