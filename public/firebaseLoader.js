// A.firebase.js에서 storage 관련 기능 가져오기
import { storage, ref, getDownloadURL } from "./A.firebase.js";

// viewer.js가 사용하는 HTML 요소 ID들
const pagesContainer = document.getElementById("pages");
const emptyMessage = document.getElementById("empty");

// auth.js에서 'authStateChanged' (로그인/로그아웃) 신호가 오면 실행
document.addEventListener('authStateChanged', (event) => {
    const user = event.detail.user;
    if (!user) { // 로그아웃 시에만 작동
        console.log("로그아웃 감지. 뷰어 초기화.");
        if (window.clearDocument) {
             window.clearDocument();
        } else {
            if (emptyMessage) emptyMessage.style.display = 'grid';
            if (pagesContainer) pagesContainer.style.display = 'none';
        }
    }
    // 로그인 시에는 아무것도 하지 않습니다.
    // PDF 로딩은 doc.js의 openDoc 함수가 loadPdfFromStorage를 호출할 때 시작됩니다.
});

/**
 * Firebase Storage에서 PDF를 ArrayBuffer(데이터 덩어리)로 가져와서
 * viewer.js의 renderDocument 함수에게 넘겨줍니다.
 * @param {StorageReference} storageRef - PDF 파일의 Firebase Storage 참조
 */
async function loadPdfFromStorage(storageRef) {
    if (!storageRef) {
        console.error("Storage 참조가 없습니다.");
        if (emptyMessage) emptyMessage.innerHTML = `<p style="color: red;">PDF 경로 정보 없음.</p>`;
        return;
    }

    // 로딩 시작 시 UI 업데이트 (선택 사항)
    if (emptyMessage) emptyMessage.textContent = 'PDF 로딩 중...';
    if (emptyMessage) emptyMessage.style.display = 'grid';
    if (pagesContainer) pagesContainer.style.display = 'none';

    try {
        const url = await getDownloadURL(storageRef); // 다운로드 URL 가져오기
        const response = await fetch(url); // URL에서 데이터 가져오기
        if (!response.ok) throw new Error(`PDF 다운로드 실패: ${response.statusText}`);
        const arrayBuffer = await response.arrayBuffer(); // 데이터를 ArrayBuffer로 변환

        // viewer.js의 renderDocument 함수 호출하여 데이터 전달
        if (window.renderDocument) {
            // renderDocument가 성공적으로 PDF를 그리면 emptyMessage 숨김 처리됨 (viewer.js 내부 로직)
            window.renderDocument(arrayBuffer);
            console.log("PDF 데이터를 viewer.js로 전달 완료.");
        } else {
            console.error("viewer.js에 renderDocument 함수가 없습니다.");
            if (emptyMessage) emptyMessage.innerHTML = `<p style="color: red;">뷰어 초기화 오류.</p>`;
        }

    } catch (error) {
        console.error("Firebase PDF 로딩 오류:", error);
        if (emptyMessage) {
            emptyMessage.innerHTML = `<p style="color: red;">PDF 로딩 실패: ${error.message}</p>`;
        }
    }
}

// 다른 파일에서 호출할 수 있도록 export (doc.js에서 사용)
export { loadPdfFromStorage };


// --- ⚠️ 매우 중요 ---
// 이 코드가 작동하려면, `A.firebase.js` 파일이
// storage, ref, getDownloadURL 함수/객체를
// export 하고 있어야 합니다.
//
// 예: A.firebase.js 파일 내부
// ...
// import { getStorage, ref, getDownloadURL } from "firebase/storage"; // storage 관련 import
// ...
// export const storage = getStorage(app); // storage 객체 export
// export { ref, getDownloadURL }; // ref, getDownloadURL 함수 export
// ...