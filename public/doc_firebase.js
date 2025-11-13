// ✅ 1. 'signInWithRedirect' 등 웹 전용 함수를 다시 import 합니다. (웹 배포를 위해 필수)
import {
    db, storage, auth, provider, // 인스턴스
    collection, query, where, orderBy, onSnapshot,
    addDoc, deleteDoc, doc, getDoc, updateDoc,
    Timestamp, writeBatch, getDocs,
    ref as storageRef,
    getDownloadURL as getStorageDownloadURL,
    uploadBytes as storageUploadBytes,
    deleteObject as storageDeleteObject,
    signInWithPopup, signOut, onAuthStateChanged, messaging, getToken, setDoc,
    signInWithRedirect, getRedirectResult // ✅ 다시 추가
} from './A.firebase.js';

// ❌ '@capacitor-firebase/authentication' import는 완전히 삭제합니다.

// --- 전역 변수 ---
const appId = "default-app-id"; // A.firebase.js에서 export되지 않는 경우를 대비한 대체 값
let currentUser = null;
let currentBookId = null;
let unsubscribeDocs = null;
let unsubscribeHighlights = null;

// DOM 요소는 mybook.js가 로드된 후 사용 가능
const $ = (id) => document.getElementById(id);

// --- 인증 및 UI 관리 ---

document.addEventListener("DOMContentLoaded", () => {
    // 팝업 차단 경고를 위한 CSS 추가 (선택적)
    if (!$('custom-alert-style')) {
        const style = document.createElement('style');
        style.id = 'custom-alert-style';
        style.innerHTML = `
            .custom-alert-modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; justify-content: center; align-items: center; }
            .modal-content { background: #fff; padding: 24px; border-radius: 8px; max-width: 400px; text-align: center; color: #111; }
            .modal-content button { margin-top: 15px; padding: 8px 16px; background: #3b82f6; color: white; border-radius: 6px; }
        `;
        document.head.appendChild(style);
    }

    // ✅ 2. 'getRedirectResult' 코드는 웹 배포를 위해 다시 원상 복구합니다.
    getRedirectResult(auth)
        .then((result) => {
            if (result) {
                // 사용자가 방금 리디렉션을 통해 성공적으로 로그인함
                console.log("✅ (WEB) 리디렉션 로그인 성공!", result.user);
            } else {
                // 사용자가 그냥 페이지를 방문함 (리디렉션 아님)
                console.log("페이지 일반 로드 (리디렉션 아님).");
            }
        })
        .catch((error) => {
            // 리디렉션 '이후'에 발생한 오류 (예: 계정 충돌)
            console.error("❌ (WEB) 리디렉션 로그인 실패:", error);
            if (error.code === 'auth/account-exists-with-different-credential') {
                alert("이미 다른 방식(예: 이메일)으로 가입된 계정입니다.");
            }
        });
    // --- 리디렉션 처리 코드 끝 ---
    
    const loginBtn  = $("loginBtn");
    const logoutBtn = $("logoutBtn");
    const authStatus = $("authStatus");
    const userDisplay = authStatus;

    // 로그인 버튼 리스너
    if (loginBtn) {
        // ✅ 3. [핵심] 'async'로 변경하고, 앱/웹 환경을 감지합니다.
        loginBtn.addEventListener("click", async () => {
            
            // ✅ 'Capacitor' 전역 객체가 있고, 'isNativePlatform'이 true면 앱입니다.
            const isNativeApp = window.Capacitor && window.Capacitor.isNativePlatform();

            if (isNativeApp) {
                // --- 📱 NATIVE APP (안드로이드) 로직 ---
                console.log("✅ NATIVE: 네이티브 Google 로그인 시도.");
                try {
                    const { FirebaseAuthentication } = Capacitor.Plugins;
                    if (!FirebaseAuthentication) {
                        throw new Error("Firebase Auth 플러그인을 찾을 수 없습니다. (cap sync 확인 필요)");
                    }
                    
                    const result = await FirebaseAuthentication.signInWithGoogle();
                    const credential = firebase.auth.GoogleAuthProvider.credential(
                        result.credential.idToken
                    );
                    await firebase.auth().signInWithCredential(credential);
                    console.log("✅ NATIVE: Firebase 로그인 성공!");

                } catch (error) {
                    console.error("❌ NATIVE: 로그인 실패:", error);
                    alert("로그인에 실패했습니다: " + (error.message || "Unknown error"));
                }
            } else {
                // --- 🌍 WEB (웹사이트) 로직 ---
                console.log("✅ WEB: 웹 (Redirect) 로그인 시도.");
                // (참고: signInWithPopup은 팝업 차단 때문에 앱/웹 모두에서 비추천)
                // 원래 쓰시던 'signInWithRedirect'를 사용합니다.
                await signInWithRedirect(auth, provider);
                // (이 코드는 'Missing initial state' 오류를 냈지만, 
                //  그건 '앱'에서 '웹' 코드를 실행했기 때문입니다.
                //  '웹'에서 '웹' 코드를 실행하면 정상 작동해야 합니다.)
            }
        });
    }

    // 로그아웃 버튼 리스너
    if (logoutBtn) {
        logoutBtn.addEventListener("click", () => {
            signOut(auth).catch(e => console.error("로그아웃 실패:", e));
        });
    }

    // 인증 상태 리스너
    onAuthStateChanged(auth, (user) => {
        currentUser = user;
        if (user) {
            if (userDisplay) userDisplay.textContent = user.displayName || user.email;
            if (loginBtn) loginBtn.style.display = 'none';
            if (logoutBtn) logoutBtn.style.display = 'inline-flex';
            requestPermissionAndSaveToken(user);
            initDocSystem(user); // 문서 시스템 초기화
        } else {
            if (userDisplay) userDisplay.textContent = "로그인 필요";
            if (loginBtn) loginBtn.style.display = 'inline-flex';
            if (logoutBtn) logoutBtn.style.display = 'none';
            initDocSystem(null); // 로그아웃 시 시스템 초기화
        }
        document.dispatchEvent(new CustomEvent('authStateChanged', { detail: { user } }));
    });
});

// --- 푸시 알림 권한 및 토큰 저장 함수 ---
async function requestPermissionAndSaveToken(user) {
    // (웹에서는 'unsupported-browser' 오류가 날 수 있지만, 앱에서는 무시됩니다)
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


// --- 뷰어 통신 헬퍼 함수 (mybook.js가 제공해야 함) ---

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

// 문서 시스템 초기화 (인증 상태 변경 시 호출)
export function initDocSystem(user) {
    if (unsubscribeDocs) {
        unsubscribeDocs();
        unsubscribeDocs = null;
    }
    if (unsubscribeHighlights) {
        unsubscribeHighlights();
        unsubscribeHighlights = null;
    }

    const listEl = $("doc-list");
    if (!listEl) { console.error("doc-list element not found."); return; }
    
    if (!user) {
        resetToHome();
        listEl.innerHTML = '';
        listEl.innerHTML += '<div class="doc-row" style="padding: 10px; color: var(--muted); text-align: center;">로그인 후 문서를 관리할 수 있습니다.</div>';
        return;
    }

    // 문서 목록 실시간 감시 시작
    const userDocsPath = `artifacts/${appId}/users/${user.uid}/userDocs`;
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

// 문서 목록 클릭 처리 핸들러 (open, delete, add)
async function handleDocListClick(e) {
    const target = e.target;
    const openId = target.closest('[data-open]')?.dataset.open;
    const delId = target.closest('[data-del]')?.dataset.del;
    const addBtn = target.closest('.doc-add');

    if (openId) {
        await openDoc(openId);
    } else if (delId) {
        await deleteDocFromDb(delId);
    } else if (addBtn) {
        const fileInput = $("file");
        if(fileInput) fileInput.click();
    }
}

// 파일 선택 처리 핸들러
async function handleFileChange(e) {
    const file = e.target.files[0];
    if (file) {
        await createDocFromFile(file);
        e.target.value = null;
    }
}

// 파일 업로드 처리
export async function createDocFromFile(file) {
    const user = currentUser;
    if (!file || !user) {
        alert("로그인 후 파일을 업로드할 수 있습니다.");
        return;
    }
    if (!file.type || !file.type.includes('pdf')) {
        alert("PDF 파일만 업로드할 수 있습니다.");
        return;
    }

    let docRef;
    try {
        // 1. Firestore 문서 먼저 생성
        const userDocsPath = `artifacts/${appId}/users/${user.uid}/userDocs`;
        docRef = await addDoc(collection(db, userDocsPath), {
            title: file.name,
            createdAt: Timestamp.now()
        });
        const bookId = docRef.id;
        
        // 2. Storage 경로 생성 및 업로드
        const storagePath = `artifacts/${appId}/users/${user.uid}/docs/${bookId}.pdf`;
        const storageRefInstance = storageRef(storage, storagePath);

        await storageUploadBytes(storageRefInstance, file);

        // 3. Firestore 문서에 Storage 경로 업데이트
        await updateDoc(docRef, { storagePath: storagePath });

        // 4. 업로드 성공 후 문서 열기
        await openDoc(bookId);

    } catch (error) {
        console.error("File upload or Firestore update failed:", error);
        alert(`파일 업로드 실패: ${error.message}`);
        if (docRef) {
            try {
                await deleteDoc(docRef);
                console.log("Firestore document rollback successful.");
            } catch (deleteError) {
                console.error("Firestore document rollback failed:", deleteError);
            }
        }
    }
}

// 문서 목록 렌더링
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

// 문서 삭제 함수
export async function deleteDocFromDb(docId) {
    const user = currentUser;
    if (!user || !docId) return;

    // 간소화된 확인창
    if (!confirm(`문서 ID ${docId}를 삭제하시겠습니까? 관련된 모든 데이터가 삭제됩니다.`)) {
        return;
    }

    try {
        // 1. Firestore 문서 삭제
        const docRefPath = `artifacts/${appId}/users/${user.uid}/userDocs`;
        await deleteDoc(doc(db, docRefPath, docId));

        // 2. Storage 파일 삭제 (Storage 경로는 predictable)
        try {
            const storagePath = `artifacts/${appId}/users/${user.uid}/docs/${docId}.pdf`;
            await storageDeleteObject(storageRef(storage, storagePath));
        } catch (storageError) {
            console.warn("Failed to delete storage file (might not exist):", storageError);
        }

        // 3. 관련된 Firestore 하이라이트 삭제
        const highlightsQuery = query(collection(db, "highlights"), where("bookId", "==", docId), where("userId", "==", user.uid));
        const snapshot = await getDocs(highlightsQuery);
        const batch = writeBatch(db);
        snapshot.forEach(doc => {
            batch.delete(doc.ref);
        });
        await batch.commit();

        if (currentBookId === docId) {
            resetToHome();
        }

    } catch (error) {
        console.error("Document deletion failed:", error);
        alert(`문서 삭제 실패: ${error.message}`);
    }
}


// 문서 열기
export async function openDoc(bookId) {
    const user = currentUser;
    if (!user || !bookId) return;

    if (unsubscribeHighlights) {
        unsubscribeHighlights();
        unsubscribeHighlights = null;
    }
    currentBookId = bookId;

    document.querySelectorAll('.doc-row').forEach(el => el.classList.remove('active'));
    const activeRow = document.querySelector(`.doc-row[data-id="${bookId}"]`);
    if(activeRow) activeRow.classList.add('active');

    const docRefPath = `artifacts/${appId}/users/${user.uid}/userDocs`;
    const docRef = doc(db, docRefPath, bookId);

    try {
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            const docData = docSnap.data();
            if (!docData.storagePath) throw new Error(`Document [${bookId}] is missing storagePath!`);

            const storageRefInstance = storageRef(storage, docData.storagePath);
            showPdfPages();

            const url = await getStorageDownloadURL(storageRefInstance);
            
            // --- PDF 다운로드 시 HTTP 응답 상태 확인 로직 ---
            console.log(`PDF Download URL: ${url}`);

            const response = await fetch(url);
            
            if (!response.ok) {
                const errorMsg = `PDF Download Failed: HTTP status ${response.status} (${response.statusText}). URL: ${url}. Check Storage rules or file existence.`;
                alert(errorMsg);
                throw new Error(errorMsg);
            }

            const arrayBuffer = await response.arrayBuffer();
            // --- 로직 끝 ---
            
            if (window.renderDocument) {
                window.renderDocument(arrayBuffer);
            } else {
                console.error("window.renderDocument not found in mybook.js!");
            }

            // 하이라이트 실시간 리스너 설정
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

        } else {
            throw new Error("Document not found in Firestore.");
        }
    } catch (error) {
        console.error("Failed to open document:", error);
        alert(`문서 열기 실패: ${error.message}`);
        resetToHome();
    }
}

// 홈으로 리셋 (뷰어 초기화)
function resetToHome() {
    if (unsubscribeHighlights) {
        unsubscribeHighlights();
        unsubscribeHighlights = null;
    }
    currentBookId = null;

    if (window.clearViewer) {
        window.clearViewer();
    } else {
        clearViewer();
    }
    showEmptyState();
    if(window.setHighlightsData) window.setHighlightsData([]);
}

// --- 외부 노출 함수 ---
export function getCurrentUser() {
    return currentUser;
}

export function getCurrentBookId() {
    return currentBookId;
}


window.saveHighlightChange = async function(type, highlightData) {
    const user = currentUser;
    const bookId = currentBookId;

    if (!user || !bookId || !highlightData || highlightData.id?.startsWith('local_')) {
        console.warn(`Firestore save/update aborted: Missing data or using local_ ID. Type: ${type}`);
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
                createdAt: Timestamp.now(),
                nextReviewDate: Timestamp.fromDate(nextReviewDate), // 1일 뒤
                reviewLevel: 1 // 현재 1단계 (1일)
            };
            delete docData.id;
            const docRef = await addDoc(highlightsCol, docData);
            console.log("Firestore: 새 하이라이트 추가 완료", docRef.id);
            return docRef; // 👈 viewer-highlight-manager.js가 id를 받을 수 있도록 반환
            
        } else if (type === 'update') {
            const docRef = doc(db, "highlights", highlightData.id);
            const updateData = { ...highlightData };

            delete updateData.id;
            delete updateData.userId;
            delete updateData.bookId;
            delete updateData.createdAt;
            updateData.updatedAt = Timestamp.now();

            await updateDoc(docRef, updateData);

        } else if (type === 'delete') {
            const docRef = doc(db, "highlights", highlightData.id);
            await deleteDoc(docRef);

        }
    } catch (error) {
        console.error(`Firestore highlight '${type}' operation failed:`, error);
    }
};
window.initDocSystem = initDocSystem;

console.log("doc_firebase.js loaded.");