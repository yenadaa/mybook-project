// firebase-messaging-sw.js
importScripts("https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js");

// .env 파일 등을 통해 환경 변수를 설정하는 것이 안전하지만,
// 테스트를 위해 Firebase 설정을 여기에 직접 추가합니다.
const firebaseConfig = {
    apiKey: "AIzaSyAeWQaegsc3H01i8qkNoyFZX6CcaW-iJ2g",
    authDomain: "mybook-d143d.firebaseapp.com",
    projectId: "mybook-d143d",
    storageBucket: "mybook-d143d.firebasestorage.app",
    messagingSenderId: "427068485624",
    appId: "1:427068485624:web:7a4ec49fe9afca7078700d",
    measurementId: "G-N8R4MKD233"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();