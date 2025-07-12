import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  GoogleAuthProvider, 
  signInWithPopup, 
  signOut,
  onAuthStateChanged 
} from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  doc, 
  setDoc, 
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp 
} from 'firebase/firestore';

const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_FIREBASE_APP_ID
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Auth providers
const googleProvider = new GoogleAuthProvider();

// Auth functions
export const signInWithGoogle = async () => {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    // Save user to Firestore
    const user = result.user;
    await setDoc(doc(db, 'users', user.uid), {
      uid: user.uid,
      displayName: user.displayName,
      email: user.email,
      photoURL: user.photoURL,
      lastLogin: serverTimestamp()
    }, { merge: true });
    return user;
  } catch (error) {
    console.error('Error signing in with Google:', error);
    throw error;
  }
};

export const logOut = () => signOut(auth);

// Firestore functions for chats
export const createChat = async (userId, chatData) => {
  try {
    const chatRef = await addDoc(collection(db, 'chats', userId, 'conversations'), {
      ...chatData,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return chatRef.id;
  } catch (error) {
    console.error('Error creating chat:', error);
    throw error;
  }
};

export const getChatHistory = async (userId, chatId) => {
  try {
    const messagesRef = collection(db, 'chats', userId, 'conversations', chatId, 'messages');
    const q = query(messagesRef, orderBy('timestamp', 'asc'));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('Error getting chat history:', error);
    return [];
  }
};

export const getUserChats = async (userId) => {
  try {
    const chatsRef = collection(db, 'chats', userId, 'conversations');
    const q = query(chatsRef, orderBy('updatedAt', 'desc'));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('Error getting user chats:', error);
    return [];
  }
};

export const addMessage = async (userId, chatId, message) => {
  try {
    // Add message to subcollection
    const docRef = await addDoc(collection(db, 'chats', userId, 'conversations', chatId, 'messages'), {
      ...message,
      timestamp: serverTimestamp()
    });
    
    // Update chat's last message and timestamp
    await updateDoc(doc(db, 'chats', userId, 'conversations', chatId), {
      lastMessage: message.content,
      updatedAt: serverTimestamp()
    });
    
    return docRef.id;
  } catch (error) {
    console.error('Error adding message:', error);
    throw error;
  }
};

export const updateMessage = async (userId, chatId, messageId, updates) => {
  try {
    // Update message in subcollection
    await updateDoc(
      doc(db, 'chats', userId, 'conversations', chatId, 'messages', messageId), 
      updates
    );
    
    // If content is being updated, also update the chat's last message
    if (updates.content !== undefined) {
      await updateDoc(doc(db, 'chats', userId, 'conversations', chatId), {
        lastMessage: updates.content,
        updatedAt: serverTimestamp()
      });
    }
  } catch (error) {
    console.error('Error updating message:', error);
    throw error;
  }
};

export const updateChatTitle = async (userId, chatId, newTitle) => {
  try {
    await updateDoc(doc(db, 'chats', userId, 'conversations', chatId), {
      title: newTitle,
      updatedAt: serverTimestamp()
    });
  } catch (error) {
    console.error('Error updating chat title:', error);
    throw error;
  }
};

export const deleteChat = async (userId, chatId) => {
  try {
    await deleteDoc(doc(db, 'chats', userId, 'conversations', chatId));
  } catch (error) {
    console.error('Error deleting chat:', error);
    throw error;
  }
};

export const toggleChatStar = async (userId, chatId, isStarred) => {
  try {
    await updateDoc(doc(db, 'chats', userId, 'conversations', chatId), {
      isStarred: isStarred,
      starredAt: isStarred ? serverTimestamp() : null,
      updatedAt: serverTimestamp()
    });
  } catch (error) {
    console.error('Error toggling chat star:', error);
    throw error;
  }
};

export const getStarredChats = async (userId) => {
  try {
    const chatsRef = collection(db, 'chats', userId, 'conversations');
    const q = query(
      chatsRef, 
      where('isStarred', '==', true), 
      orderBy('starredAt', 'desc')
    );
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('Error getting starred chats:', error);
    return [];
  }
};

// Real-time listeners
export const subscribeToChat = (userId, chatId, callback) => {
  const messagesRef = collection(db, 'chats', userId, 'conversations', chatId, 'messages');
  const q = query(messagesRef, orderBy('timestamp', 'asc'));
  
  return onSnapshot(q, (snapshot) => {
    const messages = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    callback(messages);
  });
};

export const subscribeToUserChats = (userId, callback) => {
  const chatsRef = collection(db, 'chats', userId, 'conversations');
  const q = query(chatsRef, orderBy('updatedAt', 'desc'));
  
  return onSnapshot(q, (snapshot) => {
    const chats = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    callback(chats);
  });
};
