import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import {
getAuth,
GoogleAuthProvider,
signOut,
onAuthStateChanged,
getRedirectResult,
signInWithRedirect,
signInWithPopup
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";

import {
getFirestore,
doc,
setDoc,
updateDoc,
getDoc,
getDocs,
collection,
addDoc,
onSnapshot,
query,
where,
orderBy,
Timestamp,
deleteDoc,
writeBatch
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL,deleteObject} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-functions.js";
import { getMessaging, getToken } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging.js";


const firebaseConfig = {
apiKey: "AIzaSyAeWQaegsc3H01i8qkNoyFZX6CcaW-iJ2g",
authDomain: "mybook-d143d.web.app",
projectId: "mybook-d143d",
storageBucket: "mybook-d143d.firebasestorage.app", 
messagingSenderId: "427068485624",
appId: "1:427068485624:web:7a4ec49fe9afca7078700d",
measurementId: "G-N8R4MKD233"
};

// --- Firebase 서비스 초기화 ---
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);
const messaging = getMessaging(app);
const provider = new GoogleAuthProvider();
const functions = getFunctions(app, 'asia-northeast3');



// --- 다른 모듈에서 사용할 수 있도록 내보내기 ---

export {
    // 인스턴스
    app, db, auth, storage, functions, provider, messaging,

    // Auth
    GoogleAuthProvider, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged, signInWithPopup,

    // Firestore
    doc, setDoc, updateDoc, getDoc, getDocs, collection, addDoc, onSnapshot, query, where, orderBy, Timestamp,
    deleteDoc,
    writeBatch,

    // Storage
    ref, uploadBytes, getDownloadURL, deleteObject, 

    // Functions
    httpsCallable,
    
    // Messaging
    getToken
};
