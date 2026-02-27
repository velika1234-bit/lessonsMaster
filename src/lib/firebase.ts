/// <reference types="vite/client" />
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || ""
};

// Only initialize if API key is present to avoid "invalid-api-key" error on startup
const app = firebaseConfig.apiKey ? initializeApp(firebaseConfig) : null;

export const auth = app ? getAuth(app) : null as any;
export const db = app ? getFirestore(app) : null as any;

if (!firebaseConfig.apiKey) {
  console.warn("Firebase API Key is missing. Please set VITE_FIREBASE_API_KEY in your environment variables.");
}
