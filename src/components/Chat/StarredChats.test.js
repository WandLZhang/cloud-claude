/**
 * The starred view reads the chat list ChatInterface already keeps live, so it opens at once,
 * with no fetch and no loading state, and follows star changes as they happen.
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import StarredChats from './StarredChats';

global.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('../../services/firebase', () => ({
  auth: { currentUser: { uid: 'user-1' } },
  toggleChatStar: async () => {},
}));

let container;
let root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const titles = () => Array.from(container.querySelectorAll('.starred-chat-card h3')).map((h) => h.textContent);

test('lists the starred chats from the live chat list at once, newest star first', async () => {
  const chats = [
    { id: 'a', title: 'Older star', isStarred: true, starredAt: 1, updatedAt: 3 },
    { id: 'b', title: 'Not starred', isStarred: false, updatedAt: 2 },
    { id: 'c', title: 'Newer star', isStarred: true, starredAt: 2, updatedAt: 1 },
  ];
  await act(async () => { root.render(<StarredChats chats={chats} onSelectChat={() => {}} onBack={() => {}} />); });
  expect(container.querySelector('.loading-state')).toBeNull();
  expect(titles()).toEqual(['Newer star', 'Older star']);

  // Unstarring arrives through the same live list.
  const next = chats.map((c) => (c.id === 'c' ? { ...c, isStarred: false, starredAt: null } : c));
  await act(async () => { root.render(<StarredChats chats={next} onSelectChat={() => {}} onBack={() => {}} />); });
  expect(titles()).toEqual(['Older star']);
});
