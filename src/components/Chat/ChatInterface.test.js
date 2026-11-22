/**
 * Which view ChatInterface shows for a URL, across navigations.
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

// An in-memory Firestore: chat list, messages, and their snapshot listeners.
const mockDb = { chats: [], chatListeners: new Set(), messages: {}, messageListeners: {}, nextChat: 0, nextMsg: 0, clock: 100 };

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
  Promise.resolve().then(mockEmitChats);   // Firestore delivers the first snapshot asynchronously
  return () => mockDb.chatListeners.delete(cb);
}

function mockSubscribeMessages(chatId, cb) {
  if (!mockDb.messageListeners[chatId]) mockDb.messageListeners[chatId] = new Set();
  mockDb.messageListeners[chatId].add(cb);
  Promise.resolve().then(() => mockEmitMessages(chatId));
  return () => mockDb.messageListeners[chatId].delete(cb);
}

async function mockCreateChat(data) {
  const id = `chat-new-${++mockDb.nextChat}`;
  mockDb.chats.push({ id, ...data, updatedAt: ++mockDb.clock });
  mockEmitChats();
  return id;
}

async function mockAddMessage(chatId, message) {
  const id = `msg-${++mockDb.nextMsg}`;
  if (!mockDb.messages[chatId]) mockDb.messages[chatId] = [];
  mockDb.messages[chatId].push({ id, ...message, timestamp: ++mockDb.clock });
  const chat = mockDb.chats.find((c) => c.id === chatId);
  if (chat) Object.assign(chat, { lastMessage: message.content, updatedAt: ++mockDb.clock });
  mockEmitMessages(chatId);
  mockEmitChats();
  return id;
}

async function mockTouchChatOpened(chatId) {
  const chat = mockDb.chats.find((c) => c.id === chatId);
  if (chat) chat.updatedAt = ++mockDb.clock;
  // No delivery here: the test delivers this snapshot at the point the browser does.
}

jest.mock('../../services/firebase', () => ({
  auth: { currentUser: { getIdToken: async () => 'test-id-token' } },
  createChat: (userId, data) => mockCreateChat(data),
  addMessage: (userId, chatId, message) => mockAddMessage(chatId, message),
  updateMessage: async () => {},
  deleteMessage: async () => {},
  uploadImage: async () => ({ url: 'mock://image' }),
  touchChatOpened: (userId, chatId) => mockTouchChatOpened(chatId),
  subscribeToUserChats: (userId, cb) => mockSubscribeChats(cb),
  subscribeToChat: (userId, chatId, cb) => mockSubscribeMessages(chatId, cb),
  logOut: async () => {},
}));

jest.mock('../../services/messageService', () => ({
  streamMessageToClaud: async function* streamStub() { yield { type: 'done', content: '' }; },
}));

// Stand-ins for the heavy children. ChatInput becomes a button that sends "hello".
jest.mock('./MessageList', () => {
  const React = require('react');
  return function MessageListStub({ messages }) {
    return React.createElement('div', { className: 'messages-stub' }, messages.map((m) => (
      React.createElement('div', { key: m.id, className: `message-${m.role}` }, m.content)
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
  Object.assign(mockDb, { chats: [], chatListeners: new Set(), messages: {}, messageListeners: {}, nextChat: 0, nextMsg: 0, clock: 100 });
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
