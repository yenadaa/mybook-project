import { httpsCallable, functions } from './A.firebase.js';

let pdfDoc = null;
let scale = 1.0;
let currentPage = 1;
let continuousMode = true;

// highlight: { id(Firestore ID!), page, type:'stroke', paths:[[{x,y}], ...], color, tag, thicknessNorm, text, comment }
let highlights = []; // Firestore에서 받아온 데이터로 채워짐
let undoStack = []; // 로컬 Undo/Redo 스택 (Firestore와 별개)
let redoStack = []; // 로컬 Undo/Redo 스택

let selectMode = 'none'; // 'pen' | 'eraser' | 'none'
let selectedTag = '기본';
let searchIndex = [];
let searchHits = [];
let searchCursor = -1;
let bookmarks = []; // 로컬 스토리지 사용

// OCR
let ocrData = {}; // 로컬 스토리지 사용
let ocrDebugVisible = false;
let ocrSelectionRect = null; // 현재 선택 중인 영역 요소 (DOM)
let ocrStartPos = null;      // 선택 시작 좌표 (draw-layer 기준)
let ocrCurrentPage = null;   // 선택이 이루어진 페이지 번호

// Marker
const HIGHLIGHT_COLORS = {
    '기본': 'rgba(250, 250, 0, 0.35)',
    '중요': 'rgba(255, 165, 0, 0.35)',
    '암기': 'rgba(144, 238, 144, 0.35)',
    '참고': 'rgba(135, 206, 250, 0.35)',
    'OCR': 'rgba(135, 206, 250, 0.35)'
};
let currentThicknessPx = Number(localStorage.getItem('pdfViewer.penThicknessPx')) || 20;

let pendingChunk = null;
// { page, tag, color, thicknessNorm, paths: [normPath, ...], bboxPx:{x0,y0,x1,y1}, timer }

const els = {
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
    clearData: document.getElementById('clearData'), // clearData는 이제 로컬 북마크/OCR만 지워야 함
    ocrPage: document.getElementById('ocrPage'),
    ocrAll: document.getElementById('ocrAll'),
    ocrLang: document.getElementById('ocrLang'),
    ocrToggleDebug: document.getElementById('ocrToggleDebug'),
    ocrStatus: document.getElementById('ocrStatus'),
};

// Init UI for thickness
if (els.thickness) els.thickness.value = String(currentThicknessPx);
if (els.thicknessLabel) els.thicknessLabel.textContent = `${currentThicknessPx} px`;

// ====== Micro-interactions: ripple ======
function attachRipplesTo(selector){
    document.querySelectorAll(selector).forEach(btn => {
        if (btn.__hasRipple) return; btn.__hasRipple = true;
        btn.style.position = btn.style.position || 'relative';
        btn.style.overflow = btn.style.overflow || 'hidden';
        btn.addEventListener('click', function(e){
            const r = this.getBoundingClientRect();
            const d = Math.max(r.width, r.height);
            const s = document.createElement('span');
            s.className = 'ripple';
            Object.assign(s.style, {
                width: d + 'px', height: d + 'px',
                left: (e.clientX - r.left - d/2) + 'px',
                top: (e.clientY - r.top - d/2) + 'px',
                position: 'absolute', borderRadius: '999px',
                transform: 'scale(0)', opacity: '.16',
                background: 'currentColor',
                animation: 'ripple-soft .7s cubic-bezier(.25,.1,.25,1) forwards'
            });
            this.appendChild(s);
            s.addEventListener('animationend', ()=> s.remove());
        }, { passive: true });
    });
}

// ====== Local Storage (북마크, OCR 데이터 전용) ======
function saveLocal() {
    // highlights, undo/redo 제외. 북마크와 OCR 데이터만 저장
    const data = { bookmarks, ocrData };
    localStorage.setItem('pdfViewer.extended', JSON.stringify(data));
}
function loadLocal() {
    try {
        const raw = localStorage.getItem('pdfViewer.extended');
        if (!raw) return;
        const data = JSON.parse(raw);
        // highlights, undo/redo 제외. 북마크와 OCR 데이터만 로드
        bookmarks = data.bookmarks || [];
        ocrData = data.ocrData || {};
    } catch (e) { console.error("로컬 데이터 로딩 오류:", e); }
}
loadLocal(); // 앱 시작 시 로컬 데이터 로드

function updateToolbar() {
    if (els.pageIndicator) els.pageIndicator.textContent = pdfDoc ? `p. ${currentPage} / ${pdfDoc.numPages}` : 'p. - / -';
    if (els.zoomLabel) els.zoomLabel.textContent = Math.round(scale * 100) + '%';
}

function onScrollUpdatePage() {
    if (!pdfDoc || !continuousMode || !els.pages) return;
    const viewerRect = els.pages.getBoundingClientRect();
    let mostVisiblePage = currentPage; 
    const pageWraps = document.querySelectorAll('.page-wrap');
    const threshold = viewerRect.top + (viewerRect.height * 0.33);
    for (const wrap of pageWraps) {
        const wrapRect = wrap.getBoundingClientRect();
        if (wrapRect.top <= threshold && wrapRect.bottom >= threshold) {
             const pageNum = parseInt(wrap.dataset.page, 10);
             if (!isNaN(pageNum)) {
                mostVisiblePage = pageNum;
                break; 
             }
        }
    }
    if (currentPage !== mostVisiblePage) {
        currentPage = mostVisiblePage;
        updateToolbar();
    }
}
function clearViewer() {
    if (els.pages) els.pages.innerHTML = '';
    if (els.thumbs) els.thumbs.innerHTML = '';
    if (els.outline) els.outline.innerHTML = '';
    if (els.bookmarks) els.bookmarks.innerHTML = '';
}
function scrollToPage(p) {
    const el = document.querySelector(`.page-wrap[data-page="${p}"]`);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); currentPage = p; updateToolbar(); }
}
function setMode(mode) {
    selectMode = mode;
    els.penBtn?.classList.toggle('active', mode === 'pen');
    els.eraserBtn?.classList.toggle('active', mode === 'eraser');
    els.ocrSelectBtn?.classList.toggle('active', mode === 'ocrSelect');
    document.querySelectorAll('.page-wrap').forEach(wrap => {
        wrap.classList.toggle('ocr-select-mode', mode === 'ocrSelect');
    });
    console.log("Mode set to:", selectMode); // 모드 변경 확인 로그
}
function addCommand(cmd) {
    undoStack.push(cmd);
    redoStack = [];
    // 로컬 저장은 Firestore 연동 후 필요 없음 (Undo/Redo는 로컬 상태 관리)
    // Firestore 저장은 execAddHighlight 등 개별 함수에서 처리
    updateButtons(); // Add command updates button state
}
function updateButtons() { // Function to update undo/redo button disabled state
    if (els.undoBtn) els.undoBtn.disabled = undoStack.length === 0;
    if (els.redoBtn) els.redoBtn.disabled = redoStack.length === 0;
}

// ====== Rendering PDF ======
const pagesCache = new Map();

// window 전역에 등록 (firebaseLoader.js에서 호출)
window.renderDocument = async function(arrayBuffer) {
    clearViewer();
    // 로컬 highlights 배열 초기화 (Firestore에서 다시 받아옴)
    highlights = [];
    undoStack = [];
    redoStack = [];
    updateButtons(); // Clear stacks, update buttons

    try {
        pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    } catch (error) {
         console.error("Error loading PDF document:", error);
         if (els.empty) els.empty.textContent = `PDF 로딩 오류: ${error.message}`;
         if (els.pages) els.pages.style.display = 'none';
         if (els.empty) els.empty.style.display = 'grid';
         return; // Stop further processing if PDF loading fails
    }

    if (els.empty) els.empty.style.display = 'none';
    if (els.pages) els.pages.style.display = 'grid'; // display: '' 대신 grid로 변경 (CSS 일치)
    currentPage = 1; // Reset to first page
    scale = 1.0; // Reset zoom
    continuousMode = true; // Reset view mode
    updateToolbar();

    searchIndex = new Array(pdfDoc.numPages);
    if (els.thumbs) els.thumbs.innerHTML = '';
    // Create page elements sequentially first
    for (let p = 1; p <= pdfDoc.numPages; p++) {
        const wrap = document.createElement('div');
        wrap.className = 'page-wrap';
        wrap.dataset.page = String(p);

        const canvas = document.createElement('canvas');
        canvas.className = 'page';
        const textLayer = document.createElement('div');
        textLayer.className = 'textLayer';
        const drawCanvas = document.createElement('canvas');
        drawCanvas.className = 'draw-layer';

        wrap.appendChild(canvas);
        wrap.appendChild(textLayer);
        wrap.appendChild(drawCanvas);
        if (els.pages) els.pages.appendChild(wrap);

        if (els.thumbs) {
            const thumbWrap = document.createElement('div');
            thumbWrap.className = 'thumb';
            thumbWrap.dataset.page = String(p); // 👈 나중에 이 번호로 찾아갑니다.
            thumbWrap.addEventListener('click', () => scrollToPage(p));
            // (옵션) 로딩 중임을 표시
            // thumbWrap.innerHTML = `<span class.="thumb-loading">${p}</span>`; 
            els.thumbs.appendChild(thumbWrap);
    }
    }
    // Now render content (can be parallelized more if needed)
    const renderPromises = [];
    for (let p = 1; p <= pdfDoc.numPages; p++) {
        const wrap = document.querySelector(`.page-wrap[data-page="${p}"]`);
        const drawCanvas = wrap?.querySelector('canvas.draw-layer');
        if (drawCanvas) {
            initDrawLayer(p, drawCanvas); // Initialize drawing layer first
        }
        renderPromises.push(renderPage(p)); // Render page content (async)
        renderPromises.push(renderThumb(p)); // Render thumbnail (async)
    }
    renderOutline(); // 목차 렌더링
    renderBookmarks(); // 로컬 북마크 렌더링
    renderNotes(); // 노트 패널 (초기 빈 상태) 렌더링

    // 스크롤 이벤트 리스너 추가
    const viewerElement = document.querySelector('.viewer');
    els.pages?.addEventListener('scroll', onScrollUpdatePage, { passive: true });
    viewerElement?.addEventListener('scroll', onScrollUpdatePage, { passive: true });

    console.log("PDF 렌더링 완료. Firestore 하이라이트 대기 중...");
    // Firestore 하이라이트는 doc.js의 onSnapshot이 로드되면 setHighlightsData를 통해 그려짐
}
async function renderPage(p) {
    if (!pdfDoc) return;
     let page;
    try {
        page = await pdfDoc.getPage(p);
    } catch(error) {
        console.error(`Error getting page ${p}:`, error);
        return;
    }
    const desiredScale = scale * (continuousMode ? 1.0 : 1.2); // Adjust scale based on mode?
    const viewport = page.getViewport({ scale: desiredScale });
    const wrap = document.querySelector(`.page-wrap[data-page="${p}"]`);
    if (!wrap) { console.warn(`Wrap element for page ${p} not found.`); return; }
    wrap.style.setProperty('--scale-factor', String(desiredScale));
    const canvas = wrap.querySelector('canvas.page');
    const textLayerDiv = wrap.querySelector('.textLayer');
    const drawCanvas = wrap.querySelector('canvas.draw-layer');
    if (!canvas || !textLayerDiv || !drawCanvas) { console.warn(`Required elements missing for page ${p}.`); return; }

    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');

    canvas.width = Math.floor(viewport.width * dpr); // Use floor for integer width
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Render PDF page content
    try {
        await page.render({ canvasContext: ctx, viewport }).promise;
    } catch (renderError) {
         console.error(`Error rendering page ${p} canvas:`, renderError);
    }


    // Render Text Layer
    textLayerDiv.style.width = `${viewport.width}px`;
    textLayerDiv.style.height = `${viewport.height}px`;
    textLayerDiv.innerHTML = ''; // Clear previous content
    try {
        const textContent = await page.getTextContent();
        // Use the new API property name
        await pdfjsLib.renderTextLayer({
            textContentSource: textContent,
            container: textLayerDiv,
            viewport,
            textDivs: [], // Required parameter
        }).promise;
    } catch (textLayerError) {
         console.error(`Error rendering page ${p} text layer:`, textLayerError);
    }


    // Resize Draw Layer
    drawCanvas.width = viewport.width;
    drawCanvas.height = viewport.height;
    drawCanvas.style.width = `${viewport.width}px`;
    drawCanvas.style.height = `${viewport.height}px`;
    redrawStrokesForPage(p); // Redraw existing strokes for this page

    // Cache elements
    pagesCache.set(p, { canvas, textLayer: textLayerDiv, drawCanvas });

    // Build search index (only if not already built)
    if (!searchIndex[p - 1]) {
        try {
            const textContentForIndex = await page.getTextContent(); // Get fresh text content for index
             const fullText = textContentForIndex.items.map(item => item.str).join(''); // Join without spaces for indexing?
            searchIndex[p - 1] = { page: p, textLower: fullText.toLowerCase() };
        } catch(getTextError) {
             console.error(`Error getting text content for page ${p} index:`, getTextError);
             searchIndex[p-1] = { page: p, textLower: ''}; // Add empty index on error
        }

    }
     // Clean up page object?
     // page.cleanup(); // Maybe call this if memory becomes an issue
}

async function renderThumb(p) {
    // 1. window.renderDocument에서 미리 만들어 둔 빈칸(.thumb)을 찾습니다.
    const wrap = document.querySelector(`#thumbs .thumb[data-page="${p}"]`);
    
    // 2. [수정] 빈칸(wrap)이 없거나 pdfDoc이 없으면 함수를 종료합니다.
    if (!wrap || !pdfDoc) return;

    try {
        const page = await pdfDoc.getPage(p);
        const viewport = page.getViewport({ scale: 0.2 });
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        await page.render({ canvasContext: ctx, viewport }).promise;

        // 3. [수정] 빈칸(wrap)의 내용을 비우고, 완성된 캔버스 하나만 추가합니다.
        wrap.innerHTML = ''; 
        wrap.appendChild(canvas);
        // page.cleanup();
    } catch (error) {
        console.error(`Error rendering thumbnail for page ${p}:`, error);
    }
}

async function renderOutline() {
    if (!els.outline || !pdfDoc) return;
    try {
        const outline = await pdfDoc.getOutline();
        els.outline.innerHTML = ''; // Clear previous outline
        if (!outline) return; // No outline, do nothing

        const buildOutline = (items, depth = 0) => {
            items.forEach(item => {
                const li = document.createElement('li');
                li.style.paddingLeft = `${depth * 14}px`;
                li.textContent = item.title || '(제목 없음)';
                li.addEventListener('click', async () => {
                     if (item.dest && typeof item.dest === 'string') { // Handle string destinations
                         try {
                            const dest = await pdfDoc.getDestination(item.dest);
                            if (dest && dest[0]) {
                                const pageIndex = await pdfDoc.getPageIndex(dest[0]);
                                scrollToPage(pageIndex + 1);
                            } else {
                                console.warn("Invalid destination object:", dest);
                            }
                        } catch (destError) {
                            console.error("Error getting destination:", destError);
                        }
                    } else if (item.url) { // Handle URL actions
                        window.open(item.url, '_blank', 'noopener,noreferrer');
                    }
                     // Handle other destination types (e.g., arrays) if necessary
                });
                els.outline.appendChild(li);
                if (item.items && item.items.length > 0) {
                    buildOutline(item.items, depth + 1); // Recurse for nested items
                }
            });
        };
        buildOutline(outline); // Start building from the root

    } catch (error) {
        console.error("Error rendering outline:", error);
    }
}

function renderBookmarks() {
    if (!els.bookmarks) return;
    els.bookmarks.innerHTML = '';
    bookmarks.forEach((b, idx) => {
        const li = document.createElement('li');
        li.textContent = `p.${b.page} — ${b.label || '북마크'}`;
        li.title = new Date(b.time).toLocaleString();
        li.addEventListener('click', () => scrollToPage(b.page));
        const del = document.createElement('button');
        del.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        del.style.float = 'right'; // Simple styling
        del.style.border = 'none';
        del.style.background = 'none';
        del.style.cursor = 'pointer';
        del.addEventListener('click', (e) => { e.stopPropagation(); bookmarks.splice(idx, 1); renderBookmarks(); saveLocal(); });
        li.appendChild(del);
        els.bookmarks.appendChild(li);
    });
}

// ====== Utilities ======
function unionBox(a, b) { return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }; }
function thicknessClose(tnA, tnB, h) { const pxA = (tnA || 0) * h, pxB = (tnB || 0) * h; return Math.abs(pxA - pxB) <= 2;}
function finalizePendingChunk() {
    if (!pendingChunk) return;
    const { page, tag, color, thicknessNorm, paths, bboxPx } = pendingChunk;
    const capturedText = collectTextUnderBox(page, bboxPx);

    // 임시 ID 대신 Firestore ID 사용 준비 (add에서는 ID 없음)
    const highlightData = {
        // id는 Firestore에서 생성되므로 여기서 만들지 않음
        page, type:'stroke',
        paths,
        color, tag, thicknessNorm,
        text: capturedText, comment:''
    };
    execAddHighlight(highlightData); // 로컬에 먼저 추가하고 Firestore 저장 요청
    // addCommand({ action:'add', payload:{ id: `temp_${Date.now()}` } }); // Add command with temp ID for local undo
    clearTimeout(pendingChunk.timer);
    pendingChunk = null;
}
function flushPendingIfAny(){ finalizePendingChunk(); }

// ====== Marker Drawing ======
const drawState = new Map();
function initDrawLayer(p, drawCanvas) {
    const st = { drawing:false, path:[], startErasher:null, startOcr: null, pointerId:null };
    drawState.set(p, st);
    const getPos = (e) => { const rect = drawCanvas.getBoundingClientRect(); return { x: e.clientX - rect.left, y: e.clientY - rect.top }; };

    drawCanvas.addEventListener('pointerdown', (e) => {
        console.log("Pointer Down Event Triggered!")
        if (!pdfDoc || st.pointerId !== null) return;
        // Only start drawing if the primary button is pressed (usually left mouse)
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        console.log("Current Mode:", selectMode);

        if (selectMode === 'pen') {
            console.log("Pen mode active, starting draw...");
            st.pointerId = e.pointerId;
            try { drawCanvas.setPointerCapture(e.pointerId); } catch(err) { console.warn("Could not set pointer capture:", err); } // Capture might fail
            const pos = getPos(e);
            st.drawing = true;
            st.path = [pos]; // Start new path
            const ctx = drawCanvas.getContext('2d');
            ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            ctx.strokeStyle = HIGHLIGHT_COLORS[selectedTag] || HIGHLIGHT_COLORS['기본'];
            ctx.lineWidth = currentThicknessPx;
            ctx.beginPath(); ctx.moveTo(pos.x, pos.y);
        } else if (selectMode === 'eraser') {
            st.pointerId = e.pointerId;
            try { drawCanvas.setPointerCapture(e.pointerId); } catch(err) { console.warn("Could not set pointer capture:", err); }
            st.startEraser = getPos(e);
        }
        else if (selectMode === 'ocrSelect') { // 👈 [추가] OCR 선택 시작 로직
        st.pointerId = e.pointerId;
        try { drawCanvas.setPointerCapture(e.pointerId); } catch(err) { /* ... */ }
        st.startOcr = getPos(e);
        ocrCurrentPage = p;
        removeOcrSelectionRect();

        // 선택 영역 div 생성 및 추가
        ocrSelectionRect = document.createElement('div');
        ocrSelectionRect.className = 'ocr-selection-rect';
        Object.assign(ocrSelectionRect.style, {
            left: `${st.startOcr.x}px`, top: `${st.startOcr.y}px`,
            width: '0px', height: '0px'
        });
        drawCanvas.parentNode.appendChild(ocrSelectionRect);
        }
    });

    drawCanvas.addEventListener('pointermove', (e) => {
        if (!pdfDoc || st.pointerId !== e.pointerId) return; // Only track captured pointer
        // Check buttons for mouse moves (e.g., must be left button down)
        if (e.pointerType === 'mouse' && e.buttons !== 1) return;

        const ctx = drawCanvas.getContext('2d');
        if (selectMode === 'pen' && st.drawing) {
            const pos = getPos(e);
            st.path.push(pos);
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke(); // Draw segment
        } else if (selectMode === 'eraser' && st.startEraser) {
             // Optionally draw the eraser rectangle while dragging
             // ctx.clearRect(0,0,drawCanvas.width, drawCanvas.height); // Clear previous rect?
             // redrawStrokesForPage(p); // Redraw strokes first
             // const currentPos = getPos(e);
             // ctx.fillStyle = 'rgba(255, 0, 0, 0.2)'; // Semi-transparent red
             // ctx.fillRect(st.startEraser.x, st.startEraser.y, currentPos.x - st.startEraser.x, currentPos.y - st.startEraser.y);
        }else if (selectMode === 'ocrSelect' && st.startOcr && ocrSelectionRect) { // 👈 [추가] OCR 선택 영역 업데이트
            const currentPos = getPos(e);
            const x = Math.min(st.startOcr.x, currentPos.x);
            const y = Math.min(st.startOcr.y, currentPos.y);
            const width = Math.abs(st.startOcr.x - currentPos.x);
            const height = Math.abs(st.startOcr.y - currentPos.y);
            Object.assign(ocrSelectionRect.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
        }
    });

    const finishStroke = () => {
        if (!st.drawing || !st.path || st.path.length < 2) { st.drawing = false; st.path = []; return; }
        st.drawing = false;
        const wrap = document.querySelector(`.page-wrap[data-page="${p}"]`);
        const draw = wrap?.querySelector('canvas.draw-layer');
        if (!draw) { st.path = []; return; }
        const w = parseFloat(draw.style.width), h = parseFloat(draw.style.height);
        if (!w || !h || isNaN(w) || isNaN(h)) { st.path = []; return; }

        const normPath = { points: st.path.map(pt => ({ x: pt.x / w, y: pt.y / h })) };
        const thicknessNorm = currentThicknessPx / h;
        const bb = bboxOfPoints(st.path);
        const strokeRadius = currentThicknessPx * 0.6;
        const hitBox = {x0: Math.max(0, bb.x0 - strokeRadius), y0: Math.max(0, bb.y0 - strokeRadius), x1: Math.min(w, bb.x1 + strokeRadius), y1: Math.min(h, bb.y1 + strokeRadius)};
        const color = HIGHLIGHT_COLORS[selectedTag] || HIGHLIGHT_COLORS['기본'];

        if (pendingChunk && pendingChunk.page === p && pendingChunk.tag === selectedTag && thicknessClose(pendingChunk.thicknessNorm, thicknessNorm, h)) {
            pendingChunk.paths.push(normPath);
            pendingChunk.bboxPx = unionBox(pendingChunk.bboxPx, hitBox);
            clearTimeout(pendingChunk.timer);
            pendingChunk.timer = setTimeout(finalizePendingChunk, 1000);
        } else {
            if (pendingChunk) finalizePendingChunk();
            pendingChunk = { page: p, tag: selectedTag, color, thicknessNorm, paths: [normPath], bboxPx: hitBox, timer: setTimeout(finalizePendingChunk, 1000) };
        }
        st.path = [];
    };

    const finishEraser = (end) => {
        if (!st.startEraser) return;
        const start = st.startEraser; st.startEraser = null;
        if (Math.abs(end.x - start.x) < 2 && Math.abs(end.y - start.y) < 2) return;
        const wrap = document.querySelector(`.page-wrap[data-page="${p}"]`);
        const draw = wrap?.querySelector('canvas.draw-layer');
        if (!draw) return;
        const w = parseFloat(draw.style.width), h = parseFloat(draw.style.height);
         if (!w || !h || isNaN(w) || isNaN(h)) return;

        const x0 = Math.min(start.x, end.x), y0 = Math.min(start.y, end.y), x1 = Math.max(start.x, end.x), y1 = Math.max(start.y, end.y);
        finalizePendingChunk();
        const toRemove = [];
        // Only consider highlights with a valid Firestore ID for removal
        highlights.filter(hh => 
            hh.page === p && 
            hh.id && !hh.id.startsWith('temp_') &&
            (hh.type === 'stroke' || hh.type === 'ocrBlock')
        ).forEach(hh =>{
            
            let bb; // 바운딩 박스
            if (hh.type === 'stroke') {
                bb = bboxOfPathStyle(hh.paths, w, h, (hh.thicknessNorm || 0) * h);
            } else if (hh.type === 'ocrBlock' && hh.bbox) {
                // ocrBlock의 바운딩 박스 계산
                bb = {
                    x0: hh.bbox.x0 * w, y0: hh.bbox.y0 * h,
                    x1: hh.bbox.x1 * w, y1: hh.bbox.y1 * h
                };
            } else {
                return; // bbox가 없으면 통과
            }

            // 지우개 영역과 겹치는지 확인
            if (boxesIntersect(
                {x0:x0/w, y0:y0/h, x1:x1/w, y1:y1/h}, // Eraser norm rect
                {x0:bb.x0/w, y0:bb.y0/h, x1:bb.x1/w, y1:bb.y1/h}  // Highlight norm rect
            )) {
                toRemove.push(hh.id); 
            }
        });

        if (toRemove.length) {
            const removedItems = removeHighlights(toRemove);
        }
    };

    const handlePointerEnd = (e) => {
        if (st.pointerId !== e.pointerId) return;
        // Check if the canvas still exists before releasing pointer capture
        if (drawCanvas.isConnected) {
             try {
                // Check if pointer capture is active before releasing
                if (drawCanvas.hasPointerCapture(e.pointerId)) {
                     drawCanvas.releasePointerCapture(e.pointerId);
                }
            } catch (err) {
                 // console.warn("Could not release pointer capture:", err);
            }
        }
        if (selectMode === 'pen') finishStroke();
        else if (selectMode === 'eraser') finishEraser(getPos(e));
        else if (selectMode === 'ocrSelect' && st.startOcr) {
        const endPos = getPos(e);
        const startPos = st.startOcr;
        st.startOcr = null;
        if (Math.abs(startPos.x - endPos.x) < 5 || Math.abs(startPos.y - endPos.y) < 5) {
            removeOcrSelectionRect(); // 너무 작으면 무시
        } else {
            const rect = { // draw-layer 기준 좌표
                x: Math.min(startPos.x, endPos.x), y: Math.min(startPos.y, endPos.y),
                width: Math.abs(startPos.x - endPos.x), height: Math.abs(startPos.y - endPos.y)
            };
            console.log(`OCR 영역 선택 완료 (페이지 ${ocrCurrentPage}):`, rect);
            extractAndRunOcr(ocrCurrentPage, rect); // OCR 실행 함수 호출
        }
    }
        st.pointerId = null;
    };
    drawCanvas.addEventListener('pointerup', handlePointerEnd);
    drawCanvas.addEventListener('pointercancel', handlePointerEnd);
}


// === Text Collection ===
function collectTextUnderBox(pageNumber, boxStylePx) {
    const wrap = document.querySelector(`.page-wrap[data-page="${pageNumber}"]`);
    if (!wrap) return '';
    const textLayer = wrap.querySelector('.textLayer');
    if (!textLayer) return ''; // textLayer 없으면 빈 문자열 반환
    const base = wrap.getBoundingClientRect();
    const items = [];

    // 1) TextLayer spans
    const spans = Array.from(textLayer.querySelectorAll('span'));
    spans.forEach(s => {
        const r = s.getBoundingClientRect();
        // base 기준으로 상대 좌표 계산
        const rect = { x0: r.left - base.left, y0: r.top - base.top, x1: r.right - base.left, y1: r.bottom - base.top };
        // Check for valid dimensions, ignore tiny or invisible spans
        if (rect.x1 > rect.x0 && rect.y1 > rect.y0 && rectsOverlapPx(boxStylePx, rect)) {
            const t = (s.textContent || '').trim();
            if (t) items.push({ t, top: rect.y0, left: rect.x0 });
        }
    });

    // 2) OCR words
    const pageOcrData = ocrData[pageNumber]; // 변수 이름 변경
    if (pageOcrData && pageOcrData.words && pageOcrData.words.length) {
        const renderCanvas = wrap.querySelector('canvas.page');
        if (!renderCanvas) return items.map(i => i.t).join(' ').replace(/\s+/g,' ').trim(); // canvas 없으면 TextLayer 결과만 반환

        // canvas 크기 정보 가져오기 전에 null 체크
        const styleWStr = renderCanvas.style.width;
        const styleHStr = renderCanvas.style.height;
        if (!styleWStr || !styleHStr) return items.map(i => i.t).join(' ').replace(/\s+/g,' ').trim(); // 크기 정보 없으면 TextLayer 결과만 반환

        const styleW = parseFloat(styleWStr);
        const styleH = parseFloat(styleHStr);
         // canvas.width/height가 0인 경우 대비
        const scaleX = renderCanvas.width > 0 ? styleW / renderCanvas.width : 1;
        const scaleY = renderCanvas.height > 0 ? styleH / renderCanvas.height : 1;

        pageOcrData.words.forEach(w => {
            const rect = { x0: w.bbox.x0 * scaleX, y0: w.bbox.y0 * scaleY, x1: w.bbox.x1 * scaleX, y1: w.bbox.y1 * scaleY };
            const t = (w.text || '').trim();
            if (t && rect.x1 > rect.x0 && rect.y1 > rect.y0 && rectsOverlapPx(boxStylePx, rect)) {
                 items.push({ t, top: rect.y0, left: rect.x0 });
            }
        });
    }

    // Sort items primarily by top, then by left
    items.sort((a,b)=> Math.abs(a.top - b.top) < 5 ? a.left - b.left : a.top - b.top); // Tolerance for sorting lines
    // Join text, attempt to preserve line breaks based on vertical distance
    let finalText = '';
    let lastTop = -Infinity;
    items.forEach(item => {
        if (item.top > lastTop + 10) { // Simple line break detection
            finalText += '\n';
        } else {
            finalText += ' ';
        }
        finalText += item.t;
        lastTop = item.top;
    });

    return finalText.replace(/\s+/g,' ').trim(); // Normalize whitespace at the end
}
function rectsOverlapPx(a, b){ return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0; }
function bboxOfPoints(pts) { let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity; pts.forEach(p => { x0=Math.min(x0,p.x); y0=Math.min(y0,p.y); x1=Math.max(x1,p.x); y1=Math.max(y1,p.y); }); return {x0,y0,x1,y1}; }
function bboxOfPathStyle(pathOrPaths, w, h, thicknessPx){
     const r = (thicknessPx || 20) * 0.6;
    let points = [];
    const processSegment = seg => {
        if (Array.isArray(seg)) {
             seg.forEach(pt => {
                 if (pt && typeof pt.x === 'number' && typeof pt.y === 'number' && !isNaN(pt.x) && !isNaN(pt.y)) { // Ensure valid points
                    points.push({ x: pt.x * w, y: pt.y * h });
                 }
            });
        }
    };

if (Array.isArray(pathOrPaths)) {
    // NEW structure: hh.paths = [ {points: [...]}, {points: [...]} ]
        if (pathOrPaths.length > 0 && pathOrPaths[0] && typeof pathOrPaths[0] === 'object' && Array.isArray(pathOrPaths[0].points)) {
            pathOrPaths.forEach(p => processSegment(p.points));
        } 
    // OLD structure: hh.path = [ {x,y}, {x,y}, ... ]
    else if (pathOrPaths.length > 0 && pathOrPaths[0] && typeof pathOrPaths[0].x === 'number') {
            processSegment(pathOrPaths);
        }
  }
    if (!points.length) return {x0:0,y0:0,x1:0,y1:0};
    const bb = bboxOfPoints(points);
    // Ensure bounds are within canvas dimensions
    return { x0: Math.max(0, bb.x0 - r), y0: Math.max(0, bb.y0 - r), x1: Math.min(w, bb.x1 + r), y1: Math.min(h, bb.y1 + r) };
}

// ====== Highlight Management (Firestore 연동) ======

function execAddHighlight(hData) {
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`; // More unique temp ID
    const tempHighlight = { ...hData, id: tempId };
    highlights.push(tempHighlight);
    redrawStrokesForPage(hData.page);
    renderNotes();
    addCommand({ action:'add', payload:{ id: tempId } }); // Add command with temp ID for local undo

    // Firestore 저장 요청 (ID는 Firestore에서 생성됨)
    if (window.saveHighlightChange) {
        window.saveHighlightChange('add', hData)
          .then(docRef => {
              // Optional: Update local temp highlight with real Firestore ID if needed
              // const realId = docRef.id;
              // const localIndex = highlights.findIndex(h => h.id === tempId);
              // if (localIndex !== -1) highlights[localIndex].id = realId;
              // Re-render notes maybe? renderNotes();
          })
          .catch(err => console.error("Error saving highlight:", err));
    } else {
        console.error("saveHighlightChange 함수를 찾을 수 없음.");
    }
}


// Undo 로직 (로컬 상태만 되돌림, Firestore 연동 X)
function undoAddHighlight(tempId) { // 임시 ID 사용
    const idx = highlights.findIndex(x => x.id === tempId);
    if (idx !== -1) {
        const pg = highlights[idx].page;
        const removedHighlight = highlights.splice(idx, 1)[0]; // Store for redo
        redrawStrokesForPage(pg);
        renderNotes();
        // Return removed data for redo stack in main undo function
        return removedHighlight;
    }
    return null;
}

function removeHighlights(ids) { // ids는 Firestore ID 배열
    const affected = new Set();
    const removedItems = [];
    highlights = highlights.filter(h => {
        // Keep temp highlights unless explicitly targeted (unlikely)
        if (ids.includes(h.id) && !h.id.startsWith('temp_')) {
            affected.add(h.page);
            removedItems.push(h); // 삭제될 객체 저장
            return false;
        }
        return true;
    });
    affected.forEach(p => redrawStrokesForPage(p));
    renderNotes();

    // Firestore 삭제 요청
    if (window.saveHighlightChange) {
        removedItems.forEach(removedHighlight => {
             window.saveHighlightChange('delete', removedHighlight);
        });
    } else {
         console.error("saveHighlightChange 함수를 찾을 수 없음.");
    }
    return removedItems; // Undo용으로 삭제된 객체 반환
}

function setHighlightTag(id, tag) { // id는 Firestore ID
    const hIndex = highlights.findIndex(x => x.id === id && !x.id.startsWith('temp_')); // Ignore temp IDs
    if (hIndex === -1) return;

    const originalTag = highlights[hIndex].tag;
    highlights[hIndex].tag = tag;
    highlights[hIndex].color = HIGHLIGHT_COLORS[tag] || HIGHLIGHT_COLORS['기본'];

    redrawStrokesForPage(highlights[hIndex].page);
    renderNotes();

    // Firestore 업데이트 요청
    if (window.saveHighlightChange) {
        // Pass the modified local object (with Firestore ID)
        window.saveHighlightChange('update', highlights[hIndex]);
    } else {
         console.error("saveHighlightChange 함수를 찾을 수 없음.");
    }
    // Return original tag for undo command
    return originalTag;
}

function setHighlightComment(id, comment) { // id는 Firestore ID
    const hIndex = highlights.findIndex(x => x.id === id && !x.id.startsWith('temp_')); // Ignore temp IDs
    if (hIndex === -1) return;

    const originalComment = highlights[hIndex].comment;
    highlights[hIndex].comment = comment;

    renderNotes(); // 노트 패널만 업데이트

    // Firestore 업데이트 요청
    if (window.saveHighlightChange) {
        // Pass the modified local object (with Firestore ID)
        window.saveHighlightChange('update', highlights[hIndex]);
    } else {
         console.error("saveHighlightChange 함수를 찾을 수 없음.");
    }
    // Return original comment for undo command
    return originalComment;
}

// ====== Redrawing Strokes ======
function redrawStrokesForPage(p) {
    const cache = pagesCache.get(p);
    if (!cache) return;
    const draw = cache.drawCanvas;
    const ctx = draw.getContext('2d');
    ctx.clearRect(0, 0, draw.width, draw.height);
    const w = draw.width, h = draw.height;
     // Ensure valid dimensions
     if (!w || !h || w === 0 || h === 0) return;

    // 1. [기존] 펜 스트로크(stroke) 그리기
    const items = highlights.filter(hh => hh.page === p && hh.type === 'stroke');
    items.forEach(hh => {
        const strokeColor = hh.color || HIGHLIGHT_COLORS['기본'];
        // Use default thickness if thicknessNorm is missing or invalid
        const defaultThicknessNorm = 20 / h; // Default 20px normalized
        const normThickness = (typeof hh.thicknessNorm === 'number' && !isNaN(hh.thicknessNorm)) ? hh.thicknessNorm : defaultThicknessNorm;
        const lineW = Math.max(2, normThickness * h);

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = strokeColor;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.lineWidth = lineW;

        // paths(다중 세그먼트) 지원 + 기존 path 호환
        const segments = Array.isArray(hh.paths) ? hh.paths.map(p => p.points) : (Array.isArray(hh.path) ? [hh.path] : []);

        ctx.beginPath();
        segments.forEach(seg => {
            if (!Array.isArray(seg)) return; // Skip if segment is not an array
             // Filter out invalid points before mapping
            const validPoints = seg.filter(pt => pt && typeof pt.x === 'number' && typeof pt.y === 'number' && !isNaN(pt.x) && !isNaN(pt.y));
            if (validPoints.length === 0) return; // Skip if no valid points in segment

            const path = validPoints.map(pt => ({ x: pt.x * w, y: pt.y * h }));
            if (path.length > 0) {
                 ctx.moveTo(path[0].x, path[0].y);
                 for (let i = 1; i < path.length; i++) {
                    ctx.lineTo(path[i].x, path[i].y);
                }
            }
        });
         if (!ctx.isPointInPath(0, 0)) { // Check if path is empty before stroking
             ctx.stroke();
        }
        ctx.restore();
    });

    // 👇 [추가] 2. OCR 블록(ocrBlock) 그리기
    const ocrBlocks = highlights.filter(hh => hh.page === p && hh.type === 'ocrBlock');
    ocrBlocks.forEach(hh => {
        if (!hh.bbox) return; // bbox 없으면 그릴 수 없음

        // 정규화된 bbox를 픽셀 좌표로 변환
        const rect = { 
            x: hh.bbox.x0 * w,
            y: hh.bbox.y0 * h,
            width: (hh.bbox.x1 - hh.bbox.x0) * w,
            height: (hh.bbox.y1 - hh.bbox.y0) * h
        };
        
        ctx.save();
        // 'OCR' 태그 색상 (반투명 파랑)으로 채우기
        ctx.fillStyle = hh.color || HIGHLIGHT_COLORS['OCR'];
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height); 
        
        // (선택) 더 진한 색으로 테두리 추가
        const borderColor = (hh.color || HIGHLIGHT_COLORS['OCR']).replace('0.35', '0.8'); 
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 1; 
        ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
        
        ctx.restore();
    });
}
// ====== Notes Panel ======
function noteFilterActive() { const btn = document.querySelector('.right-tabs button.active'); return btn ? btn.dataset.filter : 'all';}
function renderNotes() {
    if (!els.notes) return;
    const filter = noteFilterActive();
    els.notes.innerHTML = '';
    // Filter highlights, excluding temporary ones
    const items = highlights.filter(h => !h.id.startsWith('temp_') && (filter === 'all' || h.tag === filter));
    if (!items.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '하이라이트가 없습니다'; els.notes.appendChild(empty); return; }

    items.sort((a,b)=> a.page - b.page); // Sort by page number

    items.forEach(h => {
        if (!h.id) return; // Should not happen with the filter above, but safety check

        const div = document.createElement('div');
        div.className = 'note';
        div.dataset.id = String(h.id); // Firestore ID
        const left = document.createElement('div');
        const topRow = document.createElement('div');
        topRow.innerHTML = `<span class="meta">p.${h.page}</span> · <span class="tag">${h.tag || '기본'}</span>`;
        const text = document.createElement('div');
        text.textContent = (h.text && h.text.trim()) ? h.text : '(형광펜 스트로크)';
        text.style.cursor = 'pointer';
        text.addEventListener('click', ()=> scrollToPage(h.page));
        const textarea = document.createElement('textarea');
        textarea.placeholder = '댓글 입력...';
        textarea.value = h.comment || '';
        // Debounce textarea changes
        let debounceTimer;
        textarea.addEventListener('input', () => {
             clearTimeout(debounceTimer);
             debounceTimer = setTimeout(() => {
                setHighlightComment(h.id, textarea.value);
            }, 500); // Wait 500ms after last input
        });
        left.appendChild(topRow); left.appendChild(text); left.appendChild(textarea);

        const right = document.createElement('div');
        const del = document.createElement('button'); del.title = '삭제'; del.innerHTML = '<i class="fa-regular fa-trash-can"></i>';
        del.addEventListener('click', ()=> {
            const removed = removeHighlights([h.id]); // Pass Firestore ID
            // addCommand({ action:'remove', payload:{ ids:[h.id], removed } }); // Local undo command
        });
        const cycle = document.createElement('button'); cycle.title = '태그 변경'; cycle.innerHTML = '<i class="fa-solid fa-tag"></i>';
        cycle.addEventListener('click', ()=> {
            const order = ['기본','중요','암기','참고'];
            const cur = h.tag || '기본';
            const next = order[(order.indexOf(cur) + 1) % order.length];
            const prev = cur;
            const originalTag = setHighlightTag(h.id, next); // Pass Firestore ID
            // addCommand({ action:'setTag', payload:{ id:h.id, prev: originalTag, next } }); // Local undo command
        });
        right.appendChild(cycle); right.appendChild(del);

        div.appendChild(left); div.appendChild(right);
        els.notes.appendChild(div);
    });
}

// ====== Search ======
function performSearch() {
     if (!pdfDoc) return;
    const q = (els.searchInput?.value || '').trim().toLowerCase();
    searchHits = []; searchCursor = -1;
    if (!q) {
        // Clear previous highlights or markers if needed
        console.log("Search cleared.");
        return;
    }
    searchIndex.forEach(item => {
        if (!item || !item.textLower) return;
        let lastIndex = -1;
        while ((lastIndex = item.textLower.indexOf(q, lastIndex + 1)) !== -1) {
            searchHits.push({ page: item.page, index: lastIndex });
        }
    });
    if (searchHits.length) {
        moveSearchCursor(0); // Go to first hit
        console.log(`Found ${searchHits.length} results for "${q}"`);
    } else {
         alert('검색 결과가 없습니다');
         console.log(`No results for "${q}"`);
    }
}
function moveSearchCursor(dir) {
    if (!searchHits.length) return;
    // Use dir=0 to go to first, dir=1 for next, dir=-1 for prev
    if (dir === 0) searchCursor = 0;
    else searchCursor = (searchCursor + dir + searchHits.length) % searchHits.length;

    const hit = searchHits[searchCursor];
    scrollToPage(hit.page);

    // Basic visual feedback
    console.log(`Navigating to search result ${searchCursor + 1}/${searchHits.length} on page ${hit.page}`);
    const wrap = document.querySelector(`.page-wrap[data-page="${hit.page}"]`);
    if (!wrap) return;
    // Maybe flash outline instead of keeping it
    wrap.style.outline = `3px solid red`; // More visible outline
    setTimeout(()=> wrap.style.outline = 'none', 1500); // Longer duration

    // TODO: More precise highlighting of the search term using hit.index
    // This involves finding the text span in the textLayer based on character index,
    // which can be complex with how pdf.js structures the text layer.
}


// ====== Event Listeners Setup within DOMContentLoaded ======
document.addEventListener('DOMContentLoaded', ()=> {
    // 1. Ripple 효과 먼저 적용
    attachRipplesTo('button, .chip-btn, .label-btn, .right-tabs button, .sidebar-tabs button');

    // 2. 여기에 모든 이벤트 리스너 연결 코드를 붙여넣습니다!
    console.log("Adding event listeners after DOMContentLoaded...");

    els.prevPage?.addEventListener('click', () => { if (!pdfDoc) return; currentPage = Math.max(1, currentPage - 1); scrollToPage(currentPage); });
    els.nextPage?.addEventListener('click', () => { if (!pdfDoc) return; currentPage = Math.min(pdfDoc.numPages, currentPage + 1); scrollToPage(currentPage); });
    els.jumpInput?.addEventListener('keydown', (e)=> { if (e.key==='Enter' && pdfDoc && els.jumpInput) { const pVal = parseInt(els.jumpInput.value, 10); if (!isNaN(pVal)) { const p = Math.max(1, Math.min(pdfDoc.numPages, pVal)); scrollToPage(p); } els.jumpInput.value=''; }});
    els.zoomIn?.addEventListener('click', ()=> { if (!pdfDoc) return; finalizePendingChunk(); scale = Math.min(3, scale + 0.1); rerenderAll(); });
    els.zoomOut?.addEventListener('click', ()=> { if (!pdfDoc) return; finalizePendingChunk(); scale = Math.max(0.3, scale - 0.1); rerenderAll(); });
    els.zoomReset?.addEventListener('click', ()=> { if (!pdfDoc) return; finalizePendingChunk(); scale = 1.0; rerenderAll(); });
    els.toggleDark?.addEventListener('click', ()=> { document.body.classList.toggle('dark'); }); // Ensure CSS supports .dark
    els.modeContinuous?.addEventListener('click', ()=> { if (continuousMode) return; finalizePendingChunk(); continuousMode = true; els.modeContinuous?.classList.add('active'); els.modeSingle?.classList.remove('active'); rerenderAll(); });
    els.modeSingle?.addEventListener('click', ()=> { if (!continuousMode) return; finalizePendingChunk(); continuousMode = false; els.modeSingle?.classList.add('active'); els.modeContinuous?.classList.remove('active'); rerenderAll(); });

    // --- Local Undo/Redo Logic ---
    els.undoBtn?.addEventListener('click', () => {
        finalizePendingChunk();
        const cmd = undoStack.pop();
        if (!cmd) { console.log("Undo stack empty"); return; }
        console.log("Attempting local undo:", cmd.action, cmd.payload);

        let redoData = null; // Store data needed to redo the action

        // Perform local undo based on action type
        switch (cmd.action) {
            case 'add':
                redoData = undoAddHighlight(cmd.payload.id); // Use temp ID
                break;
            case 'remove':
                // Re-add highlights locally (data stored in cmd.payload.removed)
                if (cmd.payload.removed && cmd.payload.removed.length > 0) {
                    highlights.push(...cmd.payload.removed);
                     // Redraw affected pages
                    const affectedPages = new Set(cmd.payload.removed.map(h => h.page));
                    affectedPages.forEach(p => redrawStrokesForPage(p));
                    renderNotes();
                    redoData = cmd.payload.ids; // Store IDs for redo
                }
                break;
            case 'setTag':
                // Revert tag locally
                redoData = setHighlightTag(cmd.payload.id, cmd.payload.prev); // Reverts and returns the 'next' tag for redo
                break;
             case 'comment': // Assuming you add comment command
                 redoData = setHighlightComment(cmd.payload.id, cmd.payload.prev); // Reverts and returns the 'next' comment for redo
                 break;
            default:
                console.warn("Unknown undo command:", cmd.action);
        }

        // Push the original command (with necessary redo data) onto redo stack
        if (redoData !== null) { // Only push if undo action produced redo data
             // Modify cmd or create new redoCmd as needed
             cmd.redoPayload = redoData; // Store what's needed for redo
            redoStack.push(cmd);
        }
        updateButtons();
    });

    els.redoBtn?.addEventListener('click', () => {
        finalizePendingChunk();
        const cmd = redoStack.pop();
        if (!cmd) { console.log("Redo stack empty"); return; }
        console.log("Attempting local redo:", cmd.action, cmd.payload);

        // Perform local redo based on action type
        switch (cmd.action) {
            case 'add':
                 // Re-add locally using data possibly stored during undo?
                 // This requires storing the original highlight data (hData) in the command.
                 // Assuming cmd.payload.originalData holds the highlight object
                 if (cmd.payload.originalData) {
                     // Need a way to re-insert without triggering 'add' to Firestore again
                     // Maybe a flag or separate function? For now, just re-add locally.
                     highlights.push(cmd.payload.originalData);
                     redrawStrokesForPage(cmd.payload.originalData.page);
                     renderNotes();
                 } else { console.warn("Cannot redo add: original data missing"); }
                break;
            case 'remove':
                // Re-remove locally using IDs stored during undo (cmd.redoPayload)
                if (cmd.redoPayload && cmd.redoPayload.length > 0) {
                     removeHighlights(cmd.redoPayload); // This triggers Firestore delete again! Need local-only version?
                }
                 break;
            case 'setTag':
                // Re-apply tag locally using data stored during undo (cmd.payload.next)
                if (cmd.payload.next) {
                    setHighlightTag(cmd.payload.id, cmd.payload.next); // This triggers Firestore update again! Need local-only version?
                }
                break;
             case 'comment':
                 if (cmd.payload.next) {
                     setHighlightComment(cmd.payload.id, cmd.payload.next); // Triggers Firestore update again!
                 }
                 break;
            default:
                console.warn("Unknown redo command:", cmd.action);
        }

        undoStack.push(cmd); // Push back onto undo stack
        updateButtons();
    });
     // --- End Local Undo/Redo ---

    els.penBtn?.addEventListener('click', ()=> {
        console.log("펜 버튼 클릭됨!"); // <-- 확인용 로그
        flushPendingIfAny();
        setMode(selectMode === 'pen' ? 'none' : 'pen');
    });
    els.eraserBtn?.addEventListener('click', ()=> {
         console.log("지우개 버튼 클릭됨!"); // <-- 확인용 로그
        flushPendingIfAny();
        setMode(selectMode === 'eraser' ? 'none' : 'eraser');
    });
    els.tagBtns?.forEach(btn => btn.addEventListener('click', (e)=> {
         console.log("태그 버튼 클릭됨:", e.target.dataset.tag); // <-- 확인용 로그
        flushPendingIfAny();
        selectedTag = e.target.dataset.tag || '기본';
        setMode('pen'); // Automatically switch to pen mode when a tag is selected
         // Optionally highlight the selected tag button
         els.tagBtns.forEach(b => b.classList.remove('active')); // Example: remove active from all
         e.target.classList.add('active'); // Example: add active to clicked
    }));
    els.thickness?.addEventListener('input', () => {
        currentThicknessPx = Number(els.thickness.value);
        if (els.thicknessLabel) els.thicknessLabel.textContent = `${currentThicknessPx} px`;
        localStorage.setItem('pdfViewer.penThicknessPx', String(currentThicknessPx));
    });
    els.searchPrev?.addEventListener('click', ()=> moveSearchCursor(-1));
    els.searchNext?.addEventListener('click', ()=> moveSearchCursor(1));
    els.searchInput?.addEventListener('keydown', (e)=> { if (e.key === 'Enter') performSearch(); });

    document.querySelectorAll('.sidebar .sidebar-tabs button').forEach(b => {
        b.addEventListener('click', (e) => {
            document.querySelectorAll('.sidebar .sidebar-tabs button').forEach(btn => btn.classList.remove('active'));
            const clickedButton = e.target.closest('button'); // Ensure we get the button element
            if (!clickedButton) return;
            clickedButton.classList.add('active');
            const targetId = clickedButton.id;
            let contentToShow = 'thumbs';
            if (targetId === 'tabOutline') contentToShow = 'outline';
            else if (targetId === 'tabBookmarks') contentToShow = 'bookmarks';
            else if (targetId === 'tabDocs') contentToShow = 'doc-list'; // Assuming id="tabDocs" exists
            switchSidebar(contentToShow);
        });
    });

    els.rightFilterTabs?.forEach(b => b.addEventListener('click', (e) => {
        const clickedButton = e.target.closest('button');
        if (!clickedButton) return;
        els.rightFilterTabs.forEach(x => x.classList.remove('active'));
        clickedButton.classList.add('active');
        renderNotes();
    }));

    els.addBookmark?.addEventListener('click', () => {
        if (!pdfDoc) return;
        finalizePendingChunk();
        const label = prompt('북마크 이름 입력 (선택)') || '';
        bookmarks.push({ page: currentPage, label, time: Date.now() });
        renderBookmarks(); saveLocal();
    });

    els.exportNotes?.addEventListener('click', () => {
        finalizePendingChunk();
        if (!highlights.length) { alert('내보낼 노트가 없습니다'); return; }
        const rows = [['id','page','tag','text','comment','type','thickness_px','segment_count']];
        highlights.forEach(h => {
             // Only export highlights with Firestore ID
             if (h.id && !h.id.startsWith('temp_')) {
                 const pageCache = pagesCache.get(h.page);
                const pageHeight = pageCache?.drawCanvas?.height || 0;
                 rows.push([
                    h.id,
                    h.page,
                    h.tag || '기본',
                    escapeCsv(h.text || ''),
                    escapeCsv(h.comment || ''),
                    h.type || 'stroke',
                    pageHeight > 0 ? Math.round((h.thicknessNorm || 0) * pageHeight) : 0, // Avoid NaN
                    Array.isArray(h.paths) ? h.paths.length : (Array.isArray(h.path) ? 1 : 0)
                ]);
            }
        });
        const csv = rows.map(r => r.join(',')).join('\n');
        const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csv], { type: 'text/csv;charset=utf-8;' }); // Add BOM for Excel UTF-8
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'notes.csv'; a.click();
        URL.revokeObjectURL(url);
    });

    els.clearData?.addEventListener('click', ()=> {
        // 로컬 북마크/OCR만 삭제
        finalizePendingChunk();
        if (confirm('로컬 북마크와 OCR 데이터를 삭제할까요? (클라우드 하이라이트는 유지됩니다)')) {
            bookmarks = []; ocrData = {}; saveLocal();
            renderBookmarks(); // 북마크 UI 업데이트
            document.querySelectorAll('.ocr-layer').forEach(el => el.remove());
        }
    });

    els.ocrPage?.addEventListener('click', () => { finalizePendingChunk(); if (pdfDoc) runOcrForPage(currentPage); });
    els.ocrAll?.addEventListener('click', () => { finalizePendingChunk(); if (pdfDoc) runOcrAll(); });
    els.ocrToggleDebug?.addEventListener('click', toggleOcrDebug);

    // ====== Shortcuts ======
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

        if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); els.undoBtn?.click(); }
        if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); els.redoBtn?.click(); }
        if (e.key.toLowerCase() === 'h') { e.preventDefault(); els.penBtn?.click(); }
        if (e.key.toLowerCase() === 'e') { e.preventDefault(); els.eraserBtn?.click(); }
        if (e.key === '=' || e.key === '+') { e.preventDefault(); els.zoomIn?.click(); }
        if (e.key === '-') { e.preventDefault(); els.zoomOut?.click(); }
        if (e.key === '0') { e.preventDefault(); els.zoomReset?.click(); }
        if (e.key === 'PageDown' || e.key === 'ArrowRight') { e.preventDefault(); els.nextPage?.click(); }
        if (e.key === 'PageUp' || e.key === 'ArrowLeft') { e.preventDefault(); els.prevPage?.click(); }
        if (e.key === ']') {
            e.preventDefault();
            currentThicknessPx = Math.min(48, currentThicknessPx + 2);
            if (els.thickness) els.thickness.value = String(currentThicknessPx);
            if (els.thicknessLabel) els.thicknessLabel.textContent = `${currentThicknessPx} px`;
            localStorage.setItem('pdfViewer.penThicknessPx', String(currentThicknessPx));
        }
        if (e.key === '[') {
            e.preventDefault();
            currentThicknessPx = Math.max(6, currentThicknessPx - 2);
            if (els.thickness) els.thickness.value = String(currentThicknessPx);
            if (els.thicknessLabel) els.thicknessLabel.textContent = `${currentThicknessPx} px`;
            localStorage.setItem('pdfViewer.penThicknessPx', String(currentThicknessPx));
        }
    });
    
    els.ocrSelectBtn = document.getElementById('ocrSelectBtn'); // els 객체에 OCR 버튼 추가
        els.ocrSelectBtn?.addEventListener('click', () => {
            setMode(selectMode === 'ocrSelect' ? 'none' : 'ocrSelect');
        });
// --- [추가] OCR 결과 모달 리스너 ---
    elsOcrModal.closeBtn?.addEventListener('click', hideOcrResultModal);
    elsOcrModal.copyBtn?.addEventListener('click', () => {
        if (elsOcrModal.textarea) {
            elsOcrModal.textarea.select();
            try {
                document.execCommand('copy'); // 클립보드 복사
                console.log('클립보드에 복사 성공');
                // (선택적) 사용자 피드백 (버튼 텍스트 변경 등)
                const originalText = elsOcrModal.copyBtn.textContent;
                elsOcrModal.copyBtn.textContent = '복사 완료!';
                setTimeout(() => { elsOcrModal.copyBtn.textContent = originalText; }, 1500);
            } catch (err) { console.error('클립보드 복사 실패:', err); alert('복사 실패'); }
        }
    });
    elsOcrModal.overlay?.addEventListener('click', (e) => { // 바깥 클릭 시 닫기
    if (e.target === elsOcrModal.overlay) { hideOcrResultModal(); }
    });

    // --- [추가] OCR 모드 커서 스타일 ---
    const style = document.createElement('style');
    style.textContent = `.page-wrap.ocr-select-mode .draw-layer { cursor: crosshair !important; }`;
    document.head.appendChild(style);

    console.log("Event listeners added.");
    updateButtons(); // Initialize button states after listeners are added
}); // <-- DOMContentLoaded 끝


// ====== OCR helpers ======
function applyOcrLayer(p) {
    const wrap = document.querySelector(`.page-wrap[data-page="${p}"]`);
    if (!wrap) return;
    let layer = wrap.querySelector('.ocr-layer');
    const canvas = wrap.querySelector('canvas.page');
    if (!canvas) return;
    const styleW = parseFloat(canvas.style.width);
    const styleH = parseFloat(canvas.style.height);
     if (isNaN(styleW) || isNaN(styleH) || canvas.width === 0 || canvas.height === 0) return;
    const sx = styleW / canvas.width;
    const sy = styleH / canvas.height;

    if (!layer) {
        layer = document.createElement('div');
        layer.className = 'ocr-layer';
        wrap.appendChild(layer);
    }
    layer.style.width = canvas.style.width;
    layer.style.height = canvas.style.height;
    layer.innerHTML = '';

    const pageOcrData = ocrData[p];
    if (!pageOcrData || !pageOcrData.words) return;
    pageOcrData.words.forEach(w => {
        const span = document.createElement('span');
        span.className = 'ocr-word';
        if (ocrDebugVisible) span.classList.add('debug');
        span.textContent = w.text;
        const x = w.bbox.x0 * sx, y = w.bbox.y0 * sy, wdt = (w.bbox.x1 - w.bbox.x0) * sx, hgt = (w.bbox.y1 - w.bbox.y0) * sy;
         // Ensure dimensions are positive
         if (wdt > 0 && hgt > 0) {
            span.style.left = x + 'px';
            span.style.top = y + 'px';
            span.style.width = wdt + 'px';
            span.style.height = hgt + 'px';
            layer.appendChild(span);
        }
    });
}
async function runOcrForPage(p) {
    if (!pdfDoc || !window.Tesseract) return;
    if (els.ocrStatus) els.ocrStatus.textContent = `OCR 처리중… p.${p}`;
    const wrap = document.querySelector(`.page-wrap[data-page="${p}"]`);
    const canvas = wrap?.querySelector('canvas.page');
    if (!canvas) { if (els.ocrStatus) els.ocrStatus.textContent = `오류: 캔버스 없음 p.${p}`; return; }

    let worker = null; // Declare worker here
    try {
         const dataUrl = canvas.toDataURL('image/png'); // Consider quality parameter if needed
         worker = await Tesseract.createWorker(els.ocrLang?.value || 'kor+eng');
         // Optionally set OCR parameters here: await worker.setParameters({...});
         const { data } = await worker.recognize(dataUrl);
         // await worker.terminate(); // Terminate moved to finally block

         const words = (data.words || []).map(w => ({ text: w.text, bbox: w.bbox }));
         ocrData[p] = { words };
         applyOcrLayer(p);
         saveLocal();
         if (els.ocrStatus) els.ocrStatus.textContent = `OCR 완료: p.${p} — 단어 ${words.length}개`;
    } catch (error) {
         console.error(`OCR 실패 p.${p}:`, error);
         if (els.ocrStatus) els.ocrStatus.textContent = `OCR 실패 p.${p}`;
    } finally {
        if (worker) await worker.terminate(); // Ensure termination
    }
}
async function runOcrAll() {
    if (!pdfDoc || !window.Tesseract) return;
    const lang = els.ocrLang?.value || 'kor+eng';
    if (els.ocrStatus) els.ocrStatus.textContent = `전체 OCR 시작 (${lang})`;
    let worker = null;

    try {
         worker = await Tesseract.createWorker(lang);
         for (let p = 1; p <= pdfDoc.numPages; p++) {
             const wrap = document.querySelector(`.page-wrap[data-page="${p}"]`);
             const canvas = wrap?.querySelector('canvas.page');
             if (!canvas) continue;

             if (els.ocrStatus) els.ocrStatus.textContent = `OCR 처리중: p.${p}/${pdfDoc.numPages}`;
             const dataUrl = canvas.toDataURL('image/png');
             const { data } = await worker.recognize(dataUrl);
             const words = (data.words || []).map(w => ({ text: w.text, bbox: w.bbox }));
             ocrData[p] = { words };
             applyOcrLayer(p);
             console.log(`OCR p.${p}: ${words.length} words`);
         }
         if (els.ocrStatus) els.ocrStatus.textContent = `전체 OCR 완료`;
    } catch (error) {
         console.error("전체 OCR 실패:", error);
         if (els.ocrStatus) els.ocrStatus.textContent = `전체 OCR 실패`;
    } finally {
         if (worker) await worker.terminate();
         saveLocal(); // Save accumulated OCR data
    }
}
function toggleOcrDebug() {
    ocrDebugVisible = !ocrDebugVisible;
    document.querySelectorAll('.ocr-word').forEach(el => el.classList.toggle('debug', ocrDebugVisible));
}



// ====== Restore last opened file (삭제 또는 수정) ======
(async function restoreFile(){
    // Firestore 시스템에서는 이 로직 사용 안 함.
})();

// ====== Firestore 데이터 받는 함수 (doc.js에서 호출) ======
function setHighlightsData(newHighlights) {
    if (Array.isArray(newHighlights)) {
        // Firestore에서 받은 데이터로 교체 (Firestore ID 포함)
        // Ensure IDs are consistent and handle potential duplicates if logic allows
        highlights = newHighlights.map(h => ({ ...h })); // Simple copy
        console.log("Firestore 하이라이트 업데이트:", highlights.length, "개");

        // 화면 다시 그리기
        if (pdfDoc) {
             // Redraw only necessary pages if performance is an issue
            for (let p = 1; p <= pdfDoc.numPages; p++) {
                redrawStrokesForPage(p);
            }
        }
        renderNotes(); // Update notes panel with new data
        updateButtons(); // Update undo/redo state if needed (likely reset)
    } else {
        console.error("잘못된 하이라이트 데이터:", newHighlights);
        highlights = []; // Clear local data on error
         if (pdfDoc) { // Clear screen
            for (let p = 1; p <= pdfDoc.numPages; p++) redrawStrokesForPage(p);
        }
        renderNotes();
        updateButtons();
    }
}
// 전역 등록은 파일 맨 끝으로 이동 (함수 선언 후)

// ====== Extra helpers ======
function boxesIntersect(a, b) { return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0; }
function escapeCsv(s){ const t = String(s ?? '').replaceAll('"', '""'); return `"${t}"`; }

// 문서 닫기 함수 (doc.js에서 호출 가능)
function clearDocument() {
    pdfDoc = null; // Clear PDF document object
    highlights = [];
    undoStack = [];
    redoStack = [];
    pagesCache.clear();
    searchIndex = []; // Clear search index
    ocrData = {}; // Clear OCR data? Or keep if related to file hash? Keep for now.
    bookmarks = []; // Clear bookmarks? Or keep per file hash? Keep for now.

    clearViewer(); // HTML 요소 비우기
    if (els.empty) els.empty.style.display = 'grid'; // 초기 메시지 보이기
    if (els.pages) els.pages.style.display = 'none'; // PDF 영역 숨기기
    currentPage = 1; // Reset page number
    scale = 1.0; // Reset zoom
    updateToolbar(); // 툴바 업데이트
    renderNotes(); // 노트 패널 비우기
     renderBookmarks(); // 북마크 패널 비우기
    console.log("문서 닫힘.");
    updateButtons(); // Update undo/redo state
}

function switchSidebar(contentId) {
    const container = document.getElementById('sidebarContent');
    if (!container) return;

    // 모든 자식 패널 숨기기
    const panels = container.children;
    for (let i = 0; i < panels.length; i++) {
        const panel = panels[i];
        if (panel.style) { // 'style' 속성이 있는지 확인
            panel.style.display = 'none';
        }
    }

    // 대상 패널만 보여주기
    const targetPanel = document.getElementById(contentId);
    if (targetPanel) {
        // 'ul' 태그는 'list-item'이나 'block'으로, 'div'는 'block'으로
        targetPanel.style.display = (targetPanel.tagName === 'UL') ? 'block' : 'block'; 
    }
}


// ===== [새 함수 1] OCR 영역 추출 및 실행 함수 =====
async function extractAndRunOcr(pageNumber, rect) {
    const pageCache = pagesCache.get(pageNumber);
    if (!pageCache || !pageCache.canvas) {
        console.error("OCR 오류: 해당 페이지의 원본 캔버스(pageCache.canvas)를 찾을 수 없습니다.");
        removeOcrSelectionRect();
        return;
    }

    const sourceCanvas = pageCache.canvas; // PDF 내용이 그려진 canvas.page
    const scaleX = sourceCanvas.width / parseFloat(sourceCanvas.style.width);
    const scaleY = sourceCanvas.height / parseFloat(sourceCanvas.style.height);
    const sx = rect.x * scaleX, sy = rect.y * scaleY, sWidth = rect.width * scaleX, sHeight = rect.height * scaleY;

    // 임시 캔버스 생성하여 선택 영역 그리기
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
    console.log("추출된 이미지 데이터 길이:", base64ImageData.length);
    
    // [수정] 팝업 로딩 대신 '로딩 중...' 커서 표시
    document.body.style.cursor = 'wait';

    // Cloud Function 호출 (try...catch 블록 1개로 정리)
    try {
        const runOcrOnSelection = httpsCallable(functions, 'runOcrOnSelection');
        const result = await runOcrOnSelection({ imageData: base64ImageData });
        const detectedText = result.data.text || "";
        console.log("Cloud Vision API 결과:", detectedText);

        // 👇 [핵심] 팝업 대신 하이라이트로 저장하는 로직
        if (detectedText.trim()) {
            // 1. 뷰어에 표시할 'rect' 좌표를 'norm' 좌표(0~1)로 변환
            const drawCanvas = pageCache.drawCanvas;
            const w = parseFloat(drawCanvas.style.width);
            const h = parseFloat(drawCanvas.style.height);
            
            const normRect = {
                x0: rect.x / w,
                y0: rect.y / h,
                x1: (rect.x + rect.width) / w,
                y1: (rect.y + rect.height) / h
            };

            // 2. 'highlight' 객체 생성
            const highlightData = {
                page: pageNumber,
                type: 'ocrBlock', // 👈 'stroke'와 구분되는 새 타입
                bbox: normRect,    // 👈 펜 'paths' 대신 정규화된 'bbox' 저장
                text: detectedText.trim(), // 👈 AI가 요약한 줄글
                tag: 'OCR', // 👈 'OCR' 태그 자동 지정
                color: HIGHLIGHT_COLORS['OCR'],
                comment: ''
            };

            // 3. 저장 함수 호출 (펜 저장과 동일한 함수 사용)
            execAddHighlight(highlightData); 

        } else {
            alert("추출된 텍스트가 없습니다.");
        }
        // 👆 [수정 완료]

    } catch (error) {
        console.error("Cloud Vision OCR 함수 호출 오류:", error);
        alert(`OCR 오류: ${error.message}`); // 팝업 대신 alert 사용
    } finally {
        document.body.style.cursor = 'default'; // 👈 커서 복원
        removeOcrSelectionRect(); // 작업 완료 후 선택 영역 제거
        setMode('none'); // OCR 모드 해제
    }
}

// ===== [새 함수 2] OCR 선택 영역 제거 함수 =====
function removeOcrSelectionRect() {
    if (ocrSelectionRect) { ocrSelectionRect.remove(); ocrSelectionRect = null; }
}

// ===== [새 함수 3] OCR 결과 모달 관련 함수 =====
const elsOcrModal = { // 모달 요소 캐싱
    overlay: document.getElementById('ocr-result-modal'),
    content: document.getElementById('ocr-result-content'),
    textarea: document.getElementById('ocr-result-text'),
    copyBtn: document.getElementById('ocr-copy-btn'),
    closeBtn: document.getElementById('ocr-close-btn')
};
function showOcrResultModal(isLoading = false, text = "", isError = false) {
    if (!elsOcrModal.overlay || !elsOcrModal.content || !elsOcrModal.textarea) return;
    elsOcrModal.textarea.value = text;
    if (isLoading) {
        elsOcrModal.content.innerHTML = '<div class="loading-spinner"></div><p style="text-align: center; color: var(--muted);">텍스트 추출 중...</p>';
        elsOcrModal.textarea.style.display = 'none'; elsOcrModal.copyBtn.style.display = 'none';
    } else if (isError) {
        elsOcrModal.content.innerHTML = `<p style="text-align: center; color: red;">${text || '오류 발생.'}</p>`;
        elsOcrModal.textarea.style.display = 'none'; elsOcrModal.copyBtn.style.display = 'none';
    } else {
        elsOcrModal.content.innerHTML = ''; // 로딩/오류 제거
        elsOcrModal.textarea.style.display = 'block'; elsOcrModal.copyBtn.style.display = 'inline-block';
    }
    elsOcrModal.overlay.classList.remove('hidden');
}
function hideOcrResultModal() { elsOcrModal.overlay?.classList.add('hidden'); }


// ====== 전역 등록 ======
// Make functions accessible globally if called from other modules or HTML
window.renderDocument = renderDocument;
window.setHighlightsData = setHighlightsData;
window.clearDocument = clearDocument;
// Expose doc.js functions globally if needed by viewer.js (though direct calls are better)
// Example: If viewer needs to trigger file upload
// window.createDocFromFile = createDocFromFile; // Assuming createDocFromFile is imported/available

console.log("viewer.js loaded"); // Log to confirm script execution