import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  auth,
  subscribeToChat,
  addMessage,
  createChat,
  updateMessage,
  uploadImage,
  resetConnection
} from '../services/firebase';
import { streamMessageToClaud } from '../services/messageService';
import { runAssistantTurn } from '../services/assistantTurn';
import { chatTitle } from '../components/Chat/format';

/**
 * Put every assistant reply directly under the user message it answers.
 *
 * Timestamp order alone is not enough. Before commit f0eb3d4 the final update overwrote the
 * assistant's timestamp with its COMPLETION time, so shooting the next book page before the
 * previous translation finished left the reply sorted after the next photo — which is why the
 * starred story chats read out of order and the text under a picture is not the text in it.
 * Assistant messages now carry `replyTo`; anchor on that and the display order is correct no
 * matter what the timestamps say. Messages without `replyTo` (older chats) keep their timestamp
 * position, so nothing regresses.
 */
function anchorReplies(sorted) {
  const userIds = new Set(sorted.filter((m) => m.role === 'user').map((m) => m.id));
  const childrenOf = new Map();
  for (const m of sorted) {
    if (m.replyTo && userIds.has(m.replyTo)) {
      if (!childrenOf.has(m.replyTo)) childrenOf.set(m.replyTo, []);
      childrenOf.get(m.replyTo).push(m);
    }
  }
  if (childrenOf.size === 0) return sorted;

  const anchored = [];
  for (const m of sorted) {
    if (m.replyTo && userIds.has(m.replyTo)) continue;   // emitted under its parent instead
    anchored.push(m);
    const kids = childrenOf.get(m.id);
    if (kids) anchored.push(...kids);
  }
  return anchored;
}

const NO_MESSAGES = [];

// How long a reply the stream has finished may wait for Firestore to confirm it before the page
// resets its Firestore connection.
export const STREAM_CONFIRM_MS = 3000;

/**
 * Each reply as the page shows it: Firestore's copy, overlaid with what the function's stream has
 * said about it (`streamed`, by reply id) until Firestore has the outcome (isStreaming false). The
 * stream arrives on the same request that sent the message, so a quiet Firestore connection can no
 * longer hold a finished reply at "thinking".
 */
export function overlayStreamed(messages, streamed) {
  return messages.map((m) => {
    const s = m.role === 'assistant' ? streamed[m.id] : null;
    if (!s || m.isStreaming === false) return m;
    return {
      ...m,
      content: (s.content || '').length >= (m.content || '').length ? s.content : m.content,
      isStreaming: !s.done,
      status: s.done ? null : (s.status ?? m.status ?? null),
      error: s.error ?? m.error,
      thinking: s.thinking ?? m.thinking,
      thinkingSeconds: s.thinkingSeconds ?? m.thinkingSeconds,
      model: s.model ?? m.model,
      citations: s.citations ?? m.citations,
      streamUpdatedAt: s.at ? { toDate: () => new Date(s.at) } : m.streamUpdatedAt,
    };
  });
}

export function useChat(userId, selectedChatId = null, selectedChatConfig = {}) {
  // The messages Firestore delivered last, and the chat they belong to.
  const [loaded, setLoaded] = useState({ chatId: null, messages: NO_MESSAGES });
  const [chatConfig, setChatConfig] = useState(selectedChatConfig); // Store chat-level config (e.g., disableThinking)
  // Each chat opened in this session keeps its last messages here, so reopening it shows them at
  // once while its listener catches up.
  const cacheRef = useRef(new Map());
  const messagesRef = useRef(NO_MESSAGES);
  const chatConfigRef = useRef(selectedChatConfig);
  // What the function's stream has said about each reply this session, by reply id. Chunks reach the
  // screen at most every 100 ms; done and error at once.
  const [streamed, setStreamed] = useState({});
  const streamedRef = useRef({});
  const flushTimerRef = useRef(null);
  const resetForRef = useRef(new Set());

  // The URL names the open chat (selectedChatId). Until that chat's first snapshot arrives, show
  // what this session kept of it, never the chat shown before.
  const currentChatId = selectedChatId;
  const firestoreMessages = loaded.chatId === currentChatId
    ? loaded.messages
    : (cacheRef.current.get(currentChatId) || NO_MESSAGES);
  const messages = useMemo(() => overlayStreamed(firestoreMessages, streamed), [firestoreMessages, streamed]);
  const loading = !!currentChatId && loaded.chatId !== currentChatId && !cacheRef.current.has(currentChatId);

  const onStreamEvent = useCallback((messageId, event) => {
    const prev = streamedRef.current[messageId] || { content: '', done: false };
    const at = Date.now();
    let next = prev;
    if (event.type === 'chunk') next = { ...prev, content: prev.content + (event.text || ''), at };
    else if (event.type === 'status') next = { ...prev, status: event.status, at };
    else if (event.type === 'done') {
      next = { ...prev, done: true, content: event.content ?? prev.content, thinking: event.thinking,
        thinkingSeconds: event.thinkingSeconds, model: event.model, citations: event.citations, at };
    } else if (event.type === 'error') next = { ...prev, done: true, error: event.error, at };
    else if (event.type === 'lost' && !resetForRef.current.has(messageId)) {
      // The phone likely changed networks mid-reply. The function still saves the reply; a fresh
      // Firestore connection brings it in.
      resetForRef.current.add(messageId);
      console.warn('[useChat] lost the stream of', messageId, '; resetting the Firestore connection');
      resetConnection().catch((e) => console.error('[useChat] resetting the Firestore connection failed:', e));
    }
    streamedRef.current = { ...streamedRef.current, [messageId]: next };
    const flush = () => { flushTimerRef.current = null; setStreamed(streamedRef.current); };
    if (event.type === 'done' || event.type === 'error') {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      flush();
    } else if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(flush, 100);
    }
  }, []);

  // A reply the stream finished that Firestore still shows as streaming after STREAM_CONFIRM_MS
  // means its connection has gone quiet: reset it, once per reply.
  useEffect(() => {
    const waiting = firestoreMessages.filter((m) => m.role === 'assistant' && m.isStreaming !== false
      && streamed[m.id]?.done && !resetForRef.current.has(m.id));
    if (waiting.length === 0) return undefined;
    const timer = setTimeout(() => {
      waiting.forEach((m) => resetForRef.current.add(m.id));
      console.warn('[useChat] Firestore has not confirmed finished replies; resetting its connection:', waiting.map((m) => m.id));
      resetConnection().catch((e) => console.error('[useChat] resetting the Firestore connection failed:', e));
    }, STREAM_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [firestoreMessages, streamed]);
  
  // Keep chatConfigRef in sync with chatConfig state
  useEffect(() => {
    chatConfigRef.current = chatConfig;
  }, [chatConfig]);
  
  // Update chatConfig when selectedChatConfig changes (e.g., when switching to existing chat)
  useEffect(() => {
    if (selectedChatConfig && Object.keys(selectedChatConfig).length > 0) {
      console.log('[useChat] Updating chatConfig from selectedChatConfig:', selectedChatConfig);
      setChatConfig(selectedChatConfig);
    }
  }, [selectedChatConfig]);
  
  // Keep messagesRef in sync with messages state
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (!userId || !currentChatId) return undefined;

    let unsubscribe = null;
    let updateTimeoutId = null;
    let first = true;

    const timeoutId = setTimeout(() => {
      unsubscribe = subscribeToChat(userId, currentChatId, (newMessages) => {
        // Clear any pending update
        if (updateTimeoutId) {
          clearTimeout(updateTimeoutId);
        }

        // The first snapshot shows at once; later ones (a streaming reply writes often) are
        // debounced to prevent rendering issues.
        const delay = first ? 0 : 50;
        first = false;
        updateTimeoutId = setTimeout(() => {
          // Sort by timestamp, then pull every reply under the message it answers.
          const byTime = [...newMessages].sort((a, b) => {
            // Handle both Date objects and Firestore timestamps
            const timeA = a.timestamp?.toDate ? a.timestamp.toDate() : new Date(a.timestamp);
            const timeB = b.timestamp?.toDate ? b.timestamp.toDate() : new Date(b.timestamp);
            return timeA - timeB;
          });
          const sortedMessages = anchorReplies(byTime);

          // Check if any message just finished streaming
          const wasStreaming = messagesRef.current.some(msg => msg.isStreaming);
          const nowNotStreaming = !sortedMessages.some(msg => msg.isStreaming);
          
          if (wasStreaming && nowNotStreaming) {
            // Force a final sort when streaming completes
            console.log('Streaming completed, locking message order');
          }
          
          cacheRef.current.set(currentChatId, sortedMessages);
          setLoaded({ chatId: currentChatId, messages: sortedMessages });
        }, delay);
      });
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      if (updateTimeoutId) {
        clearTimeout(updateTimeoutId);
      }
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [userId, currentChatId]);

  /**
   * Create the assistant placeholder and run the turn. The chat function saves the reply to
   * Firestore itself, so closing the page mid-turn no longer loses the answer (assistantTurn.js).
   *
   * One implementation for both the new-chat and existing-chat paths — they used to be copy-pasted,
   * which is how the timestamp-overwrite bug survived in one branch after being fixed in the other.
   */
  const streamAssistantTurn = useCallback((turn) => runAssistantTurn({ userId, ...turn }, {
    addMessage,
    updateMessage,
    getIdToken: () => {
      if (!auth.currentUser) throw new Error('Not signed in');
      return auth.currentUser.getIdToken();
    },
    stream: streamMessageToClaud,
    onEvent: onStreamEvent,
  }), [userId, onStreamEvent]);

  /**
   * `ids` lets the caller name the documents up front so it can show the message before the writes
   * finish: { userMessageId } for any send, plus { newChat: true, chatId } for a new chat.
   */
  const sendMessage = useCallback(async (content, image, newChatConfig = {}, ids = {}) => {
    if (!userId || (!content.trim() && !image && !newChatConfig.document)) return;

    try {
      let chatId = ids.newChat ? ids.chatId : currentChatId;
      let isNewChat = false;

      // Use the latest messages from ref to avoid stale closure. A new chat starts empty, whatever
      // chat this hook showed last.
      const currentMessages = ids.newChat ? [] : messagesRef.current;

      // Merge stored config with new config (new values override stored ones)
      const effectiveConfig = ids.newChat ? { ...newChatConfig } : { ...chatConfigRef.current, ...newChatConfig };

      // Create chat only on first message
      if (!chatId || ids.newChat) {
        // Include config in chat document for persistence across reloads
        // An automatic title; the chat function replaces it with a short AI title unless the user
        // renames the chat first (titleSource 'manual').
        const chatData = { title: chatTitle(content, !!image), titleSource: 'auto' };
        if (newChatConfig.disableThinking) chatData.disableThinking = true;
        if (newChatConfig.useFastModel) chatData.useFastModel = true;
        if (newChatConfig.enableWebSearch) chatData.enableWebSearch = true;
        if (newChatConfig.systemPrompt) chatData.systemPrompt = newChatConfig.systemPrompt;
        
        chatId = await createChat(userId, chatData, ids.chatId || null);
        setChatConfig(newChatConfig); // Store config for subsequent messages
        isNewChat = true;
      }

      // Add user message
      const userMessage = {
        role: 'user',
        content,
        timestamp: new Date(),
      };

      // Upload image if present
      if (image && image.file) {
        try {
          const uploadedImage = await uploadImage(userId, image.file);
          userMessage.image = uploadedImage;
        } catch (error) {
          console.error('Error uploading image:', error);
          throw new Error('Failed to upload image. Please try again.');
        }
      }

      // Upload document (PDF) if present
      if (newChatConfig.document && newChatConfig.document.file) {
        try {
          const uploadedDoc = await uploadImage(userId, newChatConfig.document.file);
          userMessage.document = uploadedDoc;
          // Add document to the effective config for the API call
          effectiveConfig.document = uploadedDoc;
        } catch (error) {
          console.error('Error uploading document:', error);
          throw new Error('Failed to upload document. Please try again.');
        }
      }

      // Pass web search flag through config
      if (newChatConfig.enableWebSearch) {
        effectiveConfig.enableWebSearch = true;
      }

      const userMessageId = await addMessage(userId, chatId, userMessage, ids.userMessageId || null);

      const turn = {
        chatId,
        userMessageId,
        history: currentMessages,
        content,
        image: userMessage.image,
        config: effectiveConfig,
      };

      // If this is a new chat, return immediately so the UI can navigate
      if (isNewChat) {
        // Stream Claude's response asynchronously (don't wait for it)
        streamAssistantTurn(turn).catch((error) => {
          console.error('Error getting Claude response:', error);
        });
        return { chatId, isNewChat };
      }

      await streamAssistantTurn(turn);
      return { chatId, isNewChat };

    } catch (error) {
      console.error('Error sending message:', error);
      throw error;
    }
  }, [userId, currentChatId, streamAssistantTurn]);

  // Ask again for a reply to `userMessage`, as a new reply under it; the earlier reply stays.
  // `history` is every message before `userMessage`.
  const retryReply = useCallback(async (userMessage, history) => {
    if (!userId || !currentChatId) return;
    const config = { ...chatConfigRef.current };
    if (userMessage.document) config.document = userMessage.document;
    await streamAssistantTurn({
      chatId: currentChatId,
      userMessageId: userMessage.id,
      history,
      content: userMessage.content || '',
      image: userMessage.image,
      config,
    });
  }, [userId, currentChatId, streamAssistantTurn]);

  return {
    messages,
    sendMessage,
    retryReply,
    loading,
    currentChatId,
  };
}
