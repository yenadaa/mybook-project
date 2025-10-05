//Firebase SDK 모듈 임포트
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

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);
const functions = getFunctions(app, 'asia-northeast3');

//여기까지 코드 맨 위에다가 추가하시면 됩니다

pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";

let loadedPdf = null;           // 로드된 PDF 객체를 저장할 변수
let currentUser = null;         // 현재 로그인된 사용자 정보를 저장할 변수
let currentFileName = null;     // 현재 열려있는 PDF 파일의 이름을 저장할 변수
let highlights = [];            // 사용자가 만든 밑줄/하이라이트 데이터를 저장하는 배열

// 사용자의 현재 도구 선택 상태를 관리하는 변수들
let isPenActive = false;        // 일반 밑줄 펜 활성화 여부
let isEraserActive = false;     // 지우개 활성화 여부
let isOcrPenActive = false;     // OCR 펜 활성화 여부
let isDrawing = false;          // OCR 펜으로 드래그 중인지 여부
let ocrRect = {};               // OCR 펜으로 드래그한 사각형의 좌표 정보
let selectionBox = null;        // 드래그 영역을 시각적으로 보여주는 DOM 요소

// 기타 UI 상태 관리 변수
let currentFilter = "all";      // 현재 선택된 노트 필터 종류 (예: "all", "중요")

const viewer = document.getElementById("pdf-container");        // PDF 페이지가 렌더링될 메인 뷰어 영역
const chalkboard = document.getElementById("chalkboard");       // 파일 업로드 전 초기 화면
const bookLayout = document.getElementById("book-layout");      // 파일 업로드 후 PDF가 보일 메인 레이아웃

// 인증 관련 UI 요소
const loginBtn = document.getElementById("login-btn");          // 로그인 버튼
const logoutBtn = document.getElementById("logout-btn");        // 로그아웃 버튼
const userInfo = document.getElementById("user-info");          // 사용자 정보(이메일, 로그아웃 버튼)를 감싸는 영역
const userEmail = document.getElementById("user-email");        // 사용자 이메일이 표시될 영역

// 파일 및 도구 관련 UI 요소
const fileInput = document.getElementById("file-btn");          // 실제 파일 입력을 담당하는 숨겨진 input 요소
const penBtn = document.getElementById("pen1");                 // 일반 밑줄 펜 버튼
const eraserBtn = document.getElementById("eraser-btn");        // 지우개 버튼
const ocrPenBtn = document.getElementById("ocr-pen-btn");       // OCR 펜 버튼


/**
 * onAuthStateChanged: 사용자의 로그인 상태가 변경될 때마다 자동으로 실행되는 리스너입니다.
 */
onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        loginBtn.style.display = 'none';
        userInfo.style.display = 'block';
        userEmail.textContent = user.email;
        loadLastFile();
        displayTodaysReviews();
    } else {
        // 사용자가 로그아웃한 경우
        currentUser = null;
        loginBtn.style.display = 'block';
        userInfo.style.display = 'none';
    }
});

// "로그인" 버튼 클릭 시 Google 로그인 팝업창을 띄웁니다.
loginBtn.addEventListener('click', () => {
    const provider = new GoogleAuthProvider();
    signInWithPopup(auth, provider).catch(error => console.error("로그인 실패:", error));
});

// "로그아웃" 버튼 클릭 시 로그아웃을 실행합니다.
logoutBtn.addEventListener('click', () => {
    signOut(auth).catch(error => console.error("로그아웃 실패:", error));
});

// "OCR 펜" 버튼 클릭 시 OCR 모드를 켜고 끕니다.
ocrPenBtn.addEventListener("click", () => {
    isOcrPenActive = !isOcrPenActive;
    ocrPenBtn.classList.toggle("active");
    // 다른 펜 모드는 비활성화합니다.
    isPenActive = false; 
    penBtn.classList.remove("active");
});

// PDF 뷰어 위에서 마우스를 누를 때 (드래그 시작)
viewer.addEventListener("mousedown", (e) => {
    if (!isOcrPenActive) return; // OCR 모드가 아니면 종료

    isDrawing = true;
    const rect = viewer.getBoundingClientRect();
    ocrRect.startX = e.clientX - rect.left;
    ocrRect.startY = e.clientY - rect.top;

    selectionBox = document.createElement('div');
    selectionBox.id = 'selection-box';
    selectionBox.style.left = `${ocrRect.startX}px`;
    selectionBox.style.top = `${ocrRect.startY}px`;
    viewer.appendChild(selectionBox);
});

// 마우스를 움직일 때 (드래그 중)
viewer.addEventListener("mousemove", (e) => {
    if (!isDrawing || !isOcrPenActive) return;
    
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

// 마우스에서 손을 뗄 때 (드래그 끝 & OCR 실행)
viewer.addEventListener("mouseup", async (e) => {
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

        // 선택 영역을 잘라내어 이미지 데이터로 변환합니다.
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

        // 백엔드(Cloud Function)에 OCR을 요청합니다.
        ocrPenBtn.textContent = "인식 중...";
        ocrPenBtn.disabled = true;
        try {
            const runOcrOnSelection = httpsCallable(functions, 'runOcrOnSelection');
            const result = await runOcrOnSelection({ imageData: base64ImageData });
            const ocrText = result.data.text;
            
            if (ocrText) {
                // OCR 결과를 받아와 노트에 추가합니다.
                const newHighlight = { page: pageNumber, text: ocrText.trim(), id: Date.now(), rects: [] };
                highlights.push(newHighlight);
                noteView(currentFilter); // 노트 목록 UI를 업데이트하는 함수
                setTimeout(saveData, 100);   // DB에 결과를 저장하는 함수
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
        return;
    }
})

/* 사용자가 드래그하는 선택 영역을 시각적으로 보여주기 위한 스타일(main.css에 넣으면 됩니다. 안넣어도 되요)
*   #selection-box {
*  position: absolute;
*  border: 2px dashed #007bff;
*  background-color: rgba(0, 123, 255, 0.2);
*  z-index: 10;
*  pointer-events: none; 
}*/ 