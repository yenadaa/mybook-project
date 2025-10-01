// ✨ Firebase SDK 모듈 임포트
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, collection, onSnapshot, query, where, orderBy } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";
import { getAuth, GoogleAuthProvider, signOut, onAuthStateChanged, signInWithPopup } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-functions.js";


// ✨ Firebase 설정 
const firebaseConfig = {
    apiKey: "AIzaSyAeWQaegsc3H01i8qkNoyFZX6CcaW-iJ2g",
    authDomain: "mybook-d143d.firebaseapp.com",
    projectId: "mybook-d143d",
    storageBucket: "mybook-d143d.firebasestorage.app",
    messagingSenderId: "427068485624",
    appId: "1:427068485624:web:7a4ec49fe9afca7078700d",
    measurementId: "G-N8R4MKD233"
};

// ✨ Firebase 서비스 초기화
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);
const functions = getFunctions(app, 'asia-northeast3'); 

// --- 전역 변수 및 상수 ---
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";

// ✨ 1. PDF 객체를 저장할 전역 변수 생성
let loadedPdf = null; 
let currentUser = null;
let currentFileName = null;
let isPenActive = false;
let isEraserActive = false;
let isTag = false;
let currentFilter = "all";
let highlights = []; 
let lastSelectedHighlightId = null;
let isOcrPenActive = false;
let ocrRect = {};
let isDrawing = false;
let selectionBox = null;


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
const runOcrBtn = document.getElementById("run-ocr-btn");
const ocrPenBtn = document.getElementById("ocr-pen-btn");

// --- 인증 로직 ---
onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        loginBtn.style.display = 'none';
        userInfo.style.display = 'block';
        userEmail.textContent = user.email;
        loadLastFile();
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


// --- 파일 업로드 로직 ---
chalkboard.addEventListener("click", function() {
    if (!currentUser) {
        alert("로그인이 필요합니다.");
        return;
    }
    fileInput.click();
});

fileInput.addEventListener("change", function(e) {
    const file = e.target.files[0];

    console.log("파일 업로드 시도!");
    console.log("currentUser 변수:", currentUser);
    console.log("Firebase Auth SDK 상태:", auth.currentUser);   
    if (!file || !currentUser) {
        console.error("파일이 없거나 로그인이 되어있지 않아 업로드를 중단합니다.");
        return;
    }
    if (!file || !currentUser) return;
    
    chalkboard.querySelector('p').textContent = "업로드 중...";
    const storageRef = ref(storage, `uploads/${currentUser.uid}/${file.name}`);
    
    uploadBytes(storageRef, file).then((snapshot) => {
        console.log("Firebase Storage에 업로드 성공!");
        currentFileName = file.name;
        localStorage.setItem("lastUploadedFile", file.name);
        
        highlights = [];
        
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


// --- PDF 렌더링 및 하이라이트 로직 ---
function renderPDF(url) {
    viewer.innerHTML = "";
    loadData();

    const loadingTask = pdfjsLib.getDocument(url);
    
    loadingTask.promise.then((pdf) => {
        // ✨ 2. PDF 객체를 전역 변수에 저장
        loadedPdf = pdf; 

        const pagePromises = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            pagePromises.push(pdf.getPage(i));
        }

        Promise.all(pagePromises).then(pages => {
            pages.forEach(page => {
                const pageNum = page.pageNumber;
                const containerWidth = viewer.clientWidth;
                let viewport = page.getViewport({ scale: 1.0 });
                const scale = containerWidth / viewport.width;
                viewport = page.getViewport({ scale });
                
                const canvas = document.createElement("canvas");
                const context = canvas.getContext("2d");
                canvas.height = viewport.height;
                canvas.width = viewport.width;

                const textLayer = document.createElement("div");
                textLayer.className = "textLayer";
                textLayer.style.width = `${viewport.width}px`;
                textLayer.style.height = `${viewport.height}px`;
                
                const renderContext = { canvasContext: context, viewport: viewport };

                page.render(renderContext).promise.then(() => {
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
                
                viewer.appendChild(pageDiv);
            });
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
                pageDiv.appendChild(highlightSpan);
            });
        }
    });
    noteView(currentFilter);
}

// --- 데이터 저장/불러오기 로직 ---
async function saveData() {
    if (!currentUser || !currentFileName) return;
    try {
        const dataToSave = { highlights };
        const docRef = doc(db, "users", currentUser.uid, "highlights", currentFileName);
        await setDoc(docRef, dataToSave);
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
            renderHighlights();
        } else {
            highlights = [];
            renderHighlights();
        }
    } catch (error) {
        console.error("데이터 불러오기 실패:", error);
    }
}


// --- 사용자 인터랙션 로직 ---
penBtn.addEventListener("click", () => {
    isPenActive = !isPenActive;
    isEraserActive = false;
    penBtn.classList.toggle("active");
    eraserBtn.classList.remove("active");
});

eraserBtn.addEventListener("click", () => {
    isEraserActive = !isEraserActive;
    isPenActive = false;
    eraserBtn.classList.toggle("active");
    penBtn.classList.remove("active");
});

document.addEventListener("click", function (e) {
    if (isEraserActive && e.target.classList.contains("highlight-span")) {
        const highlightId = parseFloat(e.target.dataset.id);
        if (highlightId) {
            highlights = highlights.filter(h => h.id !== highlightId);
            renderHighlights();
            setTimeout(saveData, 100);
        }
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
    
    const newHighlight = { page: pageNumber, rects: rects, text: selectedText, id: Date.now() + Math.random(), tag: null };
    highlights.push(newHighlight);
    renderHighlights();
    setTimeout(saveData, 100);
    selection.removeAllRanges();
});


// --- 노트 뷰 및 태그 로직 ---
function noteView(filterTag) {
    const noteContainer = document.getElementById('highlight-results-container');
    noteContainer.innerHTML = '<h4>📝 나의 밑줄 노트</h4>';

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

// --- OCR 로직 ---
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
        ocrContainer.innerHTML = "<h4>🖼️ 이미지 분석 결과</h4>";
        if (snapshot.empty) {
            ocrContainer.innerHTML += "<p class='placeholder'>분석된 이미지가 없거나 분석 중입니다.</p>";
        } else {
            snapshot.docs.forEach(doc => {
                const data = doc.data();
                const docId = doc.id;

                const resultItem = document.createElement("div");
                resultItem.className = "ocr-item";
                resultItem.innerHTML = `<p><b>[${data.pageNumber} 페이지 / 이미지 ${data.imageIndex + 1}]</b></p>
                                        <button class="ocr-apply-btn" data-doc-id="${docId}">이미지 글자 표시</button>`;
                
                resultItem.querySelector('.ocr-apply-btn').addEventListener('click', () => {
                    drawOcrHighlights(docId);
                });

                ocrContainer.appendChild(resultItem);
            });
        }
    });
}


// 1. OCR 펜 버튼 클릭 이벤트
ocrPenBtn.addEventListener("click", () => {
    isOcrPenActive = !isOcrPenActive;
    ocrPenBtn.classList.toggle("active");
    // 다른 펜들은 비활성화
    isPenActive = false;
    isEraserActive = false;
    penBtn.classList.remove("active");
    eraserBtn.classList.remove("active");
});

// 2. PDF 뷰어에 그리기 이벤트 리스너 추가
viewer.addEventListener("mousedown", (e) => {
    if (!isOcrPenActive) return;

    // ✨ 기존 selectionBox가 남아있으면 삭제
    if (selectionBox) {
        selectionBox.remove();
    }

    isDrawing = true;
    const rect = viewer.getBoundingClientRect();
    ocrRect.startX = e.clientX - rect.left;
    ocrRect.startY = e.clientY - rect.top;

    // ✨ selectionBox 요소 생성 및 초기화
    selectionBox = document.createElement('div');
    selectionBox.id = 'selection-box';
    selectionBox.style.left = `${ocrRect.startX}px`;
    selectionBox.style.top = `${ocrRect.startY}px`;
    selectionBox.style.width = '0px';
    selectionBox.style.height = '0px';
    viewer.appendChild(selectionBox); // 뷰어에 추가
});

viewer.addEventListener("mousemove", (e) => {
    if (!isDrawing || !isOcrPenActive) return;
    
    // ✨ 마우스 위치에 따라 사각형 크기 및 위치 실시간 변경
    const rect = viewer.getBoundingClientRect();
    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;

    const left = Math.min(ocrRect.startX, currentX);
    const top = Math.min(ocrRect.startY, currentY);
    const width = Math.abs(ocrRect.startX - currentX);
    const height = Math.abs(ocrRect.startY - currentY);
    
    selectionBox.style.left = `${left}px`;
    selectionBox.style.top = `${top}px`;
    selectionBox.style.width = `${width}px`;
    selectionBox.style.height = `${height}px`;
});

viewer.addEventListener("mouseup", async (e) => {
    if (selectionBox) {
        selectionBox.remove();
        selectionBox = null;
    }
    if (!isDrawing || !isOcrPenActive) return;
    isDrawing = false;
    const rect = viewer.getBoundingClientRect();
    ocrRect.endX = e.clientX - rect.left;
    ocrRect.endY = e.clientY - rect.top;

    // 드래그한 영역의 페이지와 캔버스 찾기
    const pageDiv = e.target.closest(".page");
    if (!pageDiv) return;
    const canvas = pageDiv.querySelector("canvas");
    const pageNumber = pageDiv.dataset.pageNumber;

    // 3. 선택 영역을 잘라내어 Base64 이미지로 변환
    const left = Math.min(ocrRect.startX, ocrRect.endX);
    const top = Math.min(ocrRect.startY, ocrRect.endY);
    const width = Math.abs(ocrRect.startX - ocrRect.endX);
    const height = Math.abs(ocrRect.startY - ocrRect.endY);

    if (width < 10 || height < 10) return; // 너무 작은 영역은 무시

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = width;
    tempCanvas.height = height;
    const tempCtx = tempCanvas.getContext("2d");
    tempCtx.drawImage(canvas, left, top, width, height, 0, 0, width, height);
    
    // data:image/png;base64,... 형태의 이미지 데이터
    const imageDataUrl = tempCanvas.toDataURL("image/png");
    // "data:image/png;base64," 부분을 제거
    const base64ImageData = imageDataUrl.split(',')[1]; 

    // 4. 새로운 Cloud Function 호출
    ocrPenBtn.textContent = "인식 중...";
    ocrPenBtn.disabled = true;

    try {
        const runOcrOnSelection = httpsCallable(functions, 'runOcrOnSelection');
        const result = await runOcrOnSelection({ imageData: base64ImageData });
        const ocrText = result.data.text;
        
        if (ocrText) {
            // 인식된 텍스트를 밑줄 노트에 추가 (기존 하이라이트 기능 재활용)
             const newHighlight = { page: pageNumber, text: ocrText.trim(), id: Date.now(), rects: [] }; // rects는 시각적 표시가 아니므로 비워둠
             highlights.push(newHighlight);
             noteView(currentFilter); // 노트 뷰 업데이트
             setTimeout(saveData, 100); // Firestore에 저장
            alert("텍스트 인식 성공!");
        } else {
            alert("인식된 텍스트가 없습니다.");
        }

    } catch (error) {
        console.error("OCR 인식 실패:", error);
        alert("OCR 인식에 실패했습니다.");
    } finally {
        ocrPenBtn.textContent = "OCR 펜";
        ocrPenBtn.disabled = false;
    }
});


// ✨ 3. 전역 변수를 사용하는 최종 버전의 drawOcrHighlights 함수
async function drawOcrHighlights(docId) {
    document.querySelectorAll('.ocr-highlight-span').forEach(el => el.remove());

    if (!loadedPdf) {
        console.error("PDF가 로드되지 않았습니다.");
        return;
    }

    try {
        const docRef = doc(db, "ocr_results", docId);
        const docSnap = await getDoc(docRef);

        if (!docSnap.exists()) {
            console.error("해당 OCR 문서를 찾을 수 없습니다.");
            return;
        }

        const data = docSnap.data();
        if (!data.words || !data.imageDimensions || !data.imageBoundsOnPage) {
            console.error("OCR 데이터에 필수 위치 정보가 없습니다.");
            return;
        }

        const pageNumber = data.pageNumber;
        const page = await loadedPdf.getPage(pageNumber);
        const pageViewport = page.getViewport({ scale: 1.0 });

        const pageDiv = document.querySelector(`.page[data-page-number="${pageNumber}"]`);
        const canvas = pageDiv.querySelector('canvas');
        if (!pageDiv || !canvas) return;

        const scale = canvas.width / pageViewport.width;
        
        const imageBounds = data.imageBoundsOnPage;
        const originalImgWidth = data.imageDimensions.width;

        const imageBoxLeftOnCanvas = imageBounds.left * scale;
        const imageBoxTopOnCanvas = imageBounds.top * scale;
        const imageBoxWidthOnCanvas = imageBounds.width * scale;
        const imageBoxHeightOnCanvas = imageBounds.height * scale;
        
        const scaleX = imageBoxWidthOnCanvas / originalImgWidth;
        const scaleY = imageBoxHeightOnCanvas / data.imageDimensions.height; 

        data.words.forEach(word => {
            const bounds = word.bounds;
            const xs = bounds.map(v => v.x);
            const ys = bounds.map(v => v.y);

            const left = imageBoxLeftOnCanvas + (Math.min(...xs) * scaleX);
            const top = imageBoxTopOnCanvas + (Math.min(...ys) * scaleY);
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
