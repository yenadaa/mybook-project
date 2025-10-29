// A.firebase.js에서 필요한 모든 함수 가져오기
import { 
    db, auth, storage, functions, 
    collection, query, where, orderBy, onSnapshot, 
    addDoc, deleteDoc, doc, getDoc, setDoc, 
    ref, uploadBytes, getDownloadURL, httpsCallable, Timestamp 
} from "./A.firebase.js";

// auth.js에서 현재 사용자 정보 가져오기
import { getCurrentUser } from './auth.js';

// ✅ [수정] firebaseLoader.js의 PDF 로딩 함수 가져오기
import { loadPdfFromStorage } from './firebaseLoader.js'; 

// ✅ [삭제] 기존 viewer.js, annotate.js 관련 import 제거
// import { renderPDF } from './viewer.js'; 
// import { setAnnotationContext, updateHighlightsData, clearAnnotations } from './annotate.js';

// DOM 요소 (새 index.html 기준으로 ID 확인 필요)
// const btnDocs = document.getElementById("doc-btn"); // <--- ⚠️ 새 HTML에 이 버튼 ID가 있는지 확인!
// const drawer = document.getElementById("doc-drawer"); // <--- ⚠️ 새 HTML에 이 ID가 있는지 확인!
// const btnClose = document.getElementById("doc-close"); // <--- ⚠️ 새 HTML에 이 ID가 있는지 확인!
const listEl = document.getElementById("doc-list");       // <--- ⚠️ 새 HTML에 이 ID가 있는지 확인! (아마 sidebar 어딘가?)
const fileInput = document.getElementById("file");        // <--- ✅ 새 HTML의 파일 입력 ID는 'file'입니다.
const emptyMessage = document.getElementById("empty");    // <--- ✅ 새 HTML의 초기 메시지 ID
const pagesContainer = document.getElementById("pages");    // <--- ✅ 새 HTML의 PDF 표시 영역 ID

let currentBookId = null;
let unsubscribeDocs = null;
let unsubscribeHighlights = null;

// 문서 시스템 초기화 (auth.js 등에서 로그인 성공 시 호출해야 함)
export function initDocSystem(user) {
    if (!user) {
        console.log("사용자가 로그인하지 않아 문서 시스템을 초기화하지 않습니다.");
        resetToHome(); // 홈 화면으로 (PDF 뷰어 숨기기)
        if (unsubscribeDocs) unsubscribeDocs();
        renderDocsList([]); // 문서 목록 비우기
        return;
    }

    if (unsubscribeDocs) unsubscribeDocs(); 

    // 사용자의 문서 목록 실시간 감시
    const docsQuery = query(collection(db, "docs", user.uid, "userDocs"), orderBy("createdAt", "desc"));
    unsubscribeDocs = onSnapshot(docsQuery, (snapshot) => {
        const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        renderDocsList(docs); // 문서 목록 UI 업데이트
    });

    // --- ⚠️ 새 HTML 구조에 맞게 이벤트 리스너 재설정 필요 ---
    // 예: 문서 목록 버튼/닫기 버튼 등
    // btnDocs?.addEventListener("click", () => drawer.classList.toggle('hidden'));
    // btnClose?.addEventListener("click", () => drawer.classList.add('hidden'));
    // 문서 목록 내 '열기/삭제' 버튼 이벤트 리스너 추가 (아래 renderDocsList 내부 또는 여기서)
    listEl?.addEventListener('click', async (e) => {
        const openId = e.target.dataset.open;
        const delId = e.target.dataset.del;
        const addBtn = e.target.closest('.doc-add'); // 새 문서 추가 버튼

        if (openId) {
            openDoc(openId);
        } else if (delId) {
            deleteDocFromDb(delId);
        } else if (addBtn) {
            // 새 문서 추가 버튼 클릭 시 파일 선택창 열기
            fileInput?.click(); 
        }
    });

    // 파일 입력(fileInput) 변경 감지 (새 파일 업로드)
    fileInput?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            createDocFromFile(file);
            e.target.value = null; // 같은 파일 다시 선택 가능하도록 초기화
        }
    });
}

// 파일 업로드 처리 (수정 없음 - 로직 완벽)
export async function createDocFromFile(file) {
    const user = getCurrentUser();
    if (!file || !user) return;

    const docRef = await addDoc(collection(db, "docs", user.uid, "userDocs"), {
        title: file.name,
        createdAt: Timestamp.now(),
    });
    const bookId = docRef.id;
    const storagePath = `docs/${user.uid}/${bookId}.pdf`; // bookId를 파일명으로 사용
    const storageRef = ref(storage, storagePath);
    
    console.log(`업로드 시작: ${storagePath}`);
    try {
        await uploadBytes(storageRef, file);
        console.log("업로드 완료");
        await setDoc(docRef, { storagePath: storagePath }, { merge: true }); // 경로 업데이트
        openDoc(bookId); // 업로드 후 바로 열기
    } catch (error) {
        console.error("파일 업로드/업데이트 실패:", error);
        await deleteDoc(docRef); // 실패 시 문서 삭제
        alert("파일 업로드 실패.");
    }
}

// 문서 목록 렌더링 (수정 없음 - 로직 완벽, ID만 확인)
function renderDocsList(docs) {
    if (!listEl) return;
    listEl.innerHTML = `<button class="doc-add">➕ 새 문서 추가</button>`; // 추가 버튼 먼저

    docs.forEach(docData => { // 변수명 doc -> docData 변경 (함수 이름과의 혼동 방지)
        const item = document.createElement("div");
        item.className = "doc-row"; // CSS 클래스 확인 필요
        item.innerHTML = `
            <span class="doc-title">${docData.title}</span>
            <div class="row-actions">
                <button data-open="${docData.id}">열기</button>
                <button data-del="${docData.id}">삭제</button>
            </div>
        `;
        listEl.appendChild(item);
    });
}

// 문서 삭제 함수 (수정 없음 - 로직 완벽)
export async function deleteDocFromDb(docId) {
    const user = getCurrentUser();
    if (!user || !docId) return;
    if (confirm("정말로 이 문서를 삭제하시겠습니까? (관련 하이라이트도 모두 삭제됩니다)")) {
        try {
            // Firestore 문서 삭제
            await deleteDoc(doc(db, "docs", user.uid, "userDocs", docId));
            
            // TODO: Storage 파일 삭제 (선택 사항)
            // const storagePath = `docs/${user.uid}/${docId}.pdf`;
            // await deleteObject(ref(storage, storagePath));

            // TODO: 관련 하이라이트 삭제 (선택 사항)
            // const highlightsQuery = query(collection(db, "highlights"), where("bookId", "==", docId), where("userId", "==", user.uid));
            // const snapshot = await getDocs(highlightsQuery);
            // snapshot.forEach(doc => deleteDoc(doc.ref));

            if (currentBookId === docId) resetToHome(); // 열려있던 문서면 홈으로

        } catch (error) {
            console.error("문서 삭제 실패:", error);
            alert("문서 삭제 실패.");
        }
    }
}

// 문서 열기 (핵심 수정!)
export async function openDoc(bookId) {
    const user = getCurrentUser();
    if (!user) return;

    if (unsubscribeHighlights) unsubscribeHighlights(); // 이전 하이라이트 리스너 해제
    currentBookId = bookId;
    
    const docRef = doc(db, "docs", user.uid, "userDocs", bookId);
    
    try {
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            const docData = docSnap.data();
            if (!docData.storagePath) throw new Error(`문서 [${bookId}]에 storagePath 정보 없음!`);

            const storageRef = ref(storage, docData.storagePath);
            
            // ✅ [수정] 새 HTML에 맞게 UI 변경
            if (emptyMessage) emptyMessage.style.display = 'none';    // 초기 메시지 숨기기
            if (pagesContainer) pagesContainer.style.display = 'grid'; // PDF 영역 보이기
            // drawer?.classList.add('hidden'); // 문서 목록 서랍 닫기 (ID 확인 필요)

            // ✅ [수정] firebaseLoader.js의 함수를 호출하여 PDF 로딩 요청!
            loadPdfFromStorage(storageRef); 

            // ✅ [삭제] 기존 annotate.js 함수 호출 제거
            // setAnnotationContext(user.uid, bookId);

            // 하이라이트 리스너 설정 (Firestore 실시간 감시)
            const highlightsQuery = query(collection(db, "highlights"), where("bookId", "==", bookId), where("userId", "==", user.uid));
            unsubscribeHighlights = onSnapshot(highlightsQuery, (snapshot) => {
                const highlightsFromFirestore = snapshot.docs.map(d => ({ 
                    id: d.id, // Firestore 문서 ID를 사용
                    ...d.data() 
                }));
                
                // ✅ [수정 완료] viewer.js의 함수를 호출하여 데이터 전달
                if (window.setHighlightsData) {
                    window.setHighlightsData(highlightsFromFirestore);
                } else {
                    console.error("viewer.js의 setHighlightsData 함수를 찾을 수 없음.");
                }
                // ✅ [삭제] 기존 updateHighlightsData 호출 제거
                // updateHighlightsData(highlights); 
            });

        } else {
            throw new Error("Firestore에서 문서를 찾을 수 없음.");
        }
    } catch (error) {
        console.error("문서 열기 실패:", error);
        alert(`문서 열기 실패: ${error.message}`);
        resetToHome();
    }
}

// 홈으로 리셋 (UI 초기화)
function resetToHome() {
    if (unsubscribeHighlights) unsubscribeHighlights();
    currentBookId = null;

    // ✅ [수정] 새 HTML에 맞게 UI 변경
    if (emptyMessage) emptyMessage.style.display = 'grid'; // 초기 메시지 보이기
    if (pagesContainer) pagesContainer.style.display = 'none'; // PDF 영역 숨기기

    // ✅ [삭제] 기존 annotate.js 함수 호출 제거
    // clearAnnotations();

    // viewer.js에 문서 닫는 기능이 있다면 호출 (선택 사항)
    if (window.clearDocument) { 
        window.clearDocument();
    }
}

// 현재 열린 bookId 반환 (수정 없음)
export function getCurrentBookId() {
    return currentBookId;
}

// ✅ [추가] viewer.js가 호출할 Firestore 저장 함수
/**
 * viewer.js로부터 변경된 하이라이트 정보를 받아 Firestore에 저장/업데이트/삭제.
 * @param {'add' | 'update' | 'delete'} type - 변경 유형
 * @param {object} highlightData - 하이라이트 데이터 (viewer.js에서 생성/관리하는 객체)
 */
export async function saveHighlightChange(type, highlightData) {
    const user = getCurrentUser();
    const bookId = getCurrentBookId(); 

    if (!user || !bookId || !highlightData) {
        console.error("Firestore 저장 정보 부족:", { user, bookId, highlightData });
        return;
    }

    const highlightsCol = collection(db, "highlights");

    try {
        if (type === 'add') {
            const docData = { 
                ...highlightData, // viewer.js가 넘겨준 모든 속성 포함
                userId: user.uid, 
                bookId: bookId,
                createdAt: Timestamp.now()
            };
            // viewer.js가 생성한 임시 id는 Firestore에 저장할 필요 없음 (Firestore가 자동 생성)
            // 만약 viewer.js의 id 필드 이름이 'id'가 아니라면 여기서 제거해야 함
            if ('id' in docData) delete docData.id; 

            await addDoc(highlightsCol, docData);
            console.log("Firestore: 새 하이라이트 추가 완료", docData);

        } else if (type === 'update' && highlightData.id) {
            // Firestore 문서 ID가 highlightData.id로 넘어온다고 가정
            const docRef = doc(db, "highlights", highlightData.id);
            const updateData = { ...highlightData };
            
            // 업데이트 시 불필요/변경금지 필드 제거 (id, userId, bookId, createdAt)
            delete updateData.id; 
            delete updateData.userId;
            delete updateData.bookId;
            delete updateData.createdAt; 
            
            await updateDoc(docRef, updateData);
            console.log("Firestore: 하이라이트 업데이트 완료", highlightData.id, updateData);

        } else if (type === 'delete' && highlightData.id) {
             // Firestore 문서 ID가 highlightData.id로 넘어온다고 가정
            const docRef = doc(db, "highlights", highlightData.id);
            await deleteDoc(docRef);
            console.log("Firestore: 하이라이트 삭제 완료", highlightData.id);
        }
    } catch (error) {
        console.error(`Firestore 하이라이트 ${type} 작업 실패:`, error);
    }
}

// ✅ [추가] viewer.js가 호출할 수 있도록 전역(window)에 등록
window.saveHighlightChange = saveHighlightChange;

// --- ⚠️ 주의 ---
// 1. 이 코드는 새 HTML 요소들의 ID가 정확하다고 가정합니다. 
//    (doc-list, empty, pages 등) 실제 ID와 다르면 수정해야 합니다.
// 2. viewer.js에서 하이라이트 객체의 'id' 필드가 Firestore 문서 ID를 담도록 수정해야 
//    'update', 'delete'가 제대로 작동합니다. (add는 자동 생성)
// 3. auth.js에서 로그인 성공 시 initDocSystem(user)을 호출해야 합니다.