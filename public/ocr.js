import { functions, httpsCallable } from "./A.firebase.js";

// 1. OCR 펜 활성화 및 UI 로직을 초기화하는 함수
export function initOcr() {
    const ocrPenBtn = document.getElementById("ocr-pen-btn");
    if (!ocrPenBtn) return;

    let isOcrPenActive = false;
    let selectionBox = null;
    let startCoords = null;

    // OCR 펜 버튼 클릭 이벤트
    ocrPenBtn.addEventListener("click", () => {
        isOcrPenActive = !isOcrPenActive;
        ocrPenBtn.classList.toggle("active", isOcrPenActive);
        
        // 만약 다른 툴들이 활성화되어 있다면 비활성화 시킵니다.
        if(isOcrPenActive) {
            document.getElementById('pen1')?.classList.remove('active');
            document.getElementById('eraser-btn')?.classList.remove('active');
            document.getElementById('tag-btn')?.classList.remove('active');
            // 전역 상태 변수가 있다면 여기서 false로 변경해야 합니다.
            // 예: isPenActive = false;
        }
    });

    // --- 드래그 로직 ---
    function onMouseDown(e) {
        // OCR 펜이 활성화되지 않았거나, PDF 페이지 위가 아니면 무시
        if (!isOcrPenActive || !e.target.closest(".page")) return;
        
        const pageDiv = e.target.closest(".page");

        // selectionBox가 없으면 생성하여 body에 추가
        if (!selectionBox) {
            selectionBox = document.createElement("div");
            Object.assign(selectionBox.style, {
                position: "absolute",
                border: "2px dashed #007bff",
                backgroundColor: "rgba(0, 123, 255, 0.1)",
                zIndex: 1000,
                pointerEvents: "none" // 마우스 이벤트가 통과하도록 설정
            });
            document.body.appendChild(selectionBox);
        }

        startCoords = { x: e.clientX, y: e.clientY, pageDiv: pageDiv };
        
        Object.assign(selectionBox.style, {
            left: `${e.clientX}px`,
            top: `${e.clientY}px`,
            width: "0px",
            height: "0px",
            display: "block"
        });

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp, { once: true });
    }

    function onMouseMove(e) {
        if (!startCoords) return;
        const x = Math.min(e.clientX, startCoords.x);
        const y = Math.min(e.clientY, startCoords.y);
        const width = Math.abs(e.clientX - startCoords.x);
        const height = Math.abs(e.clientY - startCoords.y);
        
        Object.assign(selectionBox.style, {
            left: `${x}px`,
            top: `${y}px`,
            width: `${width}px`,
            height: `${height}px`
        });
    }

    async function onMouseUp(e) {
        if (!startCoords) return;
        document.removeEventListener("mousemove", onMouseMove);
        selectionBox.style.display = "none";

        const { x, y, pageDiv } = startCoords;
        const endX = e.clientX;
        const endY = e.clientY;

        const width = Math.abs(endX - x);
        const height = Math.abs(endY - y);

        if (width < 10 || height < 10) return; // 너무 작은 드래그는 무시

        const pageRect = pageDiv.getBoundingClientRect();
        const pageCanvas = pageDiv.querySelector("canvas");
        
        // 디스플레이 배율(HiDPI)을 고려한 스케일 계산
        const scale = pageCanvas.width / pageRect.width;

        // 캔버스 기준 자르기 좌표 계산
        const cropRect = {
            left: (Math.min(x, endX) - pageRect.left) * scale,
            top: (Math.min(y, endY) - pageRect.top) * scale,
            width: width * scale,
            height: height * scale,
        };
        
        // 캔버스에서 해당 영역을 잘라내어 이미지 데이터(Base64)로 변환
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = cropRect.width;
        tempCanvas.height = cropRect.height;
        const tempCtx = tempCanvas.getContext("2d");
        tempCtx.drawImage(
            pageCanvas,
            cropRect.left, cropRect.top, cropRect.width, cropRect.height,
            0, 0, cropRect.width, cropRect.height
        );
        // toDataURL의 결과에서 'data:image/png;base64,' 부분을 제거하고 순수 데이터만 추출
        const imageData = tempCanvas.toDataURL("image/png").split(',')[1];

        // 백엔드 함수 호출
        await runOcrOnSelectionBackend(imageData);
        
        startCoords = null;
    }

    // 문서 전체에 마우스 이벤트 리스너 추가
    document.addEventListener("mousedown", onMouseDown);
}


// 2. 백엔드 OCR 함수를 호출하는 부분
async function runOcrOnSelectionBackend(imageData) {
    try {
        console.log("OCR 요청 시작...");
        alert("선택 영역 OCR 분석을 시작합니다...");
        const runOcr = httpsCallable(functions, 'runOcrOnSelection');
        const result = await runOcr({ imageData });
        const detectedText = result.data.text;
        
        if (detectedText) {
            console.log("OCR 결과:", detectedText);
            // 결과를 클립보드에 복사하고 사용자에게 알림
            navigator.clipboard.writeText(detectedText).then(() => {
                alert(`OCR 결과가 클립보드에 복사되었습니다:\n\n${detectedText}`);
            });
        } else {
            alert("OCR 결과, 텍스트를 찾지 못했습니다.");
        }

    } catch (error) {
        console.error("OCR 처리 중 오류 발생:", error);
        alert("OCR 처리 중 오류가 발생했습니다.");
    }
}