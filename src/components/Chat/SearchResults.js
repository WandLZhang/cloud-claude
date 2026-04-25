import React, { useState, useEffect, useRef } from 'react';
import * as OpenCC from 'opencc-js/t2cn';
import { fetchAllUserMessages } from '../../services/firebase';
import LoadingSpinner from '../Common/LoadingSpinner';
import './SearchResults.css';

// Per-user cache of the full message corpus. Keyed by userId. The corpus is
// fetched once per session (or on TTL expiry) and every keystroke filters it
// in-memory — no network call per query.
const datasetCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Traditional → Simplified converter. We canonicalize both the dataset and the
// query into simplified form before substring matching so a user typing 小红帽
// finds chats/messages written as 小紅帽 (and vice versa). Conversion is
// character-level 1:1 for CJK and a no-op for everything else, which lets us
// reuse normalized indices to highlight the original (un-normalized) text.
const t2s = OpenCC.Converter({ from: 'hk', to: 'cn' });
const normalizeForMatch = (s) => (s ? t2s(s.toLowerCase()) : '');

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

      const needleNorm = normalizeForMatch(trimmed);

      const filterAndSet = (dataset) => {
        if (cancelled) return;

        // Two passes: title-only matches (deduped per chat, one entry each) come
        // first; then per-message content matches. Dataset is newest-first
        // (firebase.js orders by timestamp desc), so the first message we see
        // for a given chatId is its most recent — perfect representative for a
        // title-only hit. Matching uses the pre-normalized fields so simplified
        // and traditional Chinese cross-match.
        const titleMatchesByChat = new Map();
        const contentMatches = [];
        for (const m of dataset) {
          const contentHit = m.contentNorm && m.contentNorm.includes(needleNorm);
          if (contentHit) {
            contentMatches.push({ ...m, matchType: 'content' });
            continue;
          }
          const titleHit = m.chatTitleNorm && m.chatTitleNorm.includes(needleNorm);
          if (titleHit && !titleMatchesByChat.has(m.chatId)) {
            titleMatchesByChat.set(m.chatId, { ...m, matchType: 'title' });
          }
        }

        const titleMatches = Array.from(titleMatchesByChat.values());
        const filtered = [...titleMatches, ...contentMatches].slice(0, 50);
        console.log(
          `[SearchResults] query="${trimmed}" matched ${titleMatches.length} chat title(s) ` +
          `+ ${contentMatches.length} message(s) of ${dataset.length} total`
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

        // Pre-compute normalized (lowercase + traditional→simplified) variants
        // once per cache fill. CJK normalization is character-level 1:1 so
        // indices in *Norm align with the original text — used by the
        // highlighter below to mark the right characters in the original.
        for (const m of messages) {
          m.contentNorm = normalizeForMatch(m.content);
          m.chatTitleNorm = normalizeForMatch(m.chatTitle);
        }

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
    if (!text || !query.trim()) return text;

    // Match on the normalized form so 小红帽/小紅帽 highlight correctly, but
    // render slices of the original `text` so the user sees their data verbatim.
    // Indices align because CJK normalization is character-level 1:1.
    const textNorm = normalizeForMatch(text);
    const queryNorm = normalizeForMatch(query);
    if (!queryNorm) return text;

    const parts = [];
    let cursor = 0;
    let searchFrom = 0;
    while (true) {
      const found = textNorm.indexOf(queryNorm, searchFrom);
      if (found === -1) {
        parts.push(text.slice(cursor));
        break;
      }
      if (found > cursor) parts.push(text.slice(cursor, found));
      parts.push(
        <mark key={found}>{text.slice(found, found + queryNorm.length)}</mark>
      );
      cursor = found + queryNorm.length;
      searchFrom = cursor;
    }
    return parts;
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
                {highlightText(result.chatTitle || 'Untitled Chat', searchQuery)}
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
