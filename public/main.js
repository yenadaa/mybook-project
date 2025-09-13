// Firebase SDK 모듈 임포트
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, collection, onSnapshot, query, where, orderBy } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";
import { getAuth, GoogleAuthProvider, signOut, onAuthStateChanged, signInWithPopup } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-functions.js";


// Firebase 설정 
const firebaseConfig = {
  apiKey: "AIzaSyAeWQaegsc3H01i8qkNoyFZX6CcaW-iJ2g",
  authDomain: "mybook-d143d.firebaseapp.com",
  projectId: "mybook-d143d",
  storageBucket: "mybook-d143d.firebasestorage.app",
  messagingSenderId: "427068485624",
  appId: "1:427068485624:web:7a4ec49fe9afca7078700d",
  measurementId: "G-N8R4MKD233"
};

// Firebase 서비스 초기화
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);
const runOcrBtn = document.getElementById("run-ocr-btn");
const functions = getFunctions(app, 'asia-northeast3'); 

// --- 전역 변수 및 상수 ---
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";

let currentUser = null;
let currentFileName = null;
let isPenActive = false;
let isEraserActive = false;
let isTag = false;
let currentFilter = "all";

let undoStack = [];
let redoStack = [];
let highlights = []; // 하이라이트 데이터는 이 배열에서 관리
let lastSelectedHighlightId = null;

// --- HTML 요소 선택 ---
const viewer = document.getElementById("pdf-container");
const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");
const userInfo = document.getElementById("user-info");
const userEmail = document.getElementById("user-email");
const chalkboard = document.getElementById("chalkboard");
const bookLayout = document.getElementById("book-layout");
const fileInput = document.getElementById("file-btn");
const penBtn = document.getElementById("pen1");
const eraserBtn = document.getElementById("eraser-btn");
const tagBtn = document.getElementById("tag-btn");
const dropdown = document.getElementById("dropdown");
const undoButton = document.getElementById("undo-btn");
const redoButton = document.getElementById("redo-btn");

function updateButtons() {
    if (undoButton) undoButton.disabled = undoStack.length === 0;
    if (redoButton) redoButton.disabled = redoStack.length === 0;
}


// --- 💻 인증 로직 (OURS) ---
onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        loginBtn.style.display = 'none';
        userInfo.style.display = 'block';
        userEmail.textContent = user.email;
        loadLastFile(); // 마지막 파일 로드
    } else {
        currentUser = null;
        loginBtn.style.display = 'block';
        userInfo.style.display = 'none';
        chalkboard.classList.remove("hidden");
        chalkboard.querySelector('p').textContent = "로그인 후, PDF 파일을 추가해주세요";
        bookLayout.classList.add("hidden");
    }
});

loginBtn.addEventListener('click', () => {
    const provider = new GoogleAuthProvider();
    signInWithPopup(auth, provider).catch(error => console.error("로그인 실패:", error));
});

logoutBtn.addEventListener('click', () => {
    signOut(auth).catch(error => console.error("로그아웃 실패:", error));
});


// --- 🚀 파일 업로드 로직 (OURS - Firebase Storage 사용) ---
chalkboard.addEventListener("click", function() {
    if (!currentUser) {
        alert("로그인이 필요합니다.");
        return;
    }
    fileInput.click();
});

fileInput.addEventListener("change", function(e) {
    const file = e.target.files[0];
    if (!file || !currentUser) return;
    
    chalkboard.querySelector('p').textContent = "업로드 중...";
    const storageRef = ref(storage, `uploads/${currentUser.uid}/${file.name}`);
    
    uploadBytes(storageRef, file).then((snapshot) => {
        console.log("Firebase Storage에 업로드 성공!");
        currentFileName = file.name;
        localStorage.setItem("lastUploadedFile", file.name); // 마지막 파일 이름 저장
        
        // 새 파일이므로 기존 하이라이트 초기화
        highlights = [];
        undoStack = [];
        redoStack = [];
        updateButtons();
        
        getDownloadURL(snapshot.ref).then((downloadURL) => {
            chalkboard.classList.add("hidden");
            bookLayout.classList.remove("hidden");
            renderPDF(downloadURL);
            listenToOcrResults(currentFileName);
        });

    }).catch((error) => {
        console.error("업로드 실패:", error);
        alert("파일 업로드에 실패했습니다.");
        chalkboard.querySelector('p').textContent = "PDF 파일 추가";
    });
});

function loadLastFile() {
    const lastFile = localStorage.getItem("lastUploadedFile");
    if (lastFile && currentUser) {
        currentFileName = lastFile;
        const storageRef = ref(storage, `uploads/${currentUser.uid}/${lastFile}`);
        getDownloadURL(storageRef).then((downloadURL) => {
            chalkboard.classList.add("hidden");
            bookLayout.classList.remove("hidden");
            renderPDF(downloadURL);
            listenToOcrResults(currentFileName);
        }).catch(() => {
            localStorage.removeItem("lastUploadedFile");
            chalkboard.querySelector('p').textContent = "마지막 파일을 찾을 수 없습니다. 새로 업로드해주세요.";
        });
    }
}


// --- 📖 PDF 렌더링 및 하이라이트 로직 (TEAMMATE'S + OURS) ---

function renderPDF(url) {
    viewer.innerHTML = ""; // 뷰어 초기화
    loadData(); // 데이터 미리 불러오기

    const loadingTask = pdfjsLib.getDocument(url);
    
    loadingTask.promise.then((pdf) => {
        const pagePromises = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            pagePromises.push(pdf.getPage(i));
        }

        Promise.all(pagePromises).then(pages => {
            const pageElements = []; // 렌더링된 페이지 요소를 순서대로 담을 배열

            pages.forEach(page => {
                const pageNum = page.pageNumber;

                // ▼▼▼▼▼ 자동 스케일링 로직 시작 ▼▼▼▼▼
                const viewportOptions = { scale: 1.0 };
                let viewport = page.getViewport(viewportOptions);
                
                // pdf-container의 너비에 맞게 스케일 동적 계산
                const containerWidth = viewer.clientWidth;
                const scale = containerWidth / viewport.width;
                viewport = page.getViewport({ scale });
                // ▲▲▲▲▲ 자동 스케일링 로직 끝 ▲▲▲▲▲

                const canvas = document.createElement("canvas");
                const context = canvas.getContext("2d");
                canvas.height = viewport.height;
                canvas.width = viewport.width;

                const textLayer = document.createElement("div");
                textLayer.className = "textLayer";
                textLayer.style.width = `${viewport.width}px`;
                textLayer.style.height = `${viewport.height}px`;
                
                const renderContext = {
                    canvasContext: context,
                    viewport: viewport
                };

                const renderPromise = page.render(renderContext).promise;
                
                const textPromise = renderPromise.then(() => {
                    return page.getTextContent();
                }).then(textContent => {
                    pdfjsLib.renderTextLayer({ textContent, container: textLayer, viewport });
                });

                const pageDiv = document.createElement("div");
                pageDiv.className = "page";
                pageDiv.dataset.pageNumber = pageNum;
                pageDiv.style.width = `${viewport.width}px`;
                pageDiv.style.height = `${viewport.height}px`;
                pageDiv.appendChild(canvas);
                pageDiv.appendChild(textLayer);
                
                const wrap = document.createElement("div");
                wrap.className = "wrap";
                wrap.appendChild(pageDiv);
                
                pageElements[pageNum - 1] = wrap; // 정확한 순서로 배열에 저장
            });

            // 순서대로 DOM에 추가
            pageElements.forEach(el => viewer.appendChild(el));

            // 모든 페이지가 화면에 그려진 후, 저장된 하이라이트를 그림
            setTimeout(renderHighlights, 200);
        });
    });
}

function renderHighlights() {
    document.querySelectorAll(".highlight-span").forEach((el) => el.remove());

    highlights.forEach((h) => {
        const pageDiv = document.querySelector(`.page[data-page-number="${h.page}"]`);
        if (pageDiv && h.rects && Array.isArray(h.rects)) {
            h.rects.forEach((rect) => {
                const highlightSpan = document.createElement("span");
                highlightSpan.className = "highlight-span";
                highlightSpan.style.left = `${rect.left}px`;
                highlightSpan.style.top = `${rect.top}px`;
                highlightSpan.style.width = `${rect.width}px`;
                highlightSpan.style.height = `${rect.height}px`;
                
                highlightSpan.dataset.id = h.id;
                highlightSpan.dataset.text = h.text;
                if (h.tag) {
                    highlightSpan.dataset.tag = h.tag;
                    highlightSpan.classList.add(`tag-${h.tag}`);
                }
                pageDiv.appendChild(highlightSpan);
            });
        }
    });
    updateButtons();
    noteView(currentFilter);
}


// --- ✍️ UNDO/REDO 및 커맨드 패턴 (TEAMMATE'S) ---

function executeCommand(command) {
    undoStack.push(command);
    redoStack = [];
    command.execute();
    updateButtons();
    setTimeout(saveData, 100);
}

function undo() {
    if (undoStack.length > 0) {
        const lastCommand = undoStack.pop();
        lastCommand.undo();
        redoStack.push(lastCommand);
        updateButtons();
        setTimeout(saveData, 100);
    }
}

function redo() {
    if (redoStack.length > 0) {
        const lastUndoneCommand = redoStack.pop();
        lastUndoneCommand.execute();
        undoStack.push(lastUndoneCommand);
        updateButtons();
        setTimeout(saveData, 100);
    }
}

undoButton.addEventListener("click", undo);
redoButton.addEventListener("click", redo);

// --- 커맨드 클래스들 ---
class AddHighlightCommand {
    constructor(pageNumber, rects, text) {
        this.pageNumber = pageNumber;
        this.rects = rects;
        this.text = text;
        this.id = Date.now() + Math.random();
    }
    execute() {
        const newHighlight = { page: this.pageNumber, rects: this.rects, text: this.text, id: this.id, tag: null };
        highlights.push(newHighlight);
        renderHighlights();
        lastSelectedHighlightId = newHighlight.id;
    }
    undo() {
        highlights = highlights.filter((h) => h.id !== this.id);
        renderHighlights();
    }
}

class RemoveHighlightCommand {
    constructor(id) {
        this.id = id;
        this.removedHighlight = highlights.find(h => h.id === this.id);
    }
    execute() {
        highlights = highlights.filter(h => h.id !== this.id);
        renderHighlights();
    }
    undo() {
        if (this.removedHighlight) {
            highlights.push(this.removedHighlight);
            renderHighlights();
        }
    }
}

class AddTagCommand {
    constructor(highlightId, tag) {
        this.highlightId = highlightId;
        this.newTag = tag;
        this.originalTag = highlights.find((h) => h.id === highlightId)?.tag || null;
    }
    execute() {
        const highlight = highlights.find((h) => h.id === this.highlightId);
        if (highlight) highlight.tag = this.newTag;
        renderHighlights();
    }
    undo() {
        const highlight = highlights.find((h) => h.id === this.highlightId);
        if (highlight) highlight.tag = this.originalTag;
        renderHighlights();
    }
}


// --- 💾 데이터 저장/불러오기 로직 (OURS - Firestore 사용) ---

async function saveData() {
    if (!currentUser || !currentFileName) return;
    try {
        // Undo/Redo 스택은 저장하지 않음. 최종 결과만 저장.
        const dataToSave = { highlights };
        const docRef = doc(db, "users", currentUser.uid, "highlights", currentFileName);
        await setDoc(docRef, dataToSave);
        console.log("Firestore에 하이라이트 저장 완료");
    } catch (error) {
        console.error("데이터 저장 실패:", error);
    }
}

async function loadData() {
    if (!currentUser || !currentFileName) return;
    try {
        const docRef = doc(db, "users", currentUser.uid, "highlights", currentFileName);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            const data = docSnap.data();
            highlights = data.highlights || [];
            undoStack = []; // 페이지 로드 시 undo/redo 스택은 초기화
            redoStack = [];
            renderHighlights();
            console.log("Firestore에서 하이라이트 불러오기 완료");
        } else {
            // 저장된 데이터가 없으면 초기화
            highlights = [];
            renderHighlights();
        }
    } catch (error) {
        console.error("데이터 불러오기 실패:", error);
    }
}


// --- 🖊️ 사용자 인터랙션 로직 (TEAMMATE'S 기반 수정) ---

penBtn.addEventListener("click", () => {
    isPenActive = !isPenActive;
    isEraserActive = false;
    isTag = false;
    penBtn.classList.toggle("active");
    eraserBtn.classList.remove("active");
    tagBtn.classList.remove("active");
});

eraserBtn.addEventListener("click", () => {
    isEraserActive = !isEraserActive;
    isPenActive = false;
    isTag = false;
    eraserBtn.classList.toggle("active");
    penBtn.classList.remove("active");
    tagBtn.classList.remove("active");
});

document.addEventListener("click", function (e) {
    if (isEraserActive && e.target.classList.contains("highlight-span")) {
        const highlightId = parseFloat(e.target.dataset.id);
        if (highlightId) {
            executeCommand(new RemoveHighlightCommand(highlightId));
        }
    }
    if (isTag && e.target.classList.contains("highlight-span")) {
        lastSelectedHighlightId = parseFloat(e.target.dataset.id);
        dropdown.classList.add("show");
    }
});

document.addEventListener("mouseup", function () {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !isPenActive) return;

    const range = selection.getRangeAt(0);
    const selectedText = range.toString().trim();
    if (!selectedText) return;

    const pageDiv = range.startContainer.parentElement.closest(".page");
    if (!pageDiv) return;

    const pageNumber = pageDiv.dataset.pageNumber;
    const pageRect = pageDiv.getBoundingClientRect();
    const rects = Array.from(range.getClientRects()).map(r => ({
        left: r.left - pageRect.left,
        top: r.top - pageRect.top,
        width: r.width,
        height: r.height,
    }));
    
    executeCommand(new AddHighlightCommand(pageNumber, rects, selectedText));
    selection.removeAllRanges();
});


// --- 📝 노트 뷰 및 태그 로직 (TEAMMATE'S 기반 수정) ---

function noteView(filterTag) {
    const noteContainer = document.getElementById('highlight-results-container');
    noteContainer.innerHTML = '<h4>📝 나의 밑줄 노트</h4>'; // 타이틀 유지

    const notes = highlights.filter(h => filterTag === 'all' || h.tag === filterTag);

    notes.forEach(note => {
        const noteItem = document.createElement("div");
        noteItem.className = "note-item";
        noteItem.textContent = `[p.${note.page}] ${note.text}`;
        noteItem.style.cursor = "pointer";
        noteItem.addEventListener("click", () => {
            const pageEl = document.querySelector(`.page[data-page-number="${note.page}"]`);
            pageEl?.scrollIntoView({ behavior: "smooth" });
        });
        noteContainer.appendChild(noteItem);
    });
}

document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        currentFilter = tab.dataset.tag;
        noteView(currentFilter);
    });
});

tagBtn.addEventListener("click", () => {
    isTag = !isTag;
    isPenActive = false;
    isEraserActive = false;
    tagBtn.classList.toggle("active");
    penBtn.classList.remove("active");
    eraserBtn.classList.remove("active");
    if (!isTag) dropdown.classList.remove("show");
});

dropdown.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
        const tag = btn.dataset.tag;
        if (lastSelectedHighlightId) {
            executeCommand(new AddTagCommand(lastSelectedHighlightId, tag));
            lastSelectedHighlightId = null;
        }
        isTag = false;
        tagBtn.classList.remove("active");
        dropdown.classList.remove("show");
    });
});


// ---  OCR 결과 리스너 (OURS) ---

function listenToOcrResults(fileName) {
    if (!currentUser || !fileName) return;
    const ocrContainer = document.getElementById("ocr-results-container");
    ocrContainer.innerHTML = "<h4>🖼️ 이미지 분석 결과</h4><p class='placeholder'>분석 중입니다...</p>";
    
    const q = query(
        collection(db, "ocr_results"), 
        where("sourceFile", "==", `uploads/${currentUser.uid}/${fileName}`), 
        orderBy("pageNumber")
    );
    
    onSnapshot(q, (snapshot) => {
        ocrContainer.innerHTML = "<h4>🖼️ 이미지 분석 결과</h4>"; // 초기화
        if (snapshot.empty) {
            ocrContainer.innerHTML += "<p class='placeholder'>분석된 이미지가 없거나 분석 중입니다.</p>";
        } else {
            snapshot.docs.forEach(doc => {
                const data = doc.data();
                const docId = doc.id; // Firestore 문서의 고유 ID

                const resultItem = document.createElement("div");
                resultItem.className = "ocr-item";
                
                // ▼▼▼ 중요 변경 사항 ▼▼▼
                // 텍스트 미리보기를 제거하고, 버튼만 있는 구조로 변경
                resultItem.innerHTML = `
                    <p><b>[${data.pageNumber} 페이지 / 이미지 ${data.imageIndex + 1}]</b></p>
                    <button class="ocr-apply-btn" data-doc-id="${docId}">이미지 글자 표시</button>
                `;
                // ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲
                
                // 버튼에 클릭 이벤트 리스너 추가
                resultItem.querySelector('.ocr-apply-btn').addEventListener('click', () => {
                    drawOcrHighlights(docId);
                });

                ocrContainer.appendChild(resultItem);
            });
        }
    }, (error) => {
        console.error("OCR 결과 수신 실패:", error);
        ocrContainer.innerHTML = "<h4>🖼️ 이미지 분석 결과</h4><p class='placeholder'>결과를 불러오는 데 실패했습니다.</p>";
    });
}

async function drawOcrHighlights(docId) {
    document.querySelectorAll('.ocr-highlight-span').forEach(el => el.remove());

    try {
        const docRef = doc(db, "ocr_results", docId);
        const docSnap = await getDoc(docRef);

        if (!docSnap.exists()) {
            console.error("해당 OCR 문서를 찾을 수 없습니다.");
            return;
        }

        const data = docSnap.data();
        if (!data.words || !data.imageDimensions) return; // 필수 데이터 확인

        const pageNumber = data.pageNumber;
        const words = data.words;
        const originalImgWidth = data.imageDimensions.width;
        const originalImgHeight = data.imageDimensions.height;
        
        const pageDiv = document.querySelector(`.page[data-page-number="${pageNumber}"]`);
        const canvas = pageDiv.querySelector('canvas');
        if (!pageDiv || !canvas) {
            console.error(`${pageNumber} 페이지 또는 캔버스를 찾을 수 없습니다.`);
            return;
        }

        // ▼▼▼ 좌표 변환 로직 시작 ▼▼▼
        const canvasWidth = canvas.width;
        const canvasHeight = canvas.height;
        
        // 원본 이미지 크기와 캔버스 크기의 비율 계산
        const scaleX = canvasWidth / originalImgWidth;
        const scaleY = canvasHeight / originalImgHeight;
        // ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲

        words.forEach(word => {
            const bounds = word.bounds;
            const xs = bounds.map(v => v.x);
            const ys = bounds.map(v => v.y);
            
            // 비율에 맞춰 좌표 변환
            const left = Math.min(...xs) * scaleX;
            const top = Math.min(...ys) * scaleY;
            const width = (Math.max(...xs) - Math.min(...xs)) * scaleX;
            const height = (Math.max(...ys) - Math.min(...ys)) * scaleY;

            const highlightSpan = document.createElement("div");
            highlightSpan.className = "ocr-highlight-span";
            highlightSpan.style.left = `${left}px`;
            highlightSpan.style.top = `${top}px`;
            highlightSpan.style.width = `${width}px`;
            highlightSpan.style.height = `${height}px`;

            pageDiv.appendChild(highlightSpan);
        });

    } catch (error) {
        console.error("OCR 하이라이트 렌더링 실패:", error);
    }
}

runOcrBtn.addEventListener('click', async () => {
    if (!currentUser || !currentFileName) {
        alert("먼저 PDF 파일을 업로드해주세요.");
        return;
    }

    runOcrBtn.disabled = true;
    runOcrBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> OCR 중...';

    const runOcrOnDemand = httpsCallable(functions, 'runOcrOnDemand');
    const filePath = `uploads/${currentUser.uid}/${currentFileName}`;

    try {
        const result = await runOcrOnDemand({ filePath: filePath });
        console.log("OCR 함수 호출 성공:", result.data);
        alert("OCR 분석이 완료되었습니다. 오른쪽 창에서 결과를 확인하세요.");
    } catch (error) {
        console.error("OCR 함수 호출 실패:", error);
        alert(`OCR 분석에 실패했습니다: ${error.message}`);
    } finally {
        runOcrBtn.disabled = false;
        runOcrBtn.innerHTML = '<i class="fa-solid fa-robot fa-xl"></i> OCR';
    }
});