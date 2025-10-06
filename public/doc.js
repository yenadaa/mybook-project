import { db, auth, storage, functions, collection, query, where, orderBy, onSnapshot, addDoc, deleteDoc, doc, getDoc, setDoc, ref, uploadBytes, getDownloadURL, httpsCallable, Timestamp } from "./A.firebase.js";
import { getCurrentUser } from './auth.js';
import { renderPDF } from './viewer.js';
import { setAnnotationContext, updateHighlightsData, clearAnnotations } from './annotate.js';

// DOM 요소
const btnDocs = document.getElementById("doc-btn");
const layout = document.getElementById("doc-layout");
const drawer = document.getElementById("doc-drawer");
const btnClose = document.getElementById("doc-close");
const listEl = document.getElementById("doc-list");
const fileInput = document.getElementById("file-btn");
const chalkboard = document.getElementById("chalkboard");
const bookLayout = document.getElementById("book-layout");
const pdfContainer = document.getElementById("pdf-container");

let currentBookId = null;
let unsubscribeDocs = null;
let unsubscribeHighlights = null;

// 문서 시스템 초기화 (main.js에서 호출)
export function initDocSystem(user) {
    if (!user) {
        console.log("사용자가 로그인하지 않아 문서 시스템을 초기화하지 않습니다.");
        resetToHome(); // 로그아웃 상태일 때 홈으로 리셋
        if (unsubscribeDocs) unsubscribeDocs();
        renderDocsList([]); // 빈 목록 표시
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

    const storagePath = `docs/${user.uid}/${Date.now()}_${file.name}`;
    const storageRef = ref(storage, storagePath);
    
    console.log("업로드 시작:", storagePath);
    await uploadBytes(storageRef, file);
    console.log("업로드 완료");

    const docRef = await addDoc(collection(db, "docs", user.uid, "userDocs"), {
        title: file.name,
        storagePath: storagePath,
        createdAt: Timestamp.now(),
    });

    // ✨ [최종 수정] 파일 업로드 후, 해당 문서를 자동으로 엽니다.
    openDoc(docRef.id);
}

// 문서 목록 렌더링
function renderDocsList(docs) {
    if (!listEl) return;
    listEl.innerHTML = `<button class="doc-add">➕ 새 문서 추가</button>`;
    listEl.querySelector(".doc-add").addEventListener("click", () => {
        if (getCurrentUser()) {
            fileInput.click();
        } else {
            alert("로그인이 필요합니다.");
        }
    });

    docs.forEach(doc => {
        const item = document.createElement("div");
        item.className = "doc-row";
        item.innerHTML = `
            <span class="doc-title">${doc.title}</span>
            <div class="row-actions">
                <button data-ocr="${doc.storagePath}">OCR</button>
                <button data-open="${doc.id}">열기</button>
                <button data-del="${doc.id}">삭제</button>
            </div>
        `;
        listEl.appendChild(item);
    });
}

// OCR 분석 함수
export async function analyzeDocWithOcr(storagePath) {
    if (!storagePath) return alert("분석할 문서의 경로가 없습니다.");
    console.log("OCR 실행 요청:", storagePath);
    try {
        const runOcr = httpsCallable(functions, 'runOcrOnDemand');
        await runOcr({ filePath: storagePath });
        alert("OCR 분석이 시작되었습니다. 완료되면 데이터가 저장됩니다.");
    } catch (error) {
        console.error("OCR 함수 호출 오류:", error);
        alert("OCR 분석을 시작하는 데 실패했습니다.");
    }
}

// 문서 삭제 함수
export async function deleteDocFromDb(docId) {
    const user = getCurrentUser();
    if (!user || !docId) return;
    if (confirm("정말로 이 문서를 삭제하시겠습니까?")) {
        await deleteDoc(doc(db, "docs", user.uid, "userDocs", docId));
        if (currentBookId === docId) resetToHome();
    }
}

// 이벤트 위임: 문서 열기, 삭제, OCR
listEl?.addEventListener("click", async (e) => {
    const target = e.target;
    if (target.dataset.open) openDoc(target.dataset.open);
    else if (target.dataset.del) deleteDocFromDb(target.dataset.del);
    else if (target.dataset.ocr) analyzeDocWithOcr(target.dataset.ocr);
});

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