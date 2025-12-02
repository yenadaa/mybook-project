import { httpsCallable, functions } from './A.firebase.js'; // A.firebase.js에서 export 필요
import * as state from './viewer-state.js';
import { execAddHighlight } from './viewer-highlight-manager.js';

//[삭제][12-02][OCR (Tesseract) 관련 함수 4개 삭제]

// ====== OCR (Cloud Vision) ======

export async function extractAndRunOcr(pageNumber, rect) {
    const { getPagesCache } = await import('./viewer-renderer.js');
    const pageCache = getPagesCache().get(pageNumber);

    if (!pageCache || !pageCache.canvas) {
        console.error("OCR 오류: 해당 페이지의 원본 캔버스(pageCache.canvas)를 찾을 수 없습니다.");
        removeOcrSelectionRect();
        return;
    }

    const sourceCanvas = pageCache.canvas;
    const scaleX = sourceCanvas.width / parseFloat(sourceCanvas.style.width);
    const scaleY = sourceCanvas.height / parseFloat(sourceCanvas.style.height);
    const sx = rect.x * scaleX, sy = rect.y * scaleY, sWidth = rect.width * scaleX, sHeight = rect.height * scaleY;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = Math.max(1, sWidth);
    tempCanvas.height = Math.max(1, sHeight);
    const tempCtx = tempCanvas.getContext('2d');
    try {
        tempCtx.drawImage(sourceCanvas, sx, sy, sWidth, sHeight, 0, 0, tempCanvas.width, tempCanvas.height);
    } catch (e) {
        console.error("drawImage 오류:", e, { sx, sy, sWidth, sHeight, cw: tempCanvas.width, ch: tempCanvas.height });
        alert("이미지 영역 추출 중 오류가 발생했습니다.");
        removeOcrSelectionRect();
        return;
    }

    const base64ImageData = tempCanvas.toDataURL('image/png').split(',')[1];
    document.body.style.cursor = 'wait';

    try {
        const runOcrOnSelection = httpsCallable(functions, 'runOcrOnSelection');
        const result = await runOcrOnSelection({ imageData: base64ImageData });
        const detectedText = result.data.text || "";
        console.log("Cloud Vision API 결과:", detectedText);

        if (detectedText.trim()) {
            const drawCanvas = pageCache.drawCanvas;
            const w = parseFloat(drawCanvas.style.width);
            const h = parseFloat(drawCanvas.style.height);
            
            const normRect = {
                x0: rect.x / w,
                y0: rect.y / h,
                x1: (rect.x + rect.width) / w,
                y1: (rect.y + rect.height) / h
            };

            const highlightData = {
                page: pageNumber,
                type: 'ocrBlock',
                bbox: normRect,
                text: detectedText.trim(),
                tag: 'OCR',
                color: state.HIGHLIGHT_COLORS['OCR'],
                comment: ''
            };
            execAddHighlight(highlightData); // (highlight-manager.js)
        } else {
            alert("추출된 텍스트가 없습니다.");
        }
    } catch (error) {
        console.error("Cloud Vision OCR 함수 호출 오류:", error);
        alert(`OCR 오류: ${error.message}`);
    } finally {
        document.body.style.cursor = 'default';
        removeOcrSelectionRect();
        state.setMode('none');
    }
}

export function removeOcrSelectionRect() {
    if (state.ocrSelectionRect) { state.ocrSelectionRect.remove(); state.setOcrSelectionRect(null); }
}

// ====== OCR 모달 (현재 사용 X, Cloud Vision 결과가 하이라이트로 저장됨) ======
export function showOcrResultModal(isLoading = false, text = "", isError = false) {
    if (!state.elsOcrModal.overlay || !state.elsOcrModal.content || !state.elsOcrModal.textarea) return;
    state.elsOcrModal.textarea.value = text;
    if (isLoading) {
        state.elsOcrModal.content.innerHTML = '<div class="loading-spinner"></div><p style="text-align: center; color: var(--muted);">텍스트 추출 중...</p>';
        state.elsOcrModal.textarea.style.display = 'none'; state.elsOcrModal.copyBtn.style.display = 'none';
    } else if (isError) {
        state.elsOcrModal.content.innerHTML = `<p style="text-align: center; color: red;">${text || '오류 발생.'}</p>`;
        state.elsOcrModal.textarea.style.display = 'none'; state.elsOcrModal.copyBtn.style.display = 'none';
    } else {
        state.elsOcrModal.content.innerHTML = '';
        state.elsOcrModal.textarea.style.display = 'block'; state.elsOcrModal.copyBtn.style.display = 'inline-block';
    }
    state.elsOcrModal.overlay.classList.remove('hidden');
}

export function hideOcrResultModal() { 
    state.elsOcrModal.overlay?.classList.add('hidden'); 
}