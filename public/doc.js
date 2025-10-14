import { db, auth, storage, functions, collection, query, where, orderBy, onSnapshot, addDoc, deleteDoc, doc, getDoc, setDoc, ref, uploadBytes, getDownloadURL, httpsCallable, Timestamp } from "./A.firebase.js";
import { getCurrentUser } from './auth.js';
import { renderPDF } from './viewer.js';
import { setAnnotationContext, updateHighlightsData, clearAnnotations } from './annotate.js';

// DOM 요소
const btnDocs = document.getElementById("doc-btn");
const drawer = document.getElementById("doc-drawer");
const btnClose = document.getElementById("doc-close");
const listEl = document.getElementById("doc-list");
const fileInput = document.getElementById("file-btn");
const chalkboard = document.getElementById("chalkboard");
const bookLayout = document.getElementById("book-layout");

let currentBookId = null;
let unsubscribeDocs = null;
let unsubscribeHighlights = null;

// 문서 시스템 초기화 (main.js에서 호출)
export function initDocSystem(user) {
    if (!user) {
        console.log("사용자가 로그인하지 않아 문서 시스템을 초기화하지 않습니다.");
        resetToHome();
        if (unsubscribeDocs) unsubscribeDocs();
        renderDocsList([]);
        return;
    }

    if (unsubscribeDocs) unsubscribeDocs(); 

    const docsQuery = query(collection(db, "docs", user.uid, "userDocs"), orderBy("createdAt", "desc"));
    unsubscribeDocs = onSnapshot(docsQuery, (snapshot) => {
        const docs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        renderDocsList(docs);
    });

    btnDocs?.addEventListener("click", () => drawer.classList.toggle('hidden'));
    btnClose?.addEventListener("click", () => drawer.classList.add('hidden'));
}

// 파일 업로드 처리
export async function createDocFromFile(file) {
    const user = getCurrentUser();
    if (!file || !user) return;

    // ✨ [수정] 파일 이름에서 공백, 대괄호, 소괄호, 하이픈을 밑줄(_)로 변경
    const sanitizedFileName = file.name.replace(/[\s\[\]\(\)-]/g, '_');
    const storagePath = `docs/${user.uid}/${Date.now()}_${sanitizedFileName}`;
    const storageRef = ref(storage, storagePath);
    
    console.log("업로드 시작:", storagePath);
    await uploadBytes(storageRef, file);
    console.log("업로드 완료");

    const docRef = await addDoc(collection(db, "docs", user.uid, "userDocs"), {
        title: file.name, // DB에는 원래 파일 이름을 저장하여 사용자에게 보여줌
        storagePath: storagePath, // Storage 경로는 정리된 이름 사용
        createdAt: Timestamp.now(),
    });
    
    openDoc(docRef.id);
}

// 문서 목록 렌더링
function renderDocsList(docs) {
    if (!listEl) return;
    listEl.innerHTML = `<button class="doc-add">➕ 새 문서 추가</button>`;
    
    // '새 문서 추가' 버튼 이벤트는 main.js에서 통합 관리하므로 여기서 삭제합니다.

    docs.forEach(doc => {
        const item = document.createElement("div");
        item.className = "doc-row";
        // ✨ [삭제] 더 이상 사용하지 않는 OCR 버튼을 HTML에서 제거
        item.innerHTML = `
            <span class="doc-title">${doc.title}</span>
            <div class="row-actions">
                <button data-open="${doc.id}">열기</button>
                <button data-del="${doc.id}">삭제</button>
            </div>
        `;
        listEl.appendChild(item);
    });
}

// ✨ [삭제] 더 이상 사용하지 않는 OCR 관련 함수와 이벤트 리스너를 모두 삭제합니다.
// export async function analyzeDocWithOcr(storagePath) { ... }
// listEl?.addEventListener("click", ...)

// 문서 삭제 함수
export async function deleteDocFromDb(docId) {
    const user = getCurrentUser();
    if (!user || !docId) return;
    if (confirm("정말로 이 문서를 삭제하시겠습니까?")) {
        await deleteDoc(doc(db, "docs", user.uid, "userDocs", docId));
        if (currentBookId === docId) resetToHome();
    }
}

// 문서 열기
export function openDoc(bookId) {
    const user = getCurrentUser();
    if (!user) return;

    if (unsubscribeHighlights) unsubscribeHighlights();
    currentBookId = bookId;
    
    const docRef = doc(db, "docs", user.uid, "userDocs", bookId);
    getDoc(docRef).then(docSnap => {
        if (docSnap.exists()) {
            const docData = docSnap.data();
            const storageRef = ref(storage, docData.storagePath);
            
            chalkboard.classList.add("hidden");
            bookLayout.classList.remove("hidden");
            drawer.classList.add('hidden');

            renderPDF(storageRef);
            setAnnotationContext(user.uid, bookId);

            const highlightsQuery = query(collection(db, "highlights"), where("bookId", "==", bookId), where("userId", "==", user.uid));
            unsubscribeHighlights = onSnapshot(highlightsQuery, (snapshot) => {
                const highlights = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
                updateHighlightsData(highlights);
            });
        }
    });
}

// 홈으로 리셋
function resetToHome() {
    if (unsubscribeHighlights) unsubscribeHighlights();
    currentBookId = null;

    chalkboard.classList.remove("hidden");
    bookLayout.classList.add("hidden");
    clearAnnotations();
}

// 현재 bookId 반환
export function getCurrentBookId() {
    return currentBookId;
}