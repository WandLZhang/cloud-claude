/**
 * Which view ChatInterface shows for a URL, across navigations, and what a send shows before
 * Firestore has saved it.
 *
 * React Router's BrowserRouter applies each navigation inside React.startTransition, so a URL
 * change lands after the app's ordinary state updates. Opening a chat writes its `updatedAt`
 * (touchChatOpened), and Firestore delivers the chat list again from that local write. In the
 * browser that delivery renders while the location is still "/". These tests replay that order
 * with a router whose navigations the test applies by hand.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Router } from 'react-router-dom';
import AppRoutes from '../../AppRoutes';

global.IS_REACT_ACT_ENVIRONMENT = true;

// An in-memory Firestore: chat list, messages, their snapshot listeners, and a switch that holds
// every write until the test releases it.
const mockDb = {};

function mockReset() {
  Object.assign(mockDb, {
    chats: [], chatListeners: new Set(), messages: {}, messageListeners: {},
    nextChat: 0, nextMsg: 0, clock: 100, holdWrites: false, held: [], streamCalls: [],
    holdChatList: false, holdMessageLists: false, listRenders: [],
  });
}

function mockEmitChats() {
  const list = [...mockDb.chats].sort((a, b) => b.updatedAt - a.updatedAt).map((c) => ({ ...c }));
  mockDb.chatListeners.forEach((cb) => cb(list));
}

function mockEmitMessages(chatId) {
  const list = (mockDb.messages[chatId] || []).map((m) => ({ ...m }));
  (mockDb.messageListeners[chatId] || new Set()).forEach((cb) => cb(list));
}

function mockSubscribeChats(cb) {
  mockDb.chatListeners.add(cb);
  // Firestore delivers the first snapshot asynchronously; holdChatList keeps it on the network.
  if (!mockDb.holdChatList) Promise.resolve().then(mockEmitChats);
  return () => mockDb.chatListeners.delete(cb);
}

function mockSubscribeMessages(chatId, cb) {
  if (!mockDb.messageListeners[chatId]) mockDb.messageListeners[chatId] = new Set();
  mockDb.messageListeners[chatId].add(cb);
  if (!mockDb.holdMessageLists) Promise.resolve().then(() => mockEmitMessages(chatId));
  return () => mockDb.messageListeners[chatId].delete(cb);
}

function mockWrite(apply) {
  if (!mockDb.holdWrites) return Promise.resolve(apply());
  return new Promise((resolve) => mockDb.held.push(() => resolve(apply())));
}

function mockReleaseWrites() {
  mockDb.holdWrites = false;
  const held = mockDb.held;
  mockDb.held = [];
  held.forEach((run) => run());
}

function mockCreateChat(data, presetId) {
  return mockWrite(() => {
    const id = presetId || `chat-new-${++mockDb.nextChat}`;
    mockDb.chats.push({ id, ...data, updatedAt: ++mockDb.clock });
    mockEmitChats();
    return id;
  });
}

function mockAddMessage(chatId, message, presetId) {
  return mockWrite(() => {
    const id = presetId || `msg-${++mockDb.nextMsg}`;
    if (!mockDb.messages[chatId]) mockDb.messages[chatId] = [];
    mockDb.messages[chatId].push({ id, ...message, timestamp: ++mockDb.clock });
    const chat = mockDb.chats.find((c) => c.id === chatId);
    if (chat) Object.assign(chat, { lastMessage: message.content, updatedAt: ++mockDb.clock });
    mockEmitMessages(chatId);
    mockEmitChats();
    return id;
  });
}

async function mockTouchChatOpened(chatId) {
  const chat = mockDb.chats.find((c) => c.id === chatId);
  if (chat) chat.updatedAt = ++mockDb.clock;
  // No delivery here: the test delivers this snapshot at the point the browser does.
}

jest.mock('../../services/firebase', () => ({
  auth: { currentUser: { getIdToken: async () => 'test-id-token' } },
  newChatId: () => `chat-new-${++mockDb.nextChat}`,
  newMessageId: () => `msg-${++mockDb.nextMsg}`,
  createChat: (userId, data, chatId) => mockCreateChat(data, chatId),
  addMessage: (userId, chatId, message, messageId) => mockAddMessage(chatId, message, messageId),
  updateMessage: async () => {},
  deleteMessage: async () => {},
  toggleChatStar: async () => {},
  uploadImage: async () => ({ url: 'mock://image' }),
  touchChatOpened: (userId, chatId) => mockTouchChatOpened(chatId),
  subscribeToUserChats: (userId, cb) => mockSubscribeChats(cb),
  subscribeToChat: (userId, chatId, cb) => mockSubscribeMessages(chatId, cb),
  logOut: async () => {},
}));

jest.mock('../../services/messageService', () => ({
  streamMessageToClaud: async function* streamStub(...args) {
    mockDb.streamCalls.push(args);
    yield { type: 'done', content: '' };
  },
}));

// Stand-ins for the heavy children. ChatInput becomes a button that sends "hello"; the message
// list logs every render and shows a Retry button on the reply ChatInterface marks as the latest.
jest.mock('./MessageList', () => {
  const React = require('react');
  return function MessageListStub({ messages, latestReplyId, onRetry, chatId }) {
    mockDb.listRenders.push({ chatId, ids: messages.map((m) => m.id) });
    return React.createElement('div', { className: 'messages-stub' }, messages.map((m) => (
      React.createElement('div', { key: m.id, className: `message-${m.role}` }, m.content,
        m.id === latestReplyId && onRetry
          ? React.createElement('button', { 'data-testid': 'retry', onClick: () => onRetry(m) }, 'retry')
          : null)
    )));
  };
});
jest.mock('./ChatInput', () => {
  const React = require('react');
  return function ChatInputStub({ onSendMessage, disabled }) {
    return React.createElement('button', { 'data-testid': 'send', disabled, onClick: () => onSendMessage('hello', null, {}) }, 'send');
  };
});
jest.mock('./ChatSidebar', () => () => null);
jest.mock('./StarredChats', () => () => null);
jest.mock('../Home/SavedPrompts', () => () => null);
jest.mock('../Auth/UserMenu', () => () => null);

const USER = { uid: 'user-1', displayName: 'Test User', photoURL: null };

// An async act flushes React's work only when its callback resolves, so a chain of effect ->
// timer -> state update (useChat subscribes 50 ms after a chat opens) needs several short acts.
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
  }
}

// Records navigations instead of applying them; the test applies each one with renderAt.
function makeNavigator() {
  const pathOf = (to) => (typeof to === 'string' ? to : `${to.pathname || ''}${to.search || ''}${to.hash || ''}`);
  const nav = {
    held: [],
    createHref: pathOf,
    go: () => {},
    push: (to, state) => nav.held.push({ to: pathOf(to), state, replace: false }),
    replace: (to, state) => nav.held.push({ to: pathOf(to), state, replace: true }),
  };
  return nav;
}

let container;
let root;

async function renderAt(pathname, nav) {
  await act(async () => {
    root.render(
      <Router location={{ pathname, search: '', hash: '', state: null, key: pathname }} navigator={nav}>
        <AppRoutes user={USER} onThemeToggle={() => {}} theme="light" />
      </Router>
    );
  });
  await settle();
}

const texts = (selector) => Array.from(container.querySelectorAll(selector)).map((el) => el.textContent);

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};   // jsdom doesn't implement it; ChatInterface scrolls on every update
});

beforeEach(() => {
  mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test('sending from the home page opens the new conversation', async () => {
  mockDb.chats.push({ id: 'chat-old', title: 'Older chat', updatedAt: 1 });
  const nav = makeNavigator();
  await renderAt('/', nav);
  expect(container.querySelector('.home-page')).not.toBeNull();

  await act(async () => { container.querySelector('[data-testid="send"]').click(); });
  await settle();
  expect(nav.held.map((n) => n.to)).toEqual(['/chat/chat-new-1']);

  // touchChatOpened's snapshot arrives while the location is still "/".
  await act(async () => { mockEmitChats(); });
  await settle();

  // Then React Router applies the new URL.
  await renderAt('/chat/chat-new-1', nav);
  expect(container.querySelector('.home-page')).toBeNull();
  expect(texts('.message-user')).toEqual(['hello']);
  // The chat starts with an automatic title, which the chat function may replace.
  expect(mockDb.chats.find((c) => c.id === 'chat-new-1')).toMatchObject({ title: 'hello', titleSource: 'auto' });
});

test('a message sent from the home page shows at once, before Firestore saves it', async () => {
  mockDb.chats.push({ id: 'chat-old', title: 'Older chat', updatedAt: 1 });
  mockDb.holdWrites = true;
  const nav = makeNavigator();
  await renderAt('/', nav);

  await act(async () => { container.querySelector('[data-testid="send"]').click(); });
  await settle(2);
  expect(nav.held.map((n) => n.to)).toEqual(['/chat/chat-new-1']);
  expect(mockDb.chats.map((c) => c.id)).toEqual(['chat-old']);   // nothing written yet

  await renderAt('/chat/chat-new-1', nav);
  expect(texts('.message-user')).toEqual(['hello']);
  expect(container.querySelectorAll('.message-assistant')).toHaveLength(1);   // the reply placeholder

  await act(async () => { mockReleaseWrites(); });
  await settle();
  expect(texts('.message-user')).toEqual(['hello']);   // the saved copy replaces the pending one
  expect(container.querySelectorAll('.message-assistant')).toHaveLength(1);
});

test('Retry on the latest reply asks again for that question, with the history before it', async () => {
  mockDb.chats.push({ id: 'chat-old', title: 'Older chat', updatedAt: 1 });
  mockDb.messages['chat-old'] = [
    { id: 'u1', role: 'user', content: 'first question', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: 'first answer', replyTo: 'u1', timestamp: 2 },
    { id: 'u2', role: 'user', content: 'second question', timestamp: 3 },
    { id: 'a2', role: 'assistant', content: '', error: 'overloaded', isStreaming: false, replyTo: 'u2', timestamp: 4 },
  ];
  await renderAt('/chat/chat-old', makeNavigator());

  await act(async () => { container.querySelector('[data-testid="retry"]').click(); });
  await settle();
  const placeholder = mockDb.messages['chat-old'].find((m) => m.role === 'assistant' && m.replyTo === 'u2' && m.id !== 'a2');
  expect(placeholder).toMatchObject({ isStreaming: true, content: '' });
  const [history, content] = mockDb.streamCalls[0];
  expect(history.map((m) => m.id)).toEqual(['u1', 'a1']);
  expect(content).toBe('second question');
});

test('a link to a conversation opens it once the chat list loads', async () => {
  mockDb.chats.push({ id: 'chat-old', title: 'Older chat', updatedAt: 1 });
  mockDb.messages['chat-old'] = [{ id: 'm1', role: 'user', content: 'earlier question', timestamp: 1 }];
  await renderAt('/chat/chat-old', makeNavigator());
  expect(container.querySelector('.home-page')).toBeNull();
  expect(texts('.message-user')).toEqual(['earlier question']);
});

test('a link to a conversation that no longer exists goes home', async () => {
  mockDb.chats.push({ id: 'chat-old', title: 'Older chat', updatedAt: 1 });
  const nav = makeNavigator();
  await renderAt('/chat/deleted-chat', nav);
  expect(nav.held.map((n) => n.to)).toEqual(['/']);
});

test('the first screen waits for the chat list instead of filling in', async () => {
  mockDb.chats.push({ id: 'chat-old', title: 'Older chat', updatedAt: 1 });
  mockDb.holdChatList = true;
  await renderAt('/', makeNavigator());
  expect(container.querySelector('.home-page')).toBeNull();
  expect(container.querySelector('.first-load')).not.toBeNull();

  await act(async () => { mockDb.holdChatList = false; mockEmitChats(); });
  await settle();
  expect(container.querySelector('.first-load')).toBeNull();
  expect(texts('.recent-chat-card h4')).toEqual(['Older chat']);
});

test("a conversation link's first screen waits for its messages", async () => {
  mockDb.chats.push({ id: 'chat-old', title: 'Older chat', updatedAt: 1 });
  mockDb.messages['chat-old'] = [{ id: 'm1', role: 'user', content: 'earlier question', timestamp: 1 }];
  mockDb.holdMessageLists = true;
  await renderAt('/chat/chat-old', makeNavigator());
  expect(container.querySelector('.chat-container')).toBeNull();

  await act(async () => { mockDb.holdMessageLists = false; mockEmitMessages('chat-old'); });
  await settle();
  expect(texts('.message-user')).toEqual(['earlier question']);
});

test('switching conversations never shows the previous one, and a reopened one shows at once', async () => {
  mockDb.chats.push({ id: 'chat-a', title: 'Chat A', updatedAt: 2 }, { id: 'chat-b', title: 'Chat B', updatedAt: 1 });
  mockDb.messages['chat-a'] = [{ id: 'a1', role: 'user', content: 'question a', timestamp: 1 }];
  mockDb.messages['chat-b'] = [{ id: 'b1', role: 'user', content: 'question b', timestamp: 2 }];
  const nav = makeNavigator();
  await renderAt('/chat/chat-a', nav);
  expect(texts('.message-user')).toEqual(['question a']);

  // From here the network holds every message list, so only what the page kept can show.
  mockDb.holdMessageLists = true;
  await renderAt('/chat/chat-b', nav);
  const underB = mockDb.listRenders.filter((r) => r.chatId === 'chat-b');
  expect(underB.length).toBeGreaterThan(0);
  expect(underB.filter((r) => r.ids.includes('a1'))).toEqual([]);

  await renderAt('/chat/chat-a', nav);
  expect(texts('.message-user')).toEqual(['question a']);
});
