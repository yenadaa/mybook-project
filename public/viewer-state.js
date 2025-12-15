// ====== 상태 변수 (State) ======
export let pdfDoc = null;
export let scale = 1.0;
export let currentPage = 1;
export let continuousMode = true;

// highlight: { id(Firestore ID!), page, type:'stroke', paths:[[{x,y}], ...], color, tag, thicknessNorm, text, comment }
export let highlights = []; // Firestore에서 받아온 데이터로 채워짐
export let undoStack = []; // 로컬 Undo/Redo 스택 (Firestore와 별개)
export let redoStack = []; // 로컬 Undo/Redo 스택

export let selectMode = 'none'; // 'pen'| 'marker' | 'eraser' | 'ocrSelect' | 'none'
export let selectedTag = '기본';
export let searchIndex = [];
export let searchHits = [];
export let searchCursor = -1;
export let bookmarks = []; // 로컬 스토리지 사용
//[18~19 추가][12-14][지우개 타켓 상태 추가]
export let eraserTarget = 'pen'; // 'pen' | 'marker' | 'both'
export function setEraserTarget(t) { eraserTarget = t; }

// OCR
//[복구수정][12-03][테서랙트에 관한 코드]
export let ocrData = {}; // 로컬 스토리지 사용
export let ocrDebugVisible = false;
export let ocrSelectionRect = null; // 현재 선택 중인 영역 요소 (DOM)
export let ocrStartPos = null;      // 선택 시작 좌표 (draw-layer 기준)
export let ocrCurrentPage = null;   // 선택이 이루어진 페이지 번호

// Marker
export const HIGHLIGHT_COLORS = {
    '기본': 'rgba(250, 250, 0, 0.35)',
    '중요': 'rgba(255, 165, 0, 0.35)',
    '암기': 'rgba(144, 238, 144, 0.35)',
    '참고': 'rgba(135, 206, 250, 0.35)',
    'OCR': 'rgba(135, 206, 250, 0.35)',
    //[삭제][12-11][검은색 펜 색상]
};
// [추가][12-11][자유 필기 전용 고정 상태 및 태그 정의 (저장용)]
export const MARKER_STROKE_TAG = '자유필기'; // 파이어스토어 저장을 위한 독립 태그
export const MARKER_STROKE_COLOR = 'rgb(0, 0, 0)'; 
export const MARKER_DEFAULT_THICKNESS_PX = 7; // 고정된 기본 두께 (7px)

//[추가][12-14] 필기 모드 독립 두께 변수 (로컬 스토리지에서 로드, 없으면 7px)
export let markerCurrentThicknessPx = Number(localStorage.getItem('pdfViewer.markerThicknessPx')) || 7;
//[형광펜 독립 두께 변수]
export let currentThicknessPx = Number(localStorage.getItem('pdfViewer.penThicknessPx')) || 20;

export let pendingChunk = null;
// { page, tag, color, thicknessNorm, paths: [normPath, ...], bboxPx:{x0,y0,x1,y1}, timer }

// ====== DOM 요소 (els) ======
// [수정][12-14][빈 객체로 초기화합니다. (ReferenceError 방지)]
export const els = {}; 
export const elsMarkerModal = {};
export const elsOcrModal = {};

export function initializeDOMElements() {
    // [수정] els 객체에 모든 DOM 요소를 할당합니다.
    Object.assign(els, {
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
        markerBtn: document.getElementById('markerBtn'),//[추가][12-09][검정펜]
        markerSettingsBtn: document.getElementById('markerSettingsBtn'),//[추가][12-14][필기 모드 모달]
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
        ocrPage: document.getElementById('ocrPage'),
        ocrAll: document.getElementById('ocrAll'),
        ocrLang: document.getElementById('ocrLang'),
        ocrToggleDebug: document.getElementById('ocrToggleDebug'),
        ocrStatus: document.getElementById('ocrStatus'), //[복구수정][12-03]
        ocrSelectBtn: document.getElementById('ocrSelectBtn'), // OCR 선택 버튼
    });   
    //[추가][12-14][필기 모드 모달 요소]
    Object.assign(elsMarkerModal, {
        overlay: document.getElementById('marker-setting-modal-overlay'),
        thickness: document.getElementById('modalMarkerThickness'), 
        thicknessLabel: document.getElementById('modalMarkerThicknessLabel'),
        eraserBtn: document.getElementById('modalMarkerEraserBtn'),
        closeBtn: document.getElementById('marker-setting-modal-close-btn')
    });
    
    // OCR 모달 요소
    Object.assign(elsOcrModal, {
        overlay: document.getElementById('ocr-result-modal'),
        content: document.getElementById('ocr-result-content'),
        textarea: document.getElementById('ocr-result-text'),
        copyBtn: document.getElementById('ocr-copy-btn'),
        closeBtn: document.getElementById('ocr-close-btn')
    });
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
////[복구수정][12-03][ocr 부분 2줄(ocrdata, ocrDebugvisible)]
export function setOcrData(data) { ocrData = data; }
export function setOcrDebugVisible(v) { ocrDebugVisible = v; }
export function setOcrSelectionRect(rect) { ocrSelectionRect = rect; }
export function setOcrStartPos(pos) { ocrStartPos = pos; }
export function setOcrCurrentPage(p) { ocrCurrentPage = p; }
export function setSelectedTag(tag) { selectedTag = tag; }
export function setCurrentThicknessPx(px) { currentThicknessPx = px; }
export function setPendingChunk(chunk) { pendingChunk = chunk; }
//[추가][12-14][필기 모드 두께 상태 변경 함수]
export function setMarkerCurrentThicknessPx(px) { markerCurrentThicknessPx = px; }

export function setMode(mode) {
    selectMode = mode;
    els.penBtn?.classList.toggle('active', mode === 'pen');
    els.markerBtn?.classList.toggle('active', mode === 'marker');//[추가][12-09][검정펜]
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
    const data = { bookmarks, ocrData}; //[복구수정][12-03][ocr부분]
    localStorage.setItem('pdfViewer.extended', JSON.stringify(data));
}
export function loadLocal() {
    try {
        const raw = localStorage.getItem('pdfViewer.extended');
        if (!raw) return;
        const data = JSON.parse(raw);
        bookmarks = data.bookmarks || [];
        ocrData = data.ocrData || {};//[복구수정][12-03][ocr부분]
    } catch (e) { console.error("로컬 데이터 로딩 오류:", e); }
}