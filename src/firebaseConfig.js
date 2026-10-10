/* jshint esversion: 11 */
/* jshint module: true */

import { initializeApp } from 'firebase/app';
import {
  initializeFirestore,
  memoryLocalCache,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  addDoc,
  onSnapshot,
  deleteDoc,
  collectionGroup,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  documentId,
  serverTimestamp,
  writeBatch,   // <-- toegevoegd!
  Timestamp
} from 'firebase/firestore';

import {
  getAuth,
  signOut,
  signInWithEmailAndPassword
} from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';

import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject
} from 'firebase/storage';
import { readClientEnvironment } from './config/clientEnvironment';

const { firebaseConfig, authPolicy } = readClientEnvironment(import.meta.env);

const app = initializeApp(firebaseConfig);
// Reception computers can be shared. Hotel data must not survive in a persistent browser cache.
const db = initializeFirestore(app, { localCache: memoryLocalCache() });
const auth = getAuth(app);
const functions = getFunctions(app);
const storage = getStorage(app);

// Firestore exports
export {
  db,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  addDoc,
  onSnapshot,
  deleteDoc,
  collectionGroup,
  query,
  where,
  orderBy,
  limit,
  startAfter,
  documentId,
  serverTimestamp,
  writeBatch,  // <-- toegevoegd!
  Timestamp,
  storage,
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
  auth,
  functions,
  httpsCallable,
  signOut,
  signInWithEmailAndPassword,
  authPolicy
};
