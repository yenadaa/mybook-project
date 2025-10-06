import {
    auth, provider, signInWithPopup, signOut, onAuthStateChanged,
    messaging, getToken, db, doc, setDoc // 필요한 모듈들을 모두 임포트합니다.
} from "./A.firebase.js";

const $ = (id) => document.getElementById(id);
const loginBtn  = $("login-btn");
const logoutBtn = $("logout-btn");
const userInfo  = $("user-info");
const userEmail = $("user-email");
let currentUser = null;

// 푸시 알림 권한 요청 및 FCM 토큰 저장 함수
async function requestPermissionAndSaveToken(user) {
    try {
        // 1. 사용자에게 알림 권한을 요청합니다.
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            console.log('알림 권한이 허용되었습니다.');
            
            // 2. FCM 토큰을 가져옵니다. VAPID 키를 사용합니다.
            const fcmToken = await getToken(messaging, { vapidKey: 'BJUxXLJCZi0NhC-HHQwAx3zYgTpPsoD5smYhRSOQw81-_Ciiw_r_yJRyPuYNHItyfLjIXlQkHcxo7pyXsb-YVHg' });
            
            if (fcmToken) {
                console.log("FCM 토큰 확보:", fcmToken);
                // 3. Firestore의 'users' 컬렉션에 토큰을 저장합니다.
                const userDocRef = doc(db, "users", user.uid);
                await setDoc(userDocRef, { fcmToken: fcmToken }, { merge: true });
                console.log('FCM 토큰이 Firestore에 저장되었습니다.');
            } else {
                console.log('FCM 토큰을 가져올 수 없습니다. 브라우저 설정(푸시 차단 등)을 확인하세요.');
            }
        } else {
            console.log('알림 권한이 거부되었습니다.');
        }
    } catch (error) {
        console.error("토큰 검색 중 오류 발생: ", error);
    }
}

// 로그인 상태 변경 감지 리스너
onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if (user) {
        // 로그인 상태 UI 업데이트
        userEmail.textContent = user.displayName || user.email;
        userInfo.classList.remove("hidden");
        loginBtn.classList.add("hidden");
        
        // 로그인 성공 시, 알림 권한 요청 및 토큰 저장 함수 호출
        requestPermissionAndSaveToken(user);
    } else {
        // 로그아웃 상태 UI 업데이트
        userEmail.textContent = "";
        userInfo.classList.add("hidden");
        loginBtn.classList.remove("hidden");
    }
    // 다른 모듈(예: main.js)에 상태 변경을 알리기 위한 커스텀 이벤트 발생
    document.dispatchEvent(new CustomEvent('authStateChanged', { detail: { user } }));
});

// 로그인 버튼 이벤트 리스너
loginBtn?.addEventListener("click", async () => {
    try {
        await signInWithPopup(auth, provider);
    } catch (e) {
        console.error("로그인 실패:", e);
    }
});

// 로그아웃 버튼 이벤트 리스너
logoutBtn?.addEventListener("click", async () => {
    try {
        await signOut(auth);
    } catch (e) {
        console.error("로그아웃 실패:", e);
    }
});

// 현재 로그인된 사용자 정보를 다른 모듈에서 사용할 수 있도록 export
export function getCurrentUser() {
    return currentUser;
}
