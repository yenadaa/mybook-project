// pdf.js 라이브러리를 import하여 실행시키고, 전역에 생성되는 'pdfjsLib' 객체를 사용합니다.
import "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js";
import { getDownloadURL } from "./A.firebase.js"; // A.firebase.js에서 함수를 가져옵니다.

// pdf.js 라이브러리가 로드될 때까지 기다리는 함수
async function waitForPdfJs() {
    while (typeof window.pdfjsLib === 'undefined') {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return window.pdfjsLib;
}

const pdfContainer = document.getElementById("pdf-container");
let pdfjsLib; // 라이브러리를 담을 변수

// 라이브러리를 기다린 후, 핵심 기능들을 초기화합니다.
waitForPdfJs().then(lib => {
    pdfjsLib = lib;
    // pdf.js 워커 경로를 설정합니다. 이 부분이 중요합니다.
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";
});


export function renderPDF(storageRef) {
    if (!pdfjsLib) {
        console.error("PDF.js 라이브러리가 아직 로드되지 않았습니다.");
        // 라이브러리가 로드될 때까지 잠시 기다렸다가 다시 시도할 수 있습니다.
        setTimeout(() => renderPDF(storageRef), 100);
        return;
    }

    getDownloadURL(storageRef)
        .then(url => {
            pdfContainer.innerHTML = ""; // 이전 PDF 내용 지우기
            const loadingTask = pdfjsLib.getDocument(url);
            return loadingTask.promise;
        })
        .then(pdf => {
            const totalPages = pdf.numPages;
            const promises = [];
            for (let i = 1; i <= totalPages; i++) {
                promises.push(pdf.getPage(i).then(page => renderPage(page, i)));
            }
            return Promise.all(promises);
        })
        .catch(error => {
            console.error("PDF 렌더링 오류:", error);
            pdfContainer.innerHTML = `<p style="color: red; text-align: center;">PDF를 불러오는 데 실패했습니다.</p>`;
        });
}

function renderPage(page, pageNum) {
    const scale = 1.5;
    const viewport = page.getViewport({ scale });

    const pageDiv = document.createElement("div");
    pageDiv.className = "page";
    pageDiv.dataset.pageNumber = pageNum;
    pageDiv.style.width = `${viewport.width}px`;
    pageDiv.style.height = `${viewport.height}px`;

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    pageDiv.appendChild(canvas);

    const textLayerDiv = document.createElement("div");
    textLayerDiv.className = "textLayer";
    textLayerDiv.style.width = `${viewport.width}px`;
    textLayerDiv.style.height = `${viewport.height}px`;
    pageDiv.appendChild(textLayerDiv);

    // 페이지 div를 pdfContainer에 추가하기 전에 자식 요소들을 먼저 추가합니다.
    const wrap = document.createElement("div");
    wrap.className = "wrap";
    wrap.appendChild(pageDiv);
    pdfContainer.appendChild(wrap);

    return page.render({ canvasContext: context, viewport: viewport }).promise.then(() => {
        return page.getTextContent();
    }).then(textContent => {
        // renderTextLayer를 호출하기 전에 pdfjsLib.renderTextLayer가 있는지 확인합니다.
        if (pdfjsLib.renderTextLayer) {
            return pdfjsLib.renderTextLayer({
                textContent: textContent, // ✨ [최종 수정] 파라미터 이름을 올바르게 변경
                container: textLayerDiv,
                viewport,
                textDivs: [],
            }).promise;
        }
    });
}

