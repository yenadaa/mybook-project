// firebase-messaging-sw.js
// 이 파일은 index.html과 같은 최상위 폴더에 있어야 합니다.

// Firebase SDK 스크립트 임포트 (v8 호환 라이브러리)
// (참고: 서비스 워커는 v9 모듈 방식(import)보다 이 방식(importScripts)을 더 권장합니다)
importScripts("https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js");
importScripts("https://www.gstatic.com/firebasejs/8.10.1/firebase-messaging.js");

// A.firebase.js와 동일한 Firebase 설정
const firebaseConfig = {
    apiKey: "AIzaSyAeWQaegsc3H01i8qkNoyFZX6CcaW-iJ2g",
    authDomain: "mybook-d143d.web.app", // 👈 모바일 로그인을 위해 수정한 'web.app' 주소
    projectId: "mybook-d143d",
    storageBucket: "mybook-d143d.firebasestorage.app", 
    messagingSenderId: "427068485624",
    appId: "1:427068485624:web:7a4ec49fe9afca7078700d",
    measurementId: "G-N8R4MKD233"
};

// Firebase 앱 초기화
firebase.initializeApp(firebaseConfig);

const messaging = firebase.messaging();

/**
 * (선택사항) 백엔드(Cloud Function)에서 보낸 푸시 알림을
 * 브라우저가 받아서 화면에 표시하기 직전에 가로채는 핸들러입니다.
 * 알림에 'urlToOpen' 같은 커스텀 데이터를 추가할 수 있습니다.
 */
messaging.onBackgroundMessage((payload) => {
    console.log("[SW] 백그라운드 메시지 수신: ", payload);

    // 백엔드에서 보낸 notification 데이터 (없으면 기본값)
    const notificationTitle = payload.notification?.title || 'MyBook 알림';
    const notificationOptions = {
        body: payload.notification?.body || '새로운 알림이 있습니다.',
        icon: '/favicon.ico', // TODO: 앱 아이콘 경로가 있다면 수정 (예: /icons/icon-192.png)
        
        // 👇 [중요] 알림에 데이터를 숨겨둡니다.
        // 이 data 객체는 'notificationclick' 이벤트로 전달됩니다.
        data: {
            // 백엔드가 'data: { url: "/quiz-highlights" }' 처럼 보내주면
            // 그 URL을 사용하고, 아니면 홈페이지('/')로 이동
            urlToOpen: payload.data?.urlToOpen || '/' 
        }
    };

    // 알림을 화면에 표시합니다.
    return self.registration.showNotification(notificationTitle, notificationOptions);
});

/**
 * 👇 [핵심] 사용자가 알림을 '클릭'했을 때 실행되는 핸들러입니다.
 */
self.addEventListener('notificationclick', (event) => {
    console.log('[SW] 알림 클릭됨: ', event);

    // 알림 닫기
    event.notification.close();

    // 1. (가장 좋은 방법)
    // 백엔드가 보낸 데이터(onBackgroundMessage에서 설정)에 
    // "이동할 URL"이 포함되어 있는지 확인합니다.
    let clickUrl = event.notification.data?.urlToOpen;

    // 2. (팀원 요청)
    // 만약 "하이라이트 기반 퀴즈 페이지"가 고정된 주소이고,
    // 백엔드 데이터와 상관없이 '무조건' 그 페이지로 보내려면
    // 아래 주석을 풀고 경로를 수정하세요.
    /*
    const highlightQuizUrl = '/quiz-page.html'; // 👈 [수정] 퀴즈 페이지의 실제 경로
    clickUrl = highlightQuizUrl; 
    */

    // 3. (안전장치)
    // 열 URL이 없다면 (백엔드도 안 보냈고, 위에서 강제로 설정하지도 않았다면)
    // 그냥 홈페이지(메인 페이지)로 이동합니다.
    if (!clickUrl) {
        clickUrl = '/'; 
    }

    // 새 창(탭)으로 해당 URL 열기
    // (만약 이미 열려있는 탭이 있으면 그 탭을 찾아서 포커스합니다)
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then((clientList) => {
            
            // 이미 열려있는 탭 찾기
            for (const client of clientList) {
                // 주소창의 URL이 clickUrl로 끝나는지 확인
                if (client.url.endsWith(clickUrl) && 'focus' in client) {
                    return client.focus();
                }
            }
            
            // 새 탭(창) 열기
            if (clients.openWindow) {
                return clients.openWindow(clickUrl);
            }
        })
    );
});