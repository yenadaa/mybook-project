// Firebase SDK 모듈 임포트
//  Firebase 앱 초기화 (필수)
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";

// Firebase 인증 (로그인, 사용자 관리)
import { getAuth, GoogleAuthProvider, signOut, onAuthStateChanged, signInWithPopup } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
// Firestore DB (데이터 읽기/쓰기/수정)
import { 
    getFirestore, 
    doc, 
    setDoc,
    updateDoc, 
    getDoc, 
    getDocs, // 'getTodaysReviews' 함수에 필요
    collection, 
    addDoc, // 'saveHighlight' 함수에 필요
    onSnapshot, 
    query, 
    where, 
    orderBy,
    Timestamp // 'saveHighlight', 'getTodaysReviews' 함수에 필요
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

// Firebase Storage (이미지, PDF 등 파일 업로드)
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-storage.js";

// Firebase Functions (백엔드 함수 호출)
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-functions.js";

import { getMessaging, getToken } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging.js";


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

        // 1. 오늘의 복습 목록 표시
        displayTodaysReviews();
        // 2. 알림 권한 팝업 띄우기
        requestNotificationPermission();
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

    // 데이터 로딩 함수 호출 (밑줄 그리기는 여기서 하지 않음)
    if (currentUser && currentFileName) {
        listenToHighlights(currentUser.uid, currentFileName);
    }

    const loadingTask = pdfjsLib.getDocument(url);
    
    loadingTask.promise.then((pdf) => {
        loadedPdf = pdf; // 전역 변수에 PDF 객체 저장

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
            // [수정] 여기서 setTimeout(renderHighlights, 200); 코드를 완전히 삭제했습니다.
        });
    });
}

function renderHighlights() {
    document.querySelectorAll(".highlight-span").forEach((el) => el.remove());

    highlights.forEach((h) => {
        const pageDiv = document.querySelector(`.page[data-page-number="${h.pageNumber}"]`);
        
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
    
    // 밑줄 그리기가 끝난 후 오른쪽 노트 뷰도 업데이트
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
/*
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
*/

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


// --- 노트 뷰 및 태그 로직 ---
function noteView(filterTag) {
    const noteContainer = document.getElementById('highlight-results-container');
    noteContainer.innerHTML = '<h4>📝 나의 밑줄 노트</h4>';

    const notes = highlights.filter(h => filterTag === 'all' || h.tag === filterTag);

    notes.forEach(note => {
        const noteItem = document.createElement("div");
        noteItem.className = "note-item";
        noteItem.textContent = `[p.${note.pageNumber}] ${note.ocrText}`;
        noteItem.style.cursor = "pointer";
        noteItem.addEventListener("click", () => {
            const pageEl = document.querySelector(`.page[data-page-number="${note.pageNumber}"]`);
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
    // --- OCR 펜 로직 (드래그 종료 처리) ---
    if (isOcrPenActive) {
        if (selectionBox) {
            selectionBox.remove();
            selectionBox = null;
        }
        if (!isDrawing) return;
        isDrawing = false;
        
        const rect = viewer.getBoundingClientRect();
        ocrRect.endX = e.clientX - rect.left;
        ocrRect.endY = e.clientY - rect.top;

        const pageDiv = e.target.closest(".page");
        if (!pageDiv) return;
        const canvas = pageDiv.querySelector("canvas");
        const pageNumber = pageDiv.dataset.pageNumber;

        const left = Math.min(ocrRect.startX, ocrRect.endX);
        const top = Math.min(ocrRect.startY, ocrRect.endY);
        const width = Math.abs(ocrRect.startX - ocrRect.endX);
        const height = Math.abs(ocrRect.startY - ocrRect.endY);

        if (width < 10 || height < 10) return;

        const rects = [{ left, top, width, height }];

        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = width;
        tempCanvas.height = height;
        const tempCtx = tempCanvas.getContext("2d");
        
        const canvasRect = canvas.getBoundingClientRect();
        const viewerRect = viewer.getBoundingClientRect();
        const canvasLeftInViewer = canvasRect.left - viewerRect.left;
        const canvasTopInViewer = canvasRect.top - viewerRect.top;

        tempCtx.drawImage(canvas, left - canvasLeftInViewer, top - canvasTopInViewer, width, height, 0, 0, width, height);
        
        const imageDataUrl = tempCanvas.toDataURL("image/png");
        const base64ImageData = imageDataUrl.split(',')[1]; 

        ocrPenBtn.textContent = "인식 중...";
        ocrPenBtn.disabled = true;

        try {
            const runOcrOnSelection = httpsCallable(functions, 'runOcrOnSelection');
            const result = await runOcrOnSelection({ imageData: base64ImageData });
            const ocrText = result.data.text;
            
            if (ocrText && ocrText.trim()) {
                // 수정된 부분: 새로운 saveHighlight 함수를 호출하여 개별 문서로 저장합니다.
                await saveHighlight(ocrText.trim(), [], "", currentUser.uid, currentFileName, pageNumber, rects);
                alert("텍스트 인식 및 저장 성공!");
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
        return; // OCR 펜 로직이 실행되었으면 여기서 종료
    }
    // --- 일반 밑줄 펜 로직 ---
// --- 일반 밑줄 펜 로직 ---
    if (isPenActive) {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) return;

        const range = selection.getRangeAt(0);
        const selectedText = range.toString().trim();
        if (!selectedText) {
            selection.removeAllRanges();
            return;
        }

        const pageDiv = range.startContainer.parentElement.closest(".page");
        if (!pageDiv) {
            selection.removeAllRanges();
            return;
        }
        const pageNumber = pageDiv.dataset.pageNumber;
        
        // 1. 먼저 좌표(rects)를 계산합니다.
        const pageRect = pageDiv.getBoundingClientRect();
        const rects = Array.from(range.getClientRects()).map(r => ({
            left: r.left - pageRect.left,
            top: r.top - pageRect.top,
            width: r.width,
            height: r.height,
        }));

        // 2. 계산된 모든 정보(selectedText, pageNumber, rects)를 함께 저장합니다.
        await saveHighlight(selectedText, [], "", currentUser.uid, currentFileName, pageNumber, rects);
        
        // 3. 마지막으로 선택 영역을 해제합니다.
        selection.removeAllRanges();
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

// '저장' 버튼 클릭 시 실행될 함수
async function saveHighlight(ocrText, tags, memo, userId, bookId, pageNumber, rects) {
  try {
    const now = new Date();
    const nextReviewDate = new Date(now.getTime() +1 *60 * 1000); //1분

    const highlightData = {
      userId: userId,
      bookId: bookId,
      ocrText: ocrText,
      pageNumber: pageNumber,
      rects: rects,
      tags: tags,
      memo: memo,
      createdAt: Timestamp.fromDate(now),
      lastReviewedAt: Timestamp.fromDate(now),
      reviewStage: 0,
      nextReviewDate: Timestamp.fromDate(nextReviewDate)
    };

    const docRef = await addDoc(collection(db, "highlights"), highlightData);
    
    console.log("하이라이트 저장 성공! 문서 ID: ", docRef.id);
    // "저장되었습니다" 알림창은 제거된 상태입니다.

  } catch (error) {
    console.error("하이라이트 저장 실패: ", error);
    alert("저장에 실패했습니다.");
  }
}

//오늘 복습할 내용 불러오기
async function getTodaysReviews(userId) {
  try {
    const highlightsRef = collection(db, "highlights");

    // 1. 쿼리를 만듭니다.
    // - userId가 내 ID와 같고,
    // - nextReviewDate가 지금 이 시간보다 이전(<=)인 문서들을 찾습니다.
    const q = query(
      highlightsRef,
      where("userId", "==", userId),
      where("nextReviewDate", "<=", Timestamp.now()),
      orderBy("nextReviewDate") 
    );

    // 2. 쿼리를 실행하여 문서들을 가져옵니다.
    const querySnapshot = await getDocs(q);
    const reviews = [];
    querySnapshot.forEach((doc) => {
      reviews.push({ id: doc.id, ...doc.data() });
    });

    console.log("오늘 복습할 내용:", reviews);
    return reviews; // 이 데이터를 화면에 표시해주면 됩니다.

  } catch (error) {
    console.error("복습 데이터 로딩 실패: ", error);
    return [];
  }
}

// --- 실시간 데이터 불러오기 로직 ---
function listenToHighlights(userId, bookId) {
  const highlightsRef = collection(db, "highlights");
  const q = query(
    highlightsRef, 
    where("userId", "==", userId), 
    where("bookId", "==", bookId)
  );

  onSnapshot(q, (snapshot) => {
    const loadedHighlights = [];
    snapshot.forEach((doc) => {
      loadedHighlights.push({ id: doc.id, ...doc.data() });
    });
    
    highlights = loadedHighlights; 
    renderHighlights();
    
    console.log("✅ 실시간 밑줄 데이터 로딩 및 그리기 완료:", highlights);

  }, (error) => {
    console.error("🔥 실시간 데이터 로딩 실패:", error);
  });
} // listenToHighlights 함수는 여기서 끝납니다.


// --- 퀴즈 버튼 이벤트 리스너 ---
const quizBtn = document.getElementById("quiz-btn");

if(quizBtn) { // 버튼이 없을 수도 있으니 안전장치 추가
    quizBtn.addEventListener('click', async () => {
        if (!currentUser || !currentFileName) {
            alert("먼저 책을 선택해주세요.");
            return;
        }

        quizBtn.disabled = true;
        quizBtn.textContent = "퀴즈 생성 중...";

        try {
            const generateQuiz = httpsCallable(functions, 'generateQuiz');
            const result = await generateQuiz({ bookId: currentFileName });

            displayQuiz(result.data.quiz);

        } catch (error) {
            console.error("퀴즈 생성 실패:", error);
            alert("퀴즈 생성에 실패했습니다.");
        } finally {
            quizBtn.disabled = false;
            quizBtn.textContent = "퀴즈 만들기";
        }
    });
}


// --- 퀴즈 표시 함수 ---
function displayQuiz(quizArray) {
    const quizContainer = document.getElementById("quiz-container");
    if (!quizContainer) return;
    quizContainer.innerHTML = "";

    if (!quizArray || !Array.isArray(quizArray)) {
        quizContainer.innerHTML = `<p>${quizArray || "퀴즈를 생성할 수 없습니다."}</p>`;
        return;
    }

    quizArray.forEach((q, index) => {
        const questionDiv = document.createElement('div');
        questionDiv.innerHTML = `
            <h4>${index + 1}. ${q.question}</h4>
            <ul>
                ${q.options.map(opt => `<li>${opt}</li>`).join('')}
            </ul>
            <p><b>정답:</b> ${q.answer}</p>
        `;
        quizContainer.appendChild(questionDiv);
    });
}


// --- 복습 관련 함수들 ---
async function completeReview(highlightId, currentStage) {
    const docRef = doc(db, "highlights", highlightId);
    const nextStage = currentStage + 1;
    const nextReviewDate = calculateNextReviewDate(nextStage);

    await updateDoc(docRef, {
        reviewStage: nextStage,
        lastReviewedAt: Timestamp.now(),
        nextReviewDate: Timestamp.fromDate(nextReviewDate)
    });

    console.log(`${highlightId} 복습 완료! 다음 단계: ${nextStage}`);
    // 복습 완료 후 목록을 바로 갱신
    displayTodaysReviews();
}

function calculateNextReviewDate(stage) {
    const now = new Date();
    switch (stage) {
        case 1: return new Date(now.setDate(now.getDate() + 1));
        case 2: return new Date(now.setDate(now.getDate() + 7));
        case 3: return new Date(now.setDate(now.getDate() + 16));
        case 4: return new Date(now.setDate(now.getDate() + 35));
        default: return new Date(now.setFullYear(now.getFullYear() + 10));
    }
}

async function displayTodaysReviews() {
    console.log("1. displayTodaysReviews 함수 실행 시작");
    if (!currentUser) {
        console.log("사용자 정보가 없어서 중단합니다.");
        return;
    }

    const reviewContainer = document.getElementById("review-container");
    if(!reviewContainer) {
        console.error("오류: id='review-container'인 HTML 요소를 찾을 수 없습니다!");
        return;
    }
    console.log("2. review-container 요소를 찾았습니다.");

    try {
        const reviews = await getTodaysReviews(currentUser.uid);
        console.log("3. getTodaysReviews 함수로부터 받은 데이터:", reviews);

        reviewContainer.innerHTML = "";

        if (reviews.length === 0) {
            console.log("4-1. 복습할 항목이 없어서 메시지를 표시합니다.");
            reviewContainer.innerHTML = "<p>오늘 복습할 항목이 없습니다. ✨</p>";
            return;
        }

        console.log("4-2. 복습할 항목이 있어서 목록을 생성합니다.");
        reviews.forEach(item => {
            const reviewItem = document.createElement("div");
            reviewItem.className = "review-item";
            reviewItem.innerHTML = `
                <p>${item.ocrText}</p>
                <button class="review-done-btn">복습 완료</button>
            `;

            reviewItem.querySelector('.review-done-btn').addEventListener('click', () => {
                completeReview(item.id, item.reviewStage);
            });

            reviewContainer.appendChild(reviewItem);
        });

    } catch (error) {
        console.error("displayTodaysReviews 함수 실행 중 오류 발생:", error);
    }
}

// --- 알림 권한 요청 함수 ---
async function requestNotificationPermission() {
    if (!currentUser) return;

    console.log('알림 권한을 요청합니다...');
    try {
        const permission = await Notification.requestPermission();

        if (permission === 'granted') {
            console.log('알림 권한이 허용되었습니다.');
            const messaging = getMessaging();
            const vapidKey = "BJUxXLJCZi0NhC-HHQwAx3zYgTpPsoD5smYhRSOQw81-_Ciiw_r_yJRyPuYNHItyfLjIXlQkHcxo7pyXsb-YVHg";
            
            // ✨ 수정된 부분: 서비스 워커가 준비될 때까지 기다립니다.
            console.log("서비스 워커 준비를 기다립니다...");
            const registration = await navigator.serviceWorker.ready;
            console.log("서비스 워커가 준비되었습니다:", registration);

            // 준비된 서비스 워커를 사용하여 토큰을 요청합니다.
            const fcmToken = await getToken(messaging, { 
                vapidKey: vapidKey,
                serviceWorkerRegistration: registration // registration 객체를 명시적으로 전달
            });

            if (fcmToken) {
                console.log('FCM 토큰:', fcmToken);
                const userDocRef = doc(db, "users", currentUser.uid);
                await setDoc(userDocRef, { fcmToken: fcmToken }, { merge: true });
                console.log("FCM 토큰이 Firestore에 저장되었습니다.");
            } else {
                console.log('FCM 토큰을 발급받을 수 없습니다.');
            }
        } else {
            console.log('알림 권한이 거부되었습니다.');
        }
    } catch (error) {
        console.error('알림 권한 요청 또는 토큰 발급 중 오류 발생:', error);
    }
}

// --- 버튼 이벤트 리스너들 ---
const refreshBtn = document.getElementById("refresh-reviews-btn");
if (refreshBtn) {
    refreshBtn.addEventListener('click', displayTodaysReviews);
}

const testBtn = document.getElementById("test-notification-btn");
if (testBtn) {
    testBtn.addEventListener('click', async () => {
        try {
            const testSend = httpsCallable(functions, 'testSendNotification');
            await testSend();
            alert("테스트 알림을 요청했습니다! 잠시 후 알림을 확인하세요.");
        } catch (error) {
            console.error("테스트 알림 요청 실패:", error);
            alert("테스트 알림 요청에 실패했습니다.");
        }
    });
}