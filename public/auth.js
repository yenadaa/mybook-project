// A.firebase.js 파일로부터 필요한 함수들을 가져옵니다.
import {
    auth, provider,
    signInWithPopup, // 변경점 1: signInWithRedirect 대신 signInWithPopup을 가져옵니다.
    getRedirectResult,
    signOut, onAuthStateChanged,
    messaging, getToken, db, doc, setDoc
} from "./A.firebase.js";

let currentUser = null;

// "HTML 문서 로딩이 완료되면, 이 안의 코드를 실행해주세요"
document.addEventListener("DOMContentLoaded", () => {

    const $ = (id) => document.getElementById(id);
    const loginBtn  = $("login-btn");
    const logoutBtn = $("logout-btn");
    const userInfo  = $("user-info");
    const userEmail = $("user-email");

    // --- 이벤트 리스너 등록 ---

    if (loginBtn) {
        // 변경점 2: 로그인 버튼 클릭 시 팝업으로 로그인을 시도합니다.
        loginBtn.addEventListener("click", () => {
            console.log("팝업으로 로그인 시도.");
            signInWithPopup(auth, provider)
                .then((result) => {
                    // 성공 시 onAuthStateChanged가 자동으로 호출되어 UI를 업데이트합니다.
                    console.log("✅ 팝업 로그인 성공!", result.user);
                })
                .catch((error) => {
                    // 실패 시 에러를 콘솔에 출력합니다.
                    console.error("❌ 팝업 로그인 실패:", error);
                    console.error("에러 코드:", error.code);
                    console.error("에러 메시지:", error.message);
                });
        });
    }

    if (logoutBtn) {
        logoutBtn.addEventListener("click", () => {
            signOut(auth).catch(e => console.error("로그아웃 실패:", e));
        });
    }

    // --- Firebase 인증 상태 리스너 ---

    // 변경점 3: 팝업 방식 테스트 중에는 리디렉션 결과 확인 로직이 필요 없으므로 주석 처리합니다.
    /*
    getRedirectResult(auth)
        .then((result) => {
            if (result) {
                console.log("리디렉션을 통해 로그인 성공:", result.user);
            }
        }).catch((error) => {
            console.error("리디렉션 로그인 실패:", error);
        });
    */

    // 로그인/로그아웃 상태 변경 감지 (이 부분은 수정할 필요 없습니다)
    onAuthStateChanged(auth, (user) => {
        currentUser = user;
        if (user) {
            // 로그인 상태 UI 업데이트
            userEmail.textContent = user.displayName || user.email;
            userInfo.classList.remove("hidden");
            if(loginBtn) loginBtn.classList.add("hidden");
            
            // 로그인 성공 시, 알림 권한 요청 및 토큰 저장
            requestPermissionAndSaveToken(user);
        } else {
            // 로그아웃 상태 UI 업데이트
            userEmail.textContent = "";
            userInfo.classList.add("hidden");
            if(loginBtn) loginBtn.classList.remove("hidden");
        }
        // 다른 모듈에 상태 변경 알림
        document.dispatchEvent(new CustomEvent('authStateChanged', { detail: { user } }));
    });

});


// --- 푸시 알림 권한 및 토큰 저장 함수 ---
async function requestPermissionAndSaveToken(user) {
    try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            const fcmToken = await getToken(messaging, { vapidKey: 'BJUxXLJCZi0NhC-HHQwAx3zYgTpPsoD5smYhRSOQw81-_Ciiw_r_yJRyPuYNHItyfLjIXlQkHcxo7pyXsb-YVHg' });
            if (fcmToken) {
                const userDocRef = doc(db, "users", user.uid);
                await setDoc(userDocRef, { fcmToken: fcmToken }, { merge: true });
                console.log('FCM 토큰이 Firestore에 저장되었습니다.');
            }
        }
    } catch (error) {
        console.error("FCM 토큰 처리 중 오류 발생: ", error);
    }
}

// --- 외부에서 사용할 함수 내보내기 ---
export function getCurrentUser() {
    return currentUser;
}