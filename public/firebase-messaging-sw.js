// Firebase SDK 스크립트를 가져옵니다.
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

// .env 파일이나 다른 방법을 통해 환경 변수를 설정했다면 여기에 Firebase 설정을 넣습니다.
// 이 정보는 웹 앱의 초기화 코드와 동일해야 합니다.
const firebaseConfig = {
  apiKey: "AIzaSyAeWQaegsc3H01i8qkNoyFZX6CcaW-iJ2g",
  authDomain: "mybook-d143d.firebaseapp.com",
  projectId: "mybook-d143d",
  storageBucket: "gs://mybook-d143d.firebasestorage.app",
  messagingSenderId: "427068485624",
  appId: "1:427068485624:web:7a4ec49fe9afca7078700d",
  measurementId: "G-N8R4MKD233"
};

// Firebase 앱을 초기화합니다.
firebase.initializeApp(firebaseConfig);

// Firebase Messaging 인스턴스를 가져옵니다.
const messaging = firebase.messaging();

// (선택 사항) 백그라운드에서 메시지를 처리하는 핸들러
messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);
  
  // 알림을 커스터마이징합니다.
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: '/firebase-logo.png' // public 폴더에 아이콘 이미지가 있다면 경로를 지정할 수 있습니다.
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});