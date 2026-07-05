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
import { touchChatOpened } from './firebase';

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
