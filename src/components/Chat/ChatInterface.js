import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import MessageList from './MessageList';
import ChatInput from './ChatInput';
import ChatSidebar from './ChatSidebar';
import HomePage from '../Home/HomePage';
import StarredChats from './StarredChats';
import Header from '../Layout/Header';
import LoadingSpinner from '../Common/LoadingSpinner';
import { useChat } from '../../hooks/useChat';
import { useFirestore } from '../../hooks/useFirestore';
import { updateMessage, deleteMessage, touchChatOpened, toggleChatStar, newChatId, newMessageId } from '../../services/firebase';
import { mergePending, waitingPending, chatTitle } from './format';
import './ChatInterface.css';

const FIRST_LOAD_WAIT_MS = 1500;

function ChatInterface({ user, onThemeToggle, theme }) {
  const { chatId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [isThinking, setIsThinking] = useState(false);
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pendingChat, setPendingChat] = useState(null); // a chat opened before the chat list has it
  const [pending, setPending] = useState([]); // sent messages Firestore hasn't confirmed yet
  const [targetMessageId, setTargetMessageId] = useState(null);
  const [scrollTrigger, setScrollTrigger] = useState(0);
  const messagesEndRef = useRef(null);

  const { userChats, loading: chatsLoading } = useFirestore(user.uid);

  // The URL alone decides the view and the open chat. React Router applies each navigation
  // inside startTransition, after ordinary state updates. A view kept in its own state could be
  // reset by a render that still saw the old URL: sending from the home page left you on the
  // home page while the reply streamed into the new chat.
  const viewMode = location.pathname === '/starred' ? 'starred' : chatId ? 'chat' : 'home';
  const currentChat = useMemo(() => {
    if (!chatId) return null;
    return userChats.find((c) => c.id === chatId) || (pendingChat?.id === chatId ? pendingChat : null);
  }, [chatId, userChats, pendingChat]);

  // Extract chat config from currentChat (e.g., disableThinking for "Everyday Chinese" chats)
  // Use useMemo to prevent creating new object reference on every render (avoids infinite loop)
  const currentChatConfig = useMemo(() => {
    const config = {};
    if (currentChat?.disableThinking) config.disableThinking = true;
    if (currentChat?.useFastModel) config.useFastModel = true;
    if (currentChat?.enableWebSearch) config.enableWebSearch = true;
    if (currentChat?.systemPrompt) config.systemPrompt = currentChat.systemPrompt;
    return config;
  }, [currentChat?.disableThinking, currentChat?.useFastModel, currentChat?.enableWebSearch, currentChat?.systemPrompt]);
  
  const { messages, sendMessage, retryReply, loading } = useChat(user.uid, chatId, currentChatConfig);
  const previousMessagesLength = useRef(0);
  const isStreamingRef = useRef(false);

  // A sent message shows at once, with a placeholder for its reply, until Firestore delivers the
  // saved copies; a photo no longer holds the message back until its upload finishes.
  const shownMessages = useMemo(
    () => mergePending(messages, pending.filter((p) => p.chatId === chatId)),
    [messages, pending, chatId]
  );
  const latestReplyId = shownMessages.length && shownMessages[shownMessages.length - 1].role === 'assistant'
    ? shownMessages[shownMessages.length - 1].id
    : null;

  // The first screen waits for the chat list and, on a chat link, that chat's messages, so it
  // appears whole instead of filling in piece by piece. A slow network gets it after
  // FIRST_LOAD_WAIT_MS anyway.
  const firstContentReady = !chatsLoading && !(viewMode === 'chat' && currentChat && loading);
  const [firstLoadDone, setFirstLoadDone] = useState(false);
  useEffect(() => {
    if (firstLoadDone) return undefined;
    if (firstContentReady) {
      setFirstLoadDone(true);
      return undefined;
    }
    const id = setTimeout(() => setFirstLoadDone(true), FIRST_LOAD_WAIT_MS);
    return () => clearTimeout(id);
  }, [firstContentReady, firstLoadDone]);

  useEffect(() => {
    setPending((prev) => {
      const mine = prev.filter((p) => p.chatId === chatId);
      if (mine.length === 0) return prev;
      const waiting = new Set(waitingPending(messages, mine));
      const next = prev.filter((p) => p.chatId !== chatId || waiting.has(p));
      return next.length === prev.length ? prev : next;
    });
  }, [messages, chatId]);

  const addPending = (forChatId, userMessageId, content, image, document) => {
    const sentAt = new Date();
    setPending((prev) => [
      ...prev,
      {
        id: userMessageId, chatId: forChatId, role: 'user', content, timestamp: sentAt, pending: true,
        ...(image && { image: { url: image.url, type: image.type } }),
        ...(document && { document: { name: document.name } }),
      },
      {
        id: `pending-reply-${userMessageId}`, chatId: forChatId, role: 'assistant', content: '',
        isStreaming: true, replyTo: userMessageId, timestamp: sentAt, pending: true,
      },
    ]);
  };

  const dropPending = (userMessageId) => {
    setPending((prev) => prev.filter((p) => p.id !== userMessageId && p.replyTo !== userMessageId));
  };

  const scrollToBottom = (behavior = 'smooth') => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior, block: 'end' });
    }
    // Also try scrolling the container directly as a fallback
    const container = document.querySelector('.messages-container');
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  };

  // Scroll when messages change
  useEffect(() => {
    if (messages.length === 0) return;
    
    // Don't scroll to bottom if we have a target message
    if (targetMessageId) {
      console.log('[ChatInterface] Skipping scroll to bottom - targetMessageId is set:', targetMessageId);
      return;
    }

    // Check if we're streaming (last message has isStreaming flag)
    const lastMessage = messages[messages.length - 1];
    const isCurrentlyStreaming = lastMessage?.isStreaming === true;
    
    // Determine if this is initial load or new messages
    const isInitialLoad = previousMessagesLength.current === 0 && messages.length > 0;
    const hasNewMessages = messages.length > previousMessagesLength.current;
    
    // Use instant scroll for streaming, smooth for other cases
    const scrollBehavior = isCurrentlyStreaming ? 'auto' : 'smooth';
    
    // Increase delay for initial load to ensure proper rendering
    const scrollDelay = isInitialLoad ? 300 : 0;
    
    console.log('[ChatInterface] Scheduling scroll to bottom - delay:', scrollDelay, 'streaming:', isCurrentlyStreaming);
    
    const timeoutId = setTimeout(() => {
      console.log('[ChatInterface] Executing scrollToBottom from messages effect');
      scrollToBottom(scrollBehavior);
    }, scrollDelay);

    // Update refs
    previousMessagesLength.current = messages.length;
    isStreamingRef.current = isCurrentlyStreaming;

    return () => clearTimeout(timeoutId);
  }, [messages, targetMessageId]);

  // Additional scroll trigger specifically for chat switching
  useEffect(() => {
    if (currentChat?.id && messages.length > 0 && !targetMessageId) {
      console.log('[ChatInterface] Chat switch scroll triggered - chatId:', currentChat.id);
      
      // Multiple attempts to ensure scrolling works
      // Immediate attempt
      console.log('[ChatInterface] Immediate scrollToBottom on chat switch');
      scrollToBottom('auto');
      
      // After next frame
      requestAnimationFrame(() => {
        console.log('[ChatInterface] RequestAnimationFrame scrollToBottom');
        scrollToBottom('auto');
      });
      
      // After a delay
      const timeoutId = setTimeout(() => {
        console.log('[ChatInterface] 500ms timeout scrollToBottom');
        scrollToBottom('auto');
      }, 500);
      
      return () => clearTimeout(timeoutId);
    } else if (targetMessageId) {
      console.log('[ChatInterface] Skipping chat switch scroll - targetMessageId is set:', targetMessageId);
    }
  }, [currentChat?.id, messages, targetMessageId]);

  // Reset message count when chat changes
  useEffect(() => {
    previousMessagesLength.current = 0;
  }, [currentChat?.id]);

  const handleSendMessage = async (content, image, extraOptions = {}) => {
    setError('');
    const userMessageId = newMessageId(user.uid, chatId);
    addPending(chatId, userMessageId, content, image, extraOptions.document);
    setIsThinking(true);

    try {
      await sendMessage(content, image, extraOptions, { userMessageId });
    } catch (err) {
      console.error('Error sending message:', err);
      dropPending(userMessageId);
      setError('Failed to send message. Please try again.');
    } finally {
      setIsThinking(false);
    }
  };

  // A send from the home page names the new chat up front, opens it at once, and shows the message
  // while the chat, the photo and the message are written.
  const handleSendFromHome = async (content, image, chatConfig = {}) => {
    setError('');
    const id = newChatId(user.uid);
    const userMessageId = newMessageId(user.uid, id);
    setPendingChat({
      id,
      title: chatTitle(content, !!image),
      ...(chatConfig.enableWebSearch && { enableWebSearch: true }),
      ...(chatConfig.disableThinking && { disableThinking: true }),
      ...(chatConfig.useFastModel && { useFastModel: true }),
      ...(chatConfig.systemPrompt && { systemPrompt: chatConfig.systemPrompt }),
    });
    addPending(id, userMessageId, content, image, chatConfig.document);
    setSidebarOpen(false);
    setTargetMessageId(null);
    navigate(`/chat/${id}`);
    setIsThinking(true);

    try {
      await sendMessage(content, image, chatConfig, { newChat: true, chatId: id, userMessageId });
    } catch (err) {
      console.error('Error starting chat:', err);
      dropPending(userMessageId);
      setError('Failed to send message. Please try again.');
    } finally {
      setIsThinking(false);
    }
  };

  // Retry asks again for a reply to the question above `reply`, with the history before that
  // question. The earlier reply stays; the new one appears under it.
  const handleRetry = async (reply) => {
    const replyIndex = messages.findIndex((m) => m.id === reply.id);
    let questionIndex = messages.findIndex((m) => m.id === reply.replyTo);
    for (let i = replyIndex - 1; questionIndex < 0 && i >= 0; i -= 1) {
      if (messages[i].role === 'user') questionIndex = i;   // replies saved before replyTo existed
    }
    if (questionIndex < 0) return;
    setError('');
    setIsThinking(true);
    try {
      await retryReply(messages[questionIndex], messages.slice(0, questionIndex));
    } catch (err) {
      console.error('Error retrying reply:', err);
      setError('Retry failed. Please try again.');
    } finally {
      setIsThinking(false);
    }
  };

  const handleToggleStar = async () => {
    if (!currentChat) return;
    try {
      await toggleChatStar(user.uid, currentChat.id, !currentChat.isStarred);
    } catch (err) {
      console.error('Failed to star/unstar chat:', err);
    }
  };

  // sendMessage builds the model's history from useChat's `messagesRef`, which is fed by the
  // Firestore snapshot behind a 50 ms timeout plus a 50 ms debounce. Releasing the next batch item
  // the instant the previous one resolves means turn N+1 is built on history that does not yet
  // contain turn N. Wait for the finished reply to actually land in `messages` first.
  const messagesRefForBatch = useRef(messages);
  useEffect(() => { messagesRefForBatch.current = messages; }, [messages]);

  const waitForSettledReply = (countBefore, timeoutMs = 15000) => new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const now = messagesRefForBatch.current;
      const grew = now.length > countBefore;
      const quiet = !now.some((m) => m.isStreaming);
      if ((grew && quiet) || Date.now() - started > timeoutMs) return resolve();
      setTimeout(tick, 120);
    };
    tick();
  });

  const handleBatchRelease = async (items) => {
    setError('');
    setIsThinking(true);
    let processed = 0;
    try {
      for (const item of items) {
        try {
          const countBefore = messagesRefForBatch.current.length;
          // Reconstruct File from data URL if needed (sessionStorage path)
          let imageToSend = item.image;
          if (imageToSend && imageToSend.url && !imageToSend.file) {
            try {
              const resp = await fetch(imageToSend.url);
              const blob = await resp.blob();
              const file = new File([blob], imageToSend.name || `batch-${Date.now()}.jpg`, { type: imageToSend.type || blob.type });
              imageToSend = { file, url: imageToSend.url, type: file.type };
            } catch (e) {
              console.error('Failed to reconstruct File from queued image:', e);
              throw new Error('Could not reconstruct queued image');
            }
          }
          await sendMessage(item.content, imageToSend, item.extraOptions);
          await waitForSettledReply(countBefore);
          processed += 1;
        } catch (err) {
          console.error(`Batch item ${processed + 1}/${items.length} failed:`, err);
          setError(`Batch item ${processed + 1} of ${items.length} failed: ${err.message}. Remaining items skipped.`);
          break;
        }
      }
    } finally {
      setIsThinking(false);
    }
  };

  // Drain pending batch items stashed by HomePage during navigation.
  // Wait for the first response to settle before releasing the rest.
  const pendingBatchHandledRef = useRef(false);
  useEffect(() => {
    pendingBatchHandledRef.current = false;
  }, [currentChat?.id]);

  useEffect(() => {
    if (!user?.uid || !currentChat?.id || pendingBatchHandledRef.current) return;
    if (loading || isThinking) return;
    if (!messages || messages.length < 2) return;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role !== 'assistant' || lastMsg.isStreaming) return;

    const key = `pendingBatch-${user.uid}`;
    const stash = sessionStorage.getItem(key);
    if (!stash) return;

    let pending;
    try {
      pending = JSON.parse(stash);
    } catch (e) {
      console.error('Failed to parse pending batch:', e);
      sessionStorage.removeItem(key);
      return;
    }
    if (!Array.isArray(pending) || pending.length === 0) {
      sessionStorage.removeItem(key);
      return;
    }

    pendingBatchHandledRef.current = true;
    sessionStorage.removeItem(key);
    console.log(`[batch] Releasing ${pending.length} pending items into chat ${currentChat.id}`);
    handleBatchRelease(pending);
  }, [user?.uid, currentChat?.id, loading, isThinking, messages]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNewChat = () => {
    setSidebarOpen(false);
    navigate('/');
  };

  const handleStarredChatsClick = () => {
    setSidebarOpen(false);
    navigate('/starred');
  };

  const handleBackFromStarred = () => {
    navigate('/');
  };

  const handleSelectChat = (chat) => {
    // Opening a chat bumps it to the top of the history. Fire-and-forget: the
    // live subscribeToUserChats listener re-sorts locally at once; a failed
    // write must not delay navigation.
    touchChatOpened(user.uid, chat.id);
    setPendingChat(chat);
    setSidebarOpen(false);
    setTargetMessageId(null);
    navigate(`/chat/${chat.id}`);
  };

  const handleSelectSearchResult = async (result) => {
    console.log('[ChatInterface] handleSelectSearchResult called - messageId:', result.messageId);
    
    // First, select the chat
    const chat = userChats.find(c => c.id === result.chatId);
    if (chat) {
      // Opening from a search result also bumps the chat to the top of history.
      touchChatOpened(user.uid, result.chatId);
      // Store the target message ID
      const targetId = result.messageId;
      
      // If we're already on this chat, just set the targetMessageId
      if (chatId === result.chatId) {
        console.log('[ChatInterface] Already on chat, setting targetMessageId:', targetId);
        // Set the target and trigger a new scroll
        setTargetMessageId(targetId);
        setScrollTrigger(Date.now()); // Force re-trigger
        setSidebarOpen(false);
      } else {
        // Otherwise, switch to the chat
        console.log('[ChatInterface] Switching to different chat:', result.chatId);
        setSidebarOpen(false);

        // Set targetMessageId after a delay to ensure messages are loaded
        console.log('[ChatInterface] Scheduling targetMessageId set after 1000ms');
        setTimeout(() => {
          console.log('[ChatInterface] Setting targetMessageId after delay:', targetId);
          setTargetMessageId(targetId);
          setScrollTrigger(Date.now());
        }, 1000);
        
        navigate(`/chat/${result.chatId}`);
      }
    }
  };

  // A link to a chat that isn't in the list (deleted, or not this user's) goes home once the
  // list has loaded.
  useEffect(() => {
    if (chatId && !chatsLoading && !currentChat) navigate('/', { replace: true });
  }, [chatId, chatsLoading, currentChat, navigate]);

  // A navigation can carry the message to scroll to.
  useEffect(() => {
    if (chatId && location.state?.targetMessageId) setTargetMessageId(location.state.targetMessageId);
  }, [chatId, location.state]);

  // Render content based on view mode
  const renderContent = () => {
    switch (viewMode) {
      case 'starred':
        return (
          <StarredChats
            chats={userChats}
            onSelectChat={handleSelectChat}
            onBack={handleBackFromStarred}
          />
        );
      case 'chat':
        if (!currentChat) {
          // The URL names a chat the list hasn't delivered yet (a reload or a shared link).
          return (
            <div className="chat-loading" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <LoadingSpinner />
            </div>
          );
        }
        return (
          <div className="chat-container">
            <MessageList
              key={currentChat.id}
              messages={shownMessages}
              latestReplyId={latestReplyId}
              onRetry={isThinking ? null : handleRetry}
              isThinking={isThinking}
              loading={loading && shownMessages.length === 0}
              onUpdateMessage={updateMessage}
              onDeleteMessage={deleteMessage}
              userId={user.uid}
              chatId={currentChat.id}
              targetMessageId={targetMessageId}
              scrollTrigger={scrollTrigger}
              onScrollComplete={() => setTargetMessageId(null)}
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
              onBatchRelease={handleBatchRelease}
              disabled={loading || isThinking}
              defaultWebSearch={!!currentChatConfig.enableWebSearch}
            />
          </div>
        );
      case 'home':
      default:
        return (
          <HomePage
            user={user}
            onThemeToggle={onThemeToggle}
            theme={theme}
            onSendFromHome={handleSendFromHome}
            userChats={userChats}
            onSelectChat={handleSelectChat}
          />
        );
    }
  };

  if (!firstLoadDone) {
    return (
      <div className="first-load">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="chat-interface-wrapper">
      <ChatSidebar
        userChats={userChats}
        loading={chatsLoading}
        currentChatId={chatId}
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        onOpen={() => setSidebarOpen(true)}
        onStarredChatsClick={handleStarredChatsClick}
        onSelectSearchResult={handleSelectSearchResult}
      />

      <div className="main-pane">
        <Header
          title={viewMode === 'chat' ? (currentChat ? currentChat.title || 'New Chat' : '') : viewMode === 'starred' ? 'Starred' : 'Cloud Claude'}
          onOpenSidebar={() => setSidebarOpen(true)}
          chat={viewMode === 'chat' ? currentChat : null}
          onToggleStar={handleToggleStar}
          onNewChat={viewMode === 'home' ? null : handleNewChat}
          user={viewMode === 'home' ? user : null}
          theme={theme}
          onThemeToggle={onThemeToggle}
        />
        {renderContent()}
      </div>
    </div>
  );
}

export default ChatInterface;
