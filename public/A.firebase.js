// A.firebase.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { 
    getFirestore, 
    initializeFirestore,
    collection, addDoc, getDocs, doc, setDoc, deleteDoc, writeBatch,
    query, orderBy, limit, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"; 
import { 
    getAuth, 
    onAuthStateChanged 
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

// ⭐️ [수정 1] 여기서 httpsCallable을 가져와야 합니다.
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

import { getMessaging, isSupported } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js"; 

const firebaseConfig = {
    apiKey: "AIzaSyAeWQaegsc3H01i8qkNoyFZX6CcaW-iJ2g", // (본인 키 유지)
    authDomain: "mybook-d143d.web.app",
    projectId: "mybook-d143d",
    storageBucket: "mybook-d143d.firebasestorage.app",
    messagingSenderId: "427068485624",
    appId: "1:427068485624:web:7a4ec49fe9afca7078700d",
    measurementId: "G-N8R4MKD233"
};

const app = initializeApp(firebaseConfig);

// DB (Long Polling 강제 설정)
const db = initializeFirestore(app, {
    experimentalForceLongPolling: true,
});

const auth = getAuth(app);
const storage = getStorage(app);
const functions = getFunctions(app);

// Messaging 안전 초기화
let messaging = null;
async function initMessaging() {
  try {
    const supported = await isSupported();
    if (supported) {
      messaging = getMessaging(app);
      console.log("✅ FCM 지원 환경");
    } else {
      console.warn("⚠️ FCM 미지원 환경 (시크릿 모드 등)");
    }
  } catch (e) {
    console.warn("⚠️ FCM 초기화 오류:", e);
  }
}
initMessaging();

// ⭐️ [수정 2] export 목록에 httpsCallable을 꼭 넣어줘야 다른 파일들이 갖다 씁니다!
export { 
    app, auth, db, storage, functions, messaging,
    collection, addDoc, getDocs, doc, setDoc, deleteDoc, writeBatch,
    query, orderBy, limit, Timestamp,
    onAuthStateChanged,
    httpsCallable 
};