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

// ⭐️ Firebase 설정
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
    
    // (팝업 차단 경고용 CSS)
    if (!$('custom-alert-style')) {
        const style = document.createElement('style');
        style.id = 'custom-alert-style';
        style.innerHTML = `
            .custom-alert-modal { ... } 
            /* (내용 동일) */
        `;
        document.head.appendChild(style);
    }

    // (리디렉션 로그인 결과 처리)
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

    // 로그인 버튼 리스너
    if (loginBtn) {
            loginBtn.addEventListener("click", () => {
                if (loginModalOverlay) {
                    loginModalOverlay.classList.remove("hidden");
                    if (loginModalBody) loginModalBody.classList.remove("show-email-view");
                }
            });
        }

    if (loginModalCloseBtn) {
        loginModalCloseBtn.addEventListener("click", () => {
            if (loginModalOverlay) loginModalOverlay.classList.add("hidden");
        });
    }
    // 모달 '뒤로' 버튼
    if (loginModalBackBtn) {
        loginModalBackBtn.addEventListener("click", () => {
            if (loginModalBody) loginModalBody.classList.remove("show-email-view");
        });
    }

    // 모달: '구글 로그인' 선택
    if (googleLoginChoiceBtn) {
        googleLoginChoiceBtn.addEventListener("click", async () => {
            const isNativeApp = window.Capacitor && window.Capacitor.isNativePlatform();
            if (isNativeApp) {
                // ... (네이티브 앱 로그인 로직) ...
            } else {
                console.log("✅ WEB: 웹 (Redirect) 로그인 시도.");
                if (loginModalOverlay) loginModalOverlay.classList.add("hidden"); 
                await signInWithRedirect(auth, provider);
            }
        });
    }

    // 모달: '이메일 로그인' 선택
    if (emailLoginChoiceBtn) {
        emailLoginChoiceBtn.addEventListener("click", () => {
            if (loginModalBody) loginModalBody.classList.add("show-email-view");
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
                    if (loginModalOverlay) loginModalOverlay.classList.add("hidden");
                } catch (error) {
                    console.error("❌ (Email) 회원가입 실패:", error);
                    handleAuthError(error);
                }
            });
        }

    // 인증 상태 리스너
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
    if (unsubscribeBookStatus) unsubscribeBookStatus();

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
        
        // 2. Storage 업로드
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
        
        // 4. 처리된 데이터 삭제
        try {
            await deleteDoc(doc(db, "books", docId));
        } catch (e) { console.warn("Processed data delete failed:", e); }

        if (currentBookId === docId) resetToHome();

    } catch (error) {
        console.error("Document deletion failed:", error);
        alert(`문서 삭제 실패: ${error.message}`);
    }
}

// ⭐️ [수정] openDoc 함수 (파이프라인 감시 및 상태 표시)
export async function openDoc(bookId) {
    const user = currentUser;
    if (!user || !bookId) return;

    if (unsubscribeHighlights) unsubscribeHighlights();
    if (unsubscribeBookStatus) unsubscribeBookStatus();
    
    currentBookId = bookId;

    // UI 업데이트
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
        
        const response = await fetch(url);
        if (!response.ok) throw new Error(`PDF Download Failed: HTTP status ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        
        if (window.renderDocument) {
            window.renderDocument(arrayBuffer);
        } else {
            console.error("window.renderDocument not found!");
        }

        // 하이라이트 리스너
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

        // ⭐️ [파이프라인] 실시간 감시 및 진행상황 표시
        const bookStatusRef = doc(db, "books", bookId);
        const statusLabel = $("pipeline-status");
        const btnFull = $("modal-full-doc-btn");
        const btnHigh = $("modal-highlights-btn");

        unsubscribeBookStatus = onSnapshot(bookStatusRef, (doc) => {
            if (!doc.exists()) {
                // 1. 업로드 직후 (아직 DB 기록 없음)
                if (statusLabel) {
                    statusLabel.textContent = "대기 중...";
                    statusLabel.style.color = "var(--muted)";
                }
                if (btnFull) btnFull.disabled = true;
                if (btnHigh) btnHigh.disabled = true;
            } else {
                const data = doc.data();
                const status = data?.status;
                // ⭐️ 백엔드가 보내준 진행 상황 메시지 읽기
                const progressMsg = data?.progressMessage || "처리 중..."; 

                console.log(`(파이프라인) 상태: ${status}, 메시지: ${progressMsg}`);

                if (status === "processed_all_ok") {
                    // ✅ 완료
                    if (statusLabel) {
                        statusLabel.textContent = "✅ 분석 완료"; 
                        statusLabel.style.color = "green";
                    }
                    if (btnFull) btnFull.disabled = false;
                    if (btnHigh) btnHigh.disabled = false;

                } else if (status === "processing") {
                    // ⏳ 진행 중 (동적 메시지)
                    if (statusLabel) {
                        statusLabel.textContent = `⏳ ${progressMsg}`; 
                        statusLabel.style.color = "#eab308"; 
                    }
                    if (btnFull) btnFull.disabled = true;
                    if (btnHigh) btnHigh.disabled = true;

                } else if (status && status.startsWith("error_")) {
                    // ❌ 에러
                    if (statusLabel) {
                        statusLabel.textContent = `❌ 오류: ${status}`;
                        statusLabel.style.color = "red";
                    }
                    if (btnFull) btnFull.disabled = true;
                    if (btnHigh) btnHigh.disabled = true;
                } else {
                    // 대기
                    if (statusLabel) statusLabel.textContent = "준비 중...";
                    if (btnFull) btnFull.disabled = true;
                    if (btnHigh) btnHigh.disabled = true;
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

// ⭐️ [복구] 홈으로 리셋 함수
function resetToHome() {
    if (unsubscribeHighlights) unsubscribeHighlights();
    if (unsubscribeBookStatus) unsubscribeBookStatus();
    currentBookId = null;

    if (window.clearViewer) window.clearViewer();
    else clearViewer();
    
    showEmptyState();
    if(window.setHighlightsData) window.setHighlightsData([]);
    if (window.setChatbotEnabled) window.setChatbotEnabled(false);
    
    // 상태 라벨 및 버튼 초기화
    const statusLabel = $("pipeline-status");
    const btnFull = $("modal-full-doc-btn");
    const btnHigh = $("modal-highlights-btn");

    if (statusLabel) {
        statusLabel.textContent = "문서 열기 필요";
        statusLabel.style.color = "var(--muted)";
    }
    if (btnFull) btnFull.disabled = true;
    if (btnHigh) btnHigh.disabled = true;
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
 */
window.sendQueryToBot = async function(bookId, messages, systemPrompt) {
    const RAG_CHAT_URL = "https://ragchat-kbtdkj4qza-du.a.run.app";

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

    const body = {
        book_id: bookId, 
        system_prompt: systemPrompt, 
        messages: messages 
    };

    try {
        console.log(`(챗봇) fetch 전송: ${RAG_CHAT_URL}`, body);
        
        const response = await fetch(RAG_CHAT_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(body)
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || `HTTP ${response.status} 오류`);
        }

        const answer = result.reply || "답변을 받지 못했습니다. (reply 키 부재)";
        console.log("(챗봇) 답변 수신:", answer);
        return answer;

    } catch (error) {
        console.error("❌ (챗봇) fetch 호출 실패:", error);
        return `오류가 발생했습니다: ${error.message}`;
    }
};