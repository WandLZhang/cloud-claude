// Factory mocks: every Firebase submodule firebase.js imports is stubbed so the
// module loads without touching real Firebase, and so we can assert call args.
jest.mock('firebase/app', () => ({ initializeApp: jest.fn() }));
jest.mock('firebase/auth', () => ({
  getAuth: jest.fn(),
  GoogleAuthProvider: jest.fn(),
  signInWithPopup: jest.fn(),
  signOut: jest.fn(),
}));
jest.mock('firebase/firestore', () => ({
  getFirestore: jest.fn(),
  collection: jest.fn(),
  collectionGroup: jest.fn(),
  doc: jest.fn(),
  setDoc: jest.fn(),
  getDocs: jest.fn(),
  addDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  startAfter: jest.fn(),
  onSnapshot: jest.fn(),
  serverTimestamp: jest.fn(),
}));
jest.mock('firebase/storage', () => ({
  getStorage: jest.fn(),
  ref: jest.fn(),
  uploadBytes: jest.fn(),
  getDownloadURL: jest.fn(),
}));

import * as firestore from 'firebase/firestore';
import { touchChatOpened, newChatId, newMessageId, createChat, addMessage, subscribeToChat, subscribeToUserChats } from './firebase';

describe('touchChatOpened', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    firestore.doc.mockReturnValue('DOC_REF');
    firestore.serverTimestamp.mockReturnValue('SERVER_TS');
    firestore.updateDoc.mockResolvedValue(undefined);
  });

  test('writes a fresh updatedAt to the correct conversation doc', async () => {
    await touchChatOpened('user-1', 'chat-9');

    // doc(db, 'chats', userId, 'conversations', chatId) — db is the first arg,
    // assert the path segments after it.
    const docArgs = firestore.doc.mock.calls[0];
    expect(docArgs.slice(1)).toEqual(['chats', 'user-1', 'conversations', 'chat-9']);

    expect(firestore.updateDoc).toHaveBeenCalledTimes(1);
    expect(firestore.updateDoc).toHaveBeenCalledWith('DOC_REF', { updatedAt: 'SERVER_TS' });
  });

  test('never throws and logs when the write fails', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    firestore.updateDoc.mockRejectedValueOnce(new Error('permission-denied'));

    await expect(touchChatOpened('user-1', 'chat-9')).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();

    errSpy.mockRestore();
  });
});

describe('preset ids, so the page can show a message before Firestore confirms it', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    firestore.collection.mockImplementation((db, ...path) => `COLL:${path.join('/')}`);
    // doc(collectionRef) makes a new id; doc(db, ...path) names an existing document.
    firestore.doc.mockImplementation((first, ...path) => (path.length ? `DOC:${path.join('/')}` : { id: `new-id-for:${first}` }));
    firestore.serverTimestamp.mockReturnValue('SERVER_TS');
    firestore.setDoc.mockResolvedValue(undefined);
    firestore.updateDoc.mockResolvedValue(undefined);
  });

  test('newChatId and newMessageId come from Firestore without a write', () => {
    expect(newChatId('user-1')).toBe('new-id-for:COLL:chats/user-1/conversations');
    expect(newMessageId('user-1', 'chat-9')).toBe('new-id-for:COLL:chats/user-1/conversations/chat-9/messages');
    expect(firestore.setDoc).not.toHaveBeenCalled();
  });

  test('createChat with a preset id writes that document', async () => {
    await expect(createChat('user-1', { title: 'Hi' }, 'chat-9')).resolves.toBe('chat-9');
    expect(firestore.setDoc).toHaveBeenCalledWith('DOC:chats/user-1/conversations/chat-9',
      { title: 'Hi', createdAt: 'SERVER_TS', updatedAt: 'SERVER_TS' });
    expect(firestore.addDoc).not.toHaveBeenCalled();
  });

  test('addMessage with a preset id writes that message and updates the chat', async () => {
    await expect(addMessage('user-1', 'chat-9', { role: 'user', content: 'hello' }, 'msg-3')).resolves.toBe('msg-3');
    expect(firestore.setDoc).toHaveBeenCalledWith('DOC:chats/user-1/conversations/chat-9/messages/msg-3',
      { role: 'user', content: 'hello', userId: 'user-1', timestamp: 'SERVER_TS' });
    expect(firestore.updateDoc).toHaveBeenCalledWith('DOC:chats/user-1/conversations/chat-9',
      { lastMessage: 'hello', updatedAt: 'SERVER_TS' });
    expect(firestore.addDoc).not.toHaveBeenCalled();
  });
});

// Until the server confirms a write, Firestore reads a serverTimestamp() field as null unless the
// reader asks for an estimate. A null timestamp sorted a just-sent message or reply to the top.
describe('the listeners read an unconfirmed server timestamp as the local estimate', () => {
  const localSnapshot = (field) => ({
    docs: [{ id: 'doc-1', data: (options) => ({ [field]: options?.serverTimestamps === 'estimate' ? 'LOCAL_ESTIMATE' : null }) }],
  });

  test('subscribeToChat', () => {
    firestore.onSnapshot.mockImplementation((q, listener) => { listener(localSnapshot('timestamp')); return () => {}; });
    const received = [];
    subscribeToChat('user-1', 'chat-9', (messages) => received.push(...messages));
    expect(received).toEqual([{ id: 'doc-1', timestamp: 'LOCAL_ESTIMATE' }]);
  });

  test('subscribeToUserChats', () => {
    firestore.onSnapshot.mockImplementation((q, listener) => { listener(localSnapshot('updatedAt')); return () => {}; });
    const received = [];
    subscribeToUserChats('user-1', (chats) => received.push(...chats));
    expect(received).toEqual([{ id: 'doc-1', updatedAt: 'LOCAL_ESTIMATE' }]);
  });
});
