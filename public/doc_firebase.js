// doc_firebase.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { 
    getAuth, 
    onAuthStateChanged, 
    GoogleAuthProvider, 
    signInWithRedirect, 
    signOut,
    getRedirectResult,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    getIdToken
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { 
    getFirestore, 
    doc, 
    getDoc, 
    setDoc, 
    collection, 
    query, 
    where, 
    getDocs, 
    deleteDoc,
    serverTimestamp,
    onSnapshot,
    addDoc,
    Timestamp,
    updateDoc,
    writeBatch,
    orderBy
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { 
    getStorage, 
    ref as storageRef, 
    uploadBytes as storageUploadBytes,
    getDownloadURL as getStorageDownloadURL,
    deleteObject as storageDeleteObject 
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { 
    getMessaging, 
    getToken, 
    isSupported 
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
import { 
    getFunctions
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

// ⭐️ 님의 Firebase 설정
const firebaseConfig = {
    apiKey: "AIzaSyAeWQaegsc3H01i8qkNoyFZX6CcaW-iJ2g",
    authDomain: "mybook-d143d.web.app",
    projectId: "mybook-d143d",
    storageBucket: "mybook-d143d.firebasestorage.app", 
    messagingSenderId: "427068485624",
    appId: "1:427068485624:web:7a4ec49fe9afca7078700d",
    measurementId: "G-N8R4MKD233"
};

// --- 초기화 ---
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const messaging = getMessaging(app);
const provider = new GoogleAuthProvider();
const functions = getFunctions(app);
// --- 전역 변수 ---
const appId = "default-app-id";
let currentUser = null;
let currentBookId = null;
let unsubscribeDocs = null;
let unsubscribeHighlights = null;
let unsubscribeBookStatus = null; // ⭐️ [파이프라인] 'books' 컬렉션 감시자

// DOM 요소 헬퍼
const $ = (id) => document.getElementById(id);

// --- 인증 및 UI 관리 ---
document.addEventListener("DOMContentLoaded", () => {
    
    // (팝업 차단 경고용 CSS - 님이 추가하신 코드 유지)
    if (!$('custom-alert-style')) {
        const style = document.createElement('style');
        style.id = 'custom-alert-style';
        style.innerHTML = `
            .custom-alert-modal { ... } 
            /* (내용 동일) */
        `;
        document.head.appendChild(style);
    }

    // (리디렉션 로그인 결과 처리 - 님이 추가하신 코드 유지)
    getRedirectResult(auth)
        .then((result) => {
            if (result) {
                console.log("✅ (WEB) 리디렉션 로그인 성공!", result.user);
            } else {
                console.log("페이지 일반 로드 (리디렉션 아님).");
            }
        })
        .catch((error) => {
            console.error("❌ (WEB) 리디렉션 로그인 실패:", error);
            if (error.code === 'auth/account-exists-with-different-credential') {
                alert("이미 다른 방식(예: 이메일)으로 가입된 계정입니다.");
            }
        });
    
    const loginBtn   = $("loginBtn");
    const logoutBtn  = $("logoutBtn");
    const emailInput       = $("email-input");
    const passwordInput    = $("password-input");
    const loginModalOverlay     = $("login-modal-overlay");
    const loginModalBody        = $("login-modal-body");
    const loginModalCloseBtn    = $("login-modal-close-btn");
    const loginModalBackBtn     = $("login-modal-back-btn");
    const loginChoiceView       = $("login-choice-view");
    const emailAuthView         = $("email-auth-view");
    const googleLoginChoiceBtn  = $("google-login-choice-btn");
    const emailLoginChoiceBtn   = $("email-login-choice-btn");
    const emailLoginBtn    = $("email-login-btn");
    const emailSignUpBtn   = $("email-signup-btn");

    // 이ㅁㄹ 로그인 버튼 리스너
    if (loginBtn) {
            loginBtn.addEventListener("click", () => {
                // 구글 로그인을 바로 실행하지 않고, 모달을 엽니다.
                if (loginModalOverlay) {
                    loginModalOverlay.classList.remove("hidden");
                    // 모달을 열 때 항상 '선택' 뷰부터 보이도록
                    if (loginModalBody) loginModalBody.classList.remove("show-email-view");
                }
            });
        }


        if (loginModalCloseBtn) {
        loginModalCloseBtn.addEventListener("click", () => {
            if (loginModalOverlay) loginModalOverlay.classList.add("hidden");
        });
    }
    // 모달 '뒤로' 버튼 (이메일 폼 -> 선택 뷰)
    if (loginModalBackBtn) {
        loginModalBackBtn.addEventListener("click", () => {
            if (loginModalBody) loginModalBody.classList.remove("show-email-view");
        });
    }

    // 모달: '구글 로그인' 선택
    if (googleLoginChoiceBtn) {
        googleLoginChoiceBtn.addEventListener("click", async () => {
            // (기존 툴바 버튼의 로직을 이곳으로 이동)
            const isNativeApp = window.Capacitor && window.Capacitor.isNativePlatform();

            if (isNativeApp) {
                // ... (네이티브 앱 로그인 로직) ...
            } else {
                console.log("✅ WEB: 웹 (Redirect) 로그인 시도.");
                // 모달을 즉시 닫아서 리디렉션 준비
                if (loginModalOverlay) loginModalOverlay.classList.add("hidden"); 
                await signInWithRedirect(auth, provider);
            }
        });
    }

    // 모달: '이메일 로그인' 선택
    if (emailLoginChoiceBtn) {
        emailLoginChoiceBtn.addEventListener("click", () => {
            // 이메일 폼 뷰를 보여줌
            if (loginModalBody) loginModalBody.classList.add("show-email-view");
            // ⬇️ (추가) 이메일 폼으로 자동 포커스
            if (emailInput) emailInput.focus();
        });
    }

    // 로그아웃 버튼 리스너
    if (logoutBtn) {
        logoutBtn.addEventListener("click", () => {
            signOut(auth).catch(e => console.error("로그아웃 실패:", e));
        });
    }
    if (emailLoginBtn) {
        emailLoginBtn.addEventListener("click", async () => {
            const email = emailInput.value;
            const password = passwordInput.value;
            if (!email || !password) {
                alert("이메일과 비밀번호를 입력하세요.");
                return;
            }
            try {
                const userCredential = await signInWithEmailAndPassword(auth, email, password);
                console.log("✅ (Email) 로그인 성공:", userCredential.user);
                // ⬇️ (추가) 성공 시 모달을 닫음
                if (loginModalOverlay) loginModalOverlay.classList.add("hidden");
            } catch (error) {
                console.error("❌ (Email) 로그인 실패:", error);
                handleAuthError(error); 
            }
        });
    }

    //이메일/비밀번호 회원가입 버튼 리스너
    if (emailSignUpBtn) {
            emailSignUpBtn.addEventListener("click", async () => {
                const email = emailInput.value;
                const password = passwordInput.value;
                if (!email || !password) {
                    alert("이메일과 비밀번호를 입력하세요.");
                    return;
                }
                if (password.length < 6) {
                    alert("비밀번호는 6자리 이상이어야 합니다.");
                    return;
                }
                try {
                    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
                    console.log("✅ (Email) 회원가입 성공:", userCredential.user);
                    // ⬇️ (추가) 성공 시 모달을 닫음
                    if (loginModalOverlay) loginModalOverlay.classList.add("hidden");
                } catch (error) {
                    console.error("❌ (Email) 회원가입 실패:", error);
                    handleAuthError(error);
                }
            });
        }

    // 인증 상태 리스너 (핵심)
    onAuthStateChanged(auth, (user) => {
        currentUser = user;
        const userDisplay = $("authStatus");

        if (user) {
            if (userDisplay) userDisplay.textContent = user.displayName || user.email;
            if (loginBtn) loginBtn.style.display = 'none';
            if (logoutBtn) logoutBtn.style.display = 'inline-flex';
            requestPermissionAndSaveToken(user.uid);
            initDocSystem(user.uid);
        } else {
            if (userDisplay) userDisplay.textContent = "로그인 필요";
            if (loginBtn) loginBtn.style.display = 'inline-flex';
            if (logoutBtn) logoutBtn.style.display = 'none';
            initDocSystem(null);
        }
        document.dispatchEvent(new CustomEvent('authStateChanged', { detail: { user } }));
    });
});

// --- 푸시 알림 ---
async function requestPermissionAndSaveToken(uid) {
    if (await isSupported()) {
        try {
            const vapidKey = "BJUxXLJCZi0NhC-HHQwAx3zYgTpPsoD5smYhRSOQw81-_Ciiw_r_yJRyPuYNHItyfLjIXlQkHcxo7pyXsb-YVHg";
            const token = await getToken(messaging, { vapidKey: vapidKey });
            if (token) {
                const userDocRef = doc(db, "users", uid);
                await setDoc(userDocRef, { fcmToken: token }, { merge: true });
                console.log('FCM 토큰이 Firestore에 저장되었습니다.');
            }
        } catch (error) {
            console.error("FCM 토큰 처리 중 오류 발생: ", error);
        }
    } else {
        console.warn("FCM이 이 브라우저에서 지원되지 않습니다.");
    }
}

// --- 뷰어 헬퍼 ---
function showEmptyState() {
    const empty = $("empty");
    const pages = $("pages");
    if (empty) empty.style.display = 'grid';
    if (pages) pages.style.display = 'none';
}
function showPdfPages() {
    const empty = $("empty");
    const pages = $("pages");
    if (empty) empty.style.display = 'none';
    if (pages) pages.style.display = 'grid';
}
function clearViewer() {
    const pages = $("pages");
    if (pages) pages.innerHTML = '';
}

// --- 문서 관리 시스템 ---

export function getCurrentUser() {
    return currentUser;
}
export function getCurrentBookId() {
    return currentBookId;
}

export function initDocSystem(uid) {
    if (unsubscribeDocs) unsubscribeDocs();
    if (unsubscribeHighlights) unsubscribeHighlights();
    if (unsubscribeBookStatus) unsubscribeBookStatus(); // ⭐️ 파이프라인 감시 중단

    const listEl = $("doc-list");
    if (!listEl) { console.error("doc-list element not found."); return; }
    
    if (!uid) {
        resetToHome();
        listEl.innerHTML = '<div class="doc-row" style="padding: 10px; color: var(--muted); text-align: center;">로그인 후 문서를 관리할 수 있습니다.</div>';
        return;
    }

    // 문서 목록 실시간 감시
    const userDocsPath = `artifacts/${appId}/users/${uid}/userDocs`;
    const docsQuery = query(collection(db, userDocsPath), orderBy("createdAt", "desc"));
    
    unsubscribeDocs = onSnapshot(docsQuery,
        (snapshot) => {
            const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            renderDocsList(docs);
        },
        (error) => {
            console.error("Error fetching documents:", error);
            listEl.innerHTML = '<li>문서 로딩 오류.</li>';
        }
    );

    setupDocEventListeners();
}

let docEventListenersAttached = false;
function setupDocEventListeners() {
    if (docEventListenersAttached) return;
    const listEl = $("doc-list");
    const fileInput = $("file");
    if (listEl) listEl.addEventListener('click', handleDocListClick);
    if (fileInput) fileInput.addEventListener('change', handleFileChange);
    docEventListenersAttached = true;
}

async function handleDocListClick(e) {
    const target = e.target;
    const openId = target.closest('[data-open]')?.dataset.open;
    const delId = target.closest('[data-del]')?.dataset.del;
    const addBtn = target.closest('.doc-add');
    if (openId) await openDoc(openId);
    else if (delId) await deleteDocFromDb(delId);
    else if (addBtn) $("file")?.click();
}

async function handleFileChange(e) {
    const file = e.target.files[0];
    if (file) {
        await createDocFromFile(file);
        e.target.value = null;
    }
}

export async function createDocFromFile(file) {
    const user = currentUser;
    if (!file || !user) return alert("로그인 후 파일을 업로드할 수 있습니다.");
    if (!file.type || !file.type.includes('pdf')) return alert("PDF 파일만 업로드할 수 있습니다.");

    let docRef;
    try {
        // 1. Firestore 문서 생성
        const userDocsPath = `artifacts/${appId}/users/${user.uid}/userDocs`;
        docRef = await addDoc(collection(db, userDocsPath), {
            title: file.name,
            createdAt: serverTimestamp()
        });
        const bookId = docRef.id;
        
        // 2. Storage 업로드 (⭐️ 이 경로가 'on_pdf_upload'를 실행시킴)
        const storagePath = `artifacts/${appId}/users/${user.uid}/docs/${bookId}.pdf`;
        const storageRefInstance = storageRef(storage, storagePath);
        await storageUploadBytes(storageRefInstance, file);

        // 3. Firestore 문서에 경로 업데이트
        await updateDoc(docRef, { storagePath: storagePath });

        // 4. 문서 열기
        await openDoc(bookId);

    } catch (error) {
        console.error("File upload failed:", error);
        alert(`파일 업로드 실패: ${error.message}`);
        if (docRef) await deleteDoc(docRef).catch(e => console.error("Rollback failed", e));
    }
}

function renderDocsList(docs) {
    const listEl = $("doc-list");
    if (!listEl) return;
    listEl.innerHTML = '';
    const addButton = document.createElement('button');
    addButton.className = 'doc-add';
    addButton.innerHTML = '➕ 새 문서 추가';
    listEl.appendChild(addButton);
    docs.forEach(docData => {
        const item = document.createElement("div");
        item.className = (docData.id === currentBookId) ? "doc-row active" : "doc-row";
        item.dataset.id = docData.id;
        item.innerHTML = `
            <span class="doc-title" title="${docData.title}">${docData.title}</span>
            <div class="row-actions">
                <button data-open="${docData.id}" title="열기">열기</button>
                <button data-del="${docData.id}" title="삭제">삭제</button>
            </div>
        `;
        listEl.appendChild(item);
    });
}

export async function deleteDocFromDb(docId) {
    const user = currentUser;
    if (!user || !docId) return;
    if (!confirm(`문서 ID ${docId}를 삭제하시겠습니까? 관련된 모든 데이터가 삭제됩니다.`)) return;

    try {
        // 1. Firestore 문서 삭제
        const docRefPath = `artifacts/${appId}/users/${user.uid}/userDocs`;
        await deleteDoc(doc(db, docRefPath, docId));

        // 2. Storage 파일 삭제
        try {
            const storagePath = `artifacts/${appId}/users/${user.uid}/docs/${docId}.pdf`;
            await storageDeleteObject(storageRef(storage, storagePath));
        } catch (e) { console.warn("Storage file delete failed:", e); }

        // 3. 하이라이트 삭제
        const highlightsQuery = query(collection(db, "highlights"), where("bookId", "==", docId), where("userId", "==", user.uid));
        const snapshot = await getDocs(highlightsQuery);
        const batch = writeBatch(db);
        snapshot.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        
        // 4. ⭐️ [파이프라인] 'books' 컬렉션의 처리된 데이터도 삭제
        try {
            await deleteDoc(doc(db, "books", docId));
        } catch (e) { console.warn("Processed data delete failed:", e); }

        if (currentBookId === docId) resetToHome();

    } catch (error) {
        console.error("Document deletion failed:", error);
        alert(`문서 삭제 실패: ${error.message}`);
    }
}

// ⭐️ [수정] openDoc 함수 (파이프라인 감시 기능 포함)
export async function openDoc(bookId) {
    const user = currentUser;
    if (!user || !bookId) return;

    // 1. (기존) 다른 책을 열면, 이전 책의 감시(listener)를 중단
    if (unsubscribeHighlights) unsubscribeHighlights();
    if (unsubscribeBookStatus) unsubscribeBookStatus(); // ⭐️ 파이프라인 감시 중단
    
    currentBookId = bookId;

    // (UI 업데이트)
    document.querySelectorAll('.doc-row').forEach(el => el.classList.remove('active'));
    document.querySelector(`.doc-row[data-id="${bookId}"]`)?.classList.add('active');

    const docRefPath = `artifacts/${appId}/users/${user.uid}/userDocs`;
    const docRef = doc(db, docRefPath, bookId);

    try {
        const docSnap = await getDoc(docRef);
        if (!docSnap.exists()) throw new Error("Document not found in Firestore.");
        
        const docData = docSnap.data();
        if (!docData.storagePath) throw new Error(`Document [${bookId}] is missing storagePath!`);

        const storageRefInstance = storageRef(storage, docData.storagePath);
        showPdfPages();

        const url = await getStorageDownloadURL(storageRefInstance);
        console.log(`PDF Download URL: ${url}`);
        
        // (PDF 다운로드 및 뷰어 렌더링)
        const response = await fetch(url);
        if (!response.ok) throw new Error(`PDF Download Failed: HTTP status ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        
        // (window.renderDocument는 viewer-renderer.js에 있다고 가정)
        if (window.renderDocument) {
            window.renderDocument(arrayBuffer);
        } else {
            console.error("window.renderDocument not found!");
        }

        // (하이라이트 실시간 리스너 설정)
        const highlightsQuery = query(collection(db, "highlights"), where("bookId", "==", bookId), where("userId", "==", user.uid));
        unsubscribeHighlights = onSnapshot(highlightsQuery,
            (snapshot) => {
                const highlightsFromFirestore = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
                if (window.setHighlightsData) {
                    window.setHighlightsData(highlightsFromFirestore);
                }
            },
            (error) => {
                console.error("Error fetching highlights:", error);
                if (window.setHighlightsData) window.setHighlightsData([]);
            }
        );

        // 3. ⭐️ [파이프라인] 'books' 컬렉션을 실시간으로 감시 (onSnapshot)
        const bookStatusRef = doc(db, "books", bookId);
        const createQuizBtn = $("create-quiz-btn"); // main.js에 있어야 함
        if (!createQuizBtn) {
            console.error("감시 실패: 'create-quiz-btn' 버튼을 찾을 수 없습니다.");
            return;
        }

        unsubscribeBookStatus = onSnapshot(bookStatusRef, (doc) => {
            if (!doc.exists()) {
                // (문서는 있지만 'books'에 상태가 없음 = 파이프라인 실행 전)
                createQuizBtn.disabled = true;
                createQuizBtn.textContent = "PDF 처리 중... (최대 9분)";
                console.log(`(파이프라인 감시) 'books/${bookId}' 문서 없음 (파이프라인 대기 중...)`);
            } else {
                const status = doc.data()?.status;
                console.log(`(파이프라인 감시) 'books/${bookId}' 상태 변경: ${status}`);

                if (status === "processed_all_ok") {
                    // ⭐️ 요리 완료!
                    createQuizBtn.disabled = false;
                    createQuizBtn.textContent = "AI 퀴즈/요약 만들기";
                } else if (status === "processing") {
                    // ⭐️ 요리 중!
                    createQuizBtn.disabled = true;
                    createQuizBtn.textContent = "PDF 처리 중... (최대 9분)";
                } else if (status && status.startsWith("error_")) {
                    // ⭐️ 요리 실패!
                    createQuizBtn.disabled = true;
                    createQuizBtn.textContent = "PDF 처리 실패 (재업로드 필요)";
                    console.error("파이프라인 오류:", status);
                } else {
                    // (기타 상태 또는 processedData 없음)
                    createQuizBtn.disabled = true;
                    createQuizBtn.textContent = "PDF 처리 대기 중...";
                }
            }
        });
        if (window.setChatbotEnabled) window.setChatbotEnabled(true);

    } catch (error) {
        console.error("Failed to open document:", error);
        alert(`문서 열기 실패: ${error.message}`);
        resetToHome();
    }
}

// 홈으로 리셋 (뷰어 초기화)
function resetToHome() {
    if (unsubscribeHighlights) unsubscribeHighlights();
    if (unsubscribeBookStatus) unsubscribeBookStatus(); // ⭐️ 파이프라인 감시 중단
    currentBookId = null;

    if (window.clearViewer) window.clearViewer();
    else clearViewer();
    
    showEmptyState();
    if(window.setHighlightsData) window.setHighlightsData([]);
    if (window.setChatbotEnabled) window.setChatbotEnabled(false);
    // ⭐️ [파이프라인] 퀴즈 버튼 초기화
    const createQuizBtn = $("create-quiz-btn");
    if (createQuizBtn) {
        createQuizBtn.disabled = true;
        createQuizBtn.textContent = "문서 열기 필요";
    }
}

// --- 하이라이트 저장 (기존 코드 유지) ---
window.saveHighlightChange = async function(type, highlightData) {
    const user = currentUser;
    const bookId = currentBookId;

    if (!user || !bookId || !highlightData || highlightData.id?.startsWith('local_')) {
        console.warn(`Firestore save/update aborted. Type: ${type}`);
        return;
    }

    const highlightsCol = collection(db, "highlights");

    try {
        if (type === 'add') {
            const now = new Date();
            const nextReviewDate = new Date(now.getTime() + (24 * 60 * 60 * 1000));
            const docData = {
                ...highlightData,
                userId: user.uid,
                bookId: bookId,
                createdAt: serverTimestamp(),
                nextReviewDate: Timestamp.fromDate(nextReviewDate),
                reviewLevel: 1
            };
            delete docData.id;
            const docRef = await addDoc(highlightsCol, docData);
            console.log("Firestore: 새 하이라이트 추가 완료", docRef.id);
            return docRef;
            
        } else if (type === 'update') {
            const docRef = doc(db, "highlights", highlightData.id);
            const updateData = { ...highlightData };

            delete updateData.id;
            delete updateData.userId;
            delete updateData.bookId;
            delete updateData.createdAt;
            updateData.updatedAt = serverTimestamp();

            await updateDoc(docRef, updateData);

        } else if (type === 'delete') {
            const docRef = doc(db, "highlights", highlightData.id);
            await deleteDoc(docRef);
        }
    } catch (error) {
        console.error(`Firestore highlight '${type}' operation failed:`, error);
    }
};
/**
* @param {Error} error Firebase Auth에서 발생한 오류 객체
*/
function handleAuthError(error) {
    console.error("인증 오류 발생:", error.code, error.message);
    switch (error.code) {
        case 'auth/user-not-found':
            alert("존재하지 않는 계정입니다. 이메일을 확인하거나 회원가입을 진행해주세요.");
            break;
        case 'auth/wrong-password':
            alert("비밀번호가 틀렸습니다.");
            break;
        case 'auth/email-already-in-use':
            alert("이미 사용 중인 이메일입니다.");
            break;
        case 'auth/invalid-email':
            alert("유효하지 않은 이메일 주소입니다.");
            break;
        case 'auth/weak-password':
            alert("비밀번호가 너무 약합니다. (최소 6자 이상)");
            break;
        default:
            alert(`로그인/회원가입 중 오류가 발생했습니다: ${error.message}`);
    }
}

/**
 * RAG 챗봇 백엔드(ragChat)를 HTTP fetch로 호출합니다.
 * @param {string} bookId 
 * @param {Array<Object>} messages - 채팅 내역 배열
 * @param {string} systemPrompt - 챗봇 페르소나 프롬프트
 * @returns {Promise<string>} 봇의 답변
 */
window.sendQueryToBot = async function(bookId, messages, systemPrompt) {
    const RAG_CHAT_URL = "https://ragchat-kbtdkj4qza-du.a.run.app";

    // 2. 인증 토큰 가져오기
    const user = auth.currentUser;
    if (!user) {
        return "오류: 챗봇을 사용하려면 로그인이 필요합니다.";
    }
    let token;
    try {
        token = await getIdToken(user);
    } catch (authError) {
        console.error("Auth token error:", authError);
        return "오류: 인증 토큰을 가져올 수 없습니다.";
    }

    // 3. 백엔드(ragChat)가 요구하는 Input 형식 생성
    // ⭐️ 참고: 지금은 '해설형 챗봇'으로 프롬프트를 고정했습니다.
    const defaultSystemPrompt = "당신은 '해설형 챗봇(교수)'입니다. 사용자의 질문에 대해 교수의 입장에서 친절하고 상세하게 설명해주세요.";
    
    // 👇 [수정 2] 'messages'가 이미 배열이므로 그대로 사용합니다.
    // const messages = [
    //     { "role": "user", "content": query }
    // ];

    const body = {
        book_id: bookId, 
        system_prompt: systemPrompt, // 👈 수정됨
        messages: messages 
    };

    // 4. on_request 함수는 'fetch'로 직접 호출 (httpsOnCall 아님)
    try {
        console.log(`(챗봇) fetch 전송: ${RAG_CHAT_URL}`, body);
        
        const response = await fetch(RAG_CHAT_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}` // ⭐️ 인증 헤더 필수
            },
            body: JSON.stringify(body)
        });

        const result = await response.json();

        if (!response.ok) {
            // 백엔드에서 보낸 오류 메시지 (예: 422, 500)
            throw new Error(result.error || `HTTP ${response.status} 오류`);
        }

        // 5. 백엔드가 보낸 'reply' 키에서 답변 추출
        const answer = result.reply || "답변을 받지 못했습니다. (reply 키 부재)";
        console.log("(챗봇) 답변 수신:", answer);
        return answer;

    } catch (error) {
        console.error("❌ (챗봇) fetch 호출 실패:", error);
        return `오류가 발생했습니다: ${error.message}`;
    }
};