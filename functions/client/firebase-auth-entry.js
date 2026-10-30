// Firebase browser SDK is bundled into TruX Code's own static assets at image build time.
// This removes the run-time dependency on loading Firebase modules from gstatic.com.
export { initializeApp } from 'firebase/app';
export {
  initializeAuth,
  inMemoryPersistence,
  browserPopupRedirectResolver,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  EmailAuthProvider,
  linkWithCredential,
  signOut
} from 'firebase/auth';
