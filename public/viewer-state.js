// ====== 상태 변수 (State) ======
export let pdfDoc = null;
export let scale = 1.0;
export let currentPage = 1;
export let continuousMode = true;

// highlight: { id(Firestore ID!), page, type:'stroke', paths:[[{x,y}], ...], color, tag, thicknessNorm, text, comment }
export let highlights = []; // Firestore에서 받아온 데이터로 채워짐
export let undoStack = []; // 로컬 Undo/Redo 스택 (Firestore와 별개)
export let redoStack = []; // 로컬 Undo/Redo 스택

export let selectMode = 'none'; // 'pen' | 'eraser' | 'ocrSelect' | 'none'
export let selectedTag = '기본';
export let searchIndex = [];
export let searchHits = [];
export let searchCursor = -1;
export let bookmarks = []; // 로컬 스토리지 사용

// OCR
//[삭제][12-02][테서랙트에 관한 코드 삭제]
export let ocrSelectionRect = null; // 현재 선택 중인 영역 요소 (DOM)
export let ocrStartPos = null;      // 선택 시작 좌표 (draw-layer 기준)
export let ocrCurrentPage = null;   // 선택이 이루어진 페이지 번호

// Marker
export const HIGHLIGHT_COLORS = {
    '기본': 'rgba(250, 250, 0, 0.35)',
    '중요': 'rgba(255, 165, 0, 0.35)',
    '암기': 'rgba(144, 238, 144, 0.35)',
    '참고': 'rgba(135, 206, 250, 0.35)',
    'OCR': 'rgba(135, 206, 250, 0.35)'
};
export let currentThicknessPx = Number(localStorage.getItem('pdfViewer.penThicknessPx')) || 20;

export let pendingChunk = null;
// { page, tag, color, thicknessNorm, paths: [normPath, ...], bboxPx:{x0,y0,x1,y1}, timer }

// ====== DOM 요소 (els) ======
export const els = {
    file: document.getElementById('file'),
    pages: document.getElementById('pages'),
    empty: document.getElementById('empty'),
    pageIndicator: document.getElementById('pageIndicator'),
    zoomLabel: document.getElementById('zoomLabel'),
    prevPage: document.getElementById('prevPage'),
    nextPage: document.getElementById('nextPage'),
    jumpInput: document.getElementById('jumpInput'),
    zoomIn: document.getElementById('zoomIn'),
    zoomOut: document.getElementById('zoomOut'),
    zoomReset: document.getElementById('zoomReset'),
    toggleDark: document.getElementById('toggleDark'),
    modeContinuous: document.getElementById('modeContinuous'),
    modeSingle: document.getElementById('modeSingle'),
    undoBtn: document.getElementById('undoBtn'),
    redoBtn: document.getElementById('redoBtn'),
    penBtn: document.getElementById('penBtn'),
    eraserBtn: document.getElementById('eraserBtn'),
    tagBtns: Array.from(document.querySelectorAll('.tag-btn')),
    thickness: document.getElementById('thickness'),
    thicknessLabel: document.getElementById('thicknessLabel'),
    searchInput: document.getElementById('searchInput'),
    searchPrev: document.getElementById('searchPrev'),
    searchNext: document.getElementById('searchNext'),
    thumbs: document.getElementById('thumbs'),
    outline: document.getElementById('outline'),
    bookmarks: document.getElementById('bookmarks'),
    tabThumbs: document.getElementById('tabThumbs'),
    tabOutline: document.getElementById('tabOutline'),
    tabBookmarks: document.getElementById('tabBookmarks'),
    notes: document.getElementById('notes'),
    rightFilterTabs: Array.from(document.querySelectorAll('.right-tabs button')),
    addBookmark: document.getElementById('addBookmark'),
    exportNotes: document.getElementById('exportNotes'),
    clearData: document.getElementById('clearData'),
    ocrSelectBtn: document.getElementById('ocrSelectBtn'), // OCR 선택 버튼
};

// OCR 모달 요소
export const elsOcrModal = {
    overlay: document.getElementById('ocr-result-modal'),
    content: document.getElementById('ocr-result-content'),
    textarea: document.getElementById('ocr-result-text'),
    copyBtn: document.getElementById('ocr-copy-btn'),
    closeBtn: document.getElementById('ocr-close-btn')
};

// ====== 상태 변경 함수 (State Mutators) ======
// (다른 모듈에서 이 함수들을 import하여 상태를 변경합니다)

export function setPdfDoc(doc) { pdfDoc = doc; }
export function setScale(s) { scale = s; }
export function setCurrentPage(p) { currentPage = p; }
export function setContinuousMode(mode) { continuousMode = mode; }
export function setHighlights(h) { highlights = h; }
export function setUndoStack(stack) { undoStack = stack; }
export function setRedoStack(stack) { redoStack = stack; }
export function setSearchIndex(index) { searchIndex = index; }
export function setSearchHits(hits) { searchHits = hits; }
export function setSearchCursor(c) { searchCursor = c; }
export function setBookmarks(b) { bookmarks = b; }
////[삭제][12-02][ocr 부분 2줄(ocrdata, ocrDebugvisible) 삭제]
export function setOcrSelectionRect(rect) { ocrSelectionRect = rect; }
export function setOcrStartPos(pos) { ocrStartPos = pos; }
export function setOcrCurrentPage(p) { ocrCurrentPage = p; }
export function setSelectedTag(tag) { selectedTag = tag; }
export function setCurrentThicknessPx(px) { currentThicknessPx = px; }
export function setPendingChunk(chunk) { pendingChunk = chunk; }

export function setMode(mode) {
    selectMode = mode;
    els.penBtn?.classList.toggle('active', mode === 'pen');
    els.eraserBtn?.classList.toggle('active', mode === 'eraser');
    els.ocrSelectBtn?.classList.toggle('active', mode === 'ocrSelect');
    document.querySelectorAll('.page-wrap').forEach(wrap => {
        wrap.classList.toggle('ocr-select-mode', mode === 'ocrSelect');
    });
    console.log("Mode set to:", selectMode);
}

export function addCommand(cmd) {
    undoStack.push(cmd);
    redoStack = [];
    updateButtons();
}

export function updateButtons() {
    if (els.undoBtn) els.undoBtn.disabled = undoStack.length === 0;
    if (els.redoBtn) els.redoBtn.disabled = redoStack.length === 0;
}

// ====== Local Storage (북마크, OCR 데이터 전용) ======
export function saveLocal() {
    const data = { bookmarks}; //[삭제][12-02][ocr부분 삭제]
    localStorage.setItem('pdfViewer.extended', JSON.stringify(data));
}
export function loadLocal() {
    try {
        const raw = localStorage.getItem('pdfViewer.extended');
        if (!raw) return;
        const data = JSON.parse(raw);
        bookmarks = data.bookmarks || [];
        //[삭제][12-02][ocr부분 삭제]
    } catch (e) { console.error("로컬 데이터 로딩 오류:", e); }
}