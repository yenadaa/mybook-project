import * as state from './viewer-state.js';
import * as utils from './viewer-utils.js';
import { execAddHighlight, removeHighlights } from './viewer-highlight-manager.js';
import { getPagesCache } from './viewer-renderer.js';
import { extractAndRunOcr, removeOcrSelectionRect } from './viewer-ocr.js';

const drawState = new Map();

export function initDrawLayer(p, drawCanvas) {
    const st = { drawing: false, path: [], startErasher: null, startOcr: null, pointerId: null };
    drawState.set(p, st);
    const getPos = (e) => { const rect = drawCanvas.getBoundingClientRect(); return { x: e.clientX - rect.left, y: e.clientY - rect.top }; };

    drawCanvas.addEventListener('pointerdown', (e) => {
        if (!state.pdfDoc || st.pointerId !== null) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
                                        //[수정][12-09][검정펜 버튼 눌렀을 때 그리기]
        if (state.selectMode === 'pen' || state.selectMode === 'marker') {
            st.pointerId = e.pointerId;
            try { drawCanvas.setPointerCapture(e.pointerId); } catch (err) { console.warn("Could not set pointer capture:", err); }
            const pos = getPos(e);
            st.drawing = true;
            st.path = [pos];
            const ctx = drawCanvas.getContext('2d');
            ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            ctx.strokeStyle = state.HIGHLIGHT_COLORS[state.selectedTag] || state.HIGHLIGHT_COLORS['기본'];
            ctx.lineWidth = state.currentThicknessPx;
            ctx.beginPath(); ctx.moveTo(pos.x, pos.y);
        } else if (state.selectMode === 'eraser') {
            st.pointerId = e.pointerId;
            try { drawCanvas.setPointerCapture(e.pointerId); } catch (err) { console.warn("Could not set pointer capture:", err); }
            st.startEraser = getPos(e);
        } else if (state.selectMode === 'ocrSelect') {
            st.pointerId = e.pointerId;
            try { drawCanvas.setPointerCapture(e.pointerId); } catch (err) { /* ... */ }
            st.startOcr = getPos(e);
            state.setOcrCurrentPage(p);
            removeOcrSelectionRect(); // (ocr.js)

            const rect = document.createElement('div');
            rect.className = 'ocr-selection-rect';
            Object.assign(rect.style, {
                left: `${st.startOcr.x}px`, top: `${st.startOcr.y}px`,
                width: '0px', height: '0px'
            });
            drawCanvas.parentNode.appendChild(rect);
            state.setOcrSelectionRect(rect);
        }
    });

    drawCanvas.addEventListener('pointermove', (e) => {
        if (!state.pdfDoc || st.pointerId !== e.pointerId) return;
        if (e.pointerType === 'mouse' && e.buttons !== 1) return;

        const ctx = drawCanvas.getContext('2d');    //[수정][12-09][마우스 움직였을 때 선을 계속 그리는 조건에 검정펜 추가]
        if ((state.selectMode === 'pen' || state.selectMode === 'marker') && st.drawing) {
            const pos = getPos(e);
            st.path.push(pos);
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();
        } else if (state.selectMode === 'ocrSelect' && st.startOcr && state.ocrSelectionRect) {
            const currentPos = getPos(e);
            const x = Math.min(st.startOcr.x, currentPos.x);
            const y = Math.min(st.startOcr.y, currentPos.y);
            const width = Math.abs(st.startOcr.x - currentPos.x);
            const height = Math.abs(st.startOcr.y - currentPos.y);
            Object.assign(state.ocrSelectionRect.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
        }
    });

    const handlePointerEnd = (e) => {
        if (st.pointerId !== e.pointerId) return;
        if (drawCanvas.isConnected) {
            try {
                if (drawCanvas.hasPointerCapture(e.pointerId)) {
                    drawCanvas.releasePointerCapture(e.pointerId);
                }
            } catch (err) {
                // console.warn("Could not release pointer capture:", err);
            }
        }                           //[수정][12-09][마우스 떼고 나서 저장하는 조건에 검정펜 추가]
        if (state.selectMode === 'pen' || state.selectMode === 'marker') finishStroke(p, st);
        else if (state.selectMode === 'eraser') finishEraser(p, st, getPos(e));
        else if (state.selectMode === 'ocrSelect' && st.startOcr) {
            const endPos = getPos(e);
            const startPos = st.startOcr;
            st.startOcr = null;
            if (Math.abs(startPos.x - endPos.x) < 5 || Math.abs(startPos.y - endPos.y) < 5) {
                removeOcrSelectionRect();
            } else {
                const rect = {
                    x: Math.min(startPos.x, endPos.x), y: Math.min(startPos.y, endPos.y),
                    width: Math.abs(startPos.x - endPos.x), height: Math.abs(startPos.y - endPos.y)
                };
                console.log(`OCR 영역 선택 완료 (페이지 ${state.ocrCurrentPage}):`, rect);
                extractAndRunOcr(state.ocrCurrentPage, rect); // (ocr.js)
            }
        }
        st.pointerId = null;
    };
    drawCanvas.addEventListener('pointerup', handlePointerEnd);
    drawCanvas.addEventListener('pointercancel', handlePointerEnd);
}

function finishStroke(p, st) {
    if (!st.drawing || !st.path || st.path.length < 2) { st.drawing = false; st.path = []; return; }
    st.drawing = false;
    const wrap = document.querySelector(`.page-wrap[data-page="${p}"]`);
    const draw = wrap?.querySelector('canvas.draw-layer');
    if (!draw) { st.path = []; return; }
    const w = parseFloat(draw.style.width), h = parseFloat(draw.style.height);
    if (!w || !h || isNaN(w) || isNaN(h)) { st.path = []; return; }

    const normPath = { points: st.path.map(pt => ({ x: pt.x / w, y: pt.y / h })) };
    const thicknessNorm = state.currentThicknessPx / h;
    const bb = utils.bboxOfPoints(st.path);
    const strokeRadius = state.currentThicknessPx * 0.6;
    const hitBox = { x0: Math.max(0, bb.x0 - strokeRadius), y0: Math.max(0, bb.y0 - strokeRadius), x1: Math.min(w, bb.x1 + strokeRadius), y1: Math.min(h, bb.y1 + strokeRadius) };
    const color = state.HIGHLIGHT_COLORS[state.selectedTag] || state.HIGHLIGHT_COLORS['기본'];

    if (state.pendingChunk && state.pendingChunk.page === p && state.pendingChunk.tag === state.selectedTag && utils.thicknessClose(state.pendingChunk.thicknessNorm, thicknessNorm, h)) {
        state.pendingChunk.paths.push(normPath);
        state.pendingChunk.bboxPx = utils.unionBox(state.pendingChunk.bboxPx, hitBox);
        clearTimeout(state.pendingChunk.timer);
        state.pendingChunk.timer = setTimeout(finalizePendingChunk, 1000);
    } else {
        if (state.pendingChunk) finalizePendingChunk();
        state.setPendingChunk({ page: p, tag: state.selectedTag, color, thicknessNorm, paths: [normPath], bboxPx: hitBox, timer: setTimeout(finalizePendingChunk, 1000) });
    }
    st.path = [];
}

function finishEraser(p, st, end) {
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
    
    state.highlights.filter(hh =>
        hh.page === p &&
        hh.id && !hh.id.startsWith('temp_') &&
        (hh.type === 'stroke' || hh.type === 'ocrBlock')
    ).forEach(hh => {
        let bb;
        if (hh.type === 'stroke') {
            bb = utils.bboxOfPathStyle(hh.paths, w, h, (hh.thicknessNorm || 0) * h);
        } else if (hh.type === 'ocrBlock' && hh.bbox) {
            bb = {
                x0: hh.bbox.x0 * w, y0: hh.bbox.y0 * h,
                x1: hh.bbox.x1 * w, y1: hh.bbox.y1 * h
            };
        } else {
            return;
        }

        if (utils.boxesIntersect(
            { x0: x0 / w, y0: y0 / h, x1: x1 / w, y1: y1 / h }, // Eraser norm rect
            { x0: bb.x0 / w, y0: bb.y0 / h, x1: bb.x1 / w, y1: bb.y1 / h }  // Highlight norm rect
        )) {
            toRemove.push(hh.id);
        }
    });

    if (toRemove.length) {
        removeHighlights(toRemove); // (highlight-manager.js)
        // TODO: Add undo command
    }
}

// ====== 펜 스트로크 합치기 ======
export function finalizePendingChunk() {
    if (!state.pendingChunk) return;
    const { page, tag, color, thicknessNorm, paths, bboxPx } = state.pendingChunk;
    const capturedText = utils.collectTextUnderBox(page, bboxPx);

    const highlightData = {
        page, type: 'stroke',
        paths,
        color, tag, thicknessNorm,
        text: capturedText, comment: ''
    };
    execAddHighlight(highlightData); // (highlight-manager.js)
    
    clearTimeout(state.pendingChunk.timer);
    state.setPendingChunk(null);
}
export function flushPendingIfAny() { finalizePendingChunk(); }


// ====== 하이라이트 다시 그리기 ======
export function redrawStrokesForPage(p) {
    const pagesCache = getPagesCache();
    const cache = pagesCache.get(p);
    if (!cache) return;
    const draw = cache.drawCanvas;
    const ctx = draw.getContext('2d');
    ctx.clearRect(0, 0, draw.width, draw.height);
    const w = draw.width, h = draw.height;
    if (!w || !h || w === 0 || h === 0) return;

    // 1. 펜 스트로크(stroke) 그리기
    const items = state.highlights.filter(hh => hh.page === p && hh.type === 'stroke');
    items.forEach(hh => {
        const strokeColor = hh.color || state.HIGHLIGHT_COLORS['기본'];
        const defaultThicknessNorm = 20 / h;
        const normThickness = (typeof hh.thicknessNorm === 'number' && !isNaN(hh.thicknessNorm)) ? hh.thicknessNorm : defaultThicknessNorm;
        const lineW = Math.max(2, normThickness * h);

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = strokeColor;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.lineWidth = lineW;

        const segments = Array.isArray(hh.paths) ? hh.paths.map(p => p.points) : (Array.isArray(hh.path) ? [hh.path] : []);

        ctx.beginPath();
        segments.forEach(seg => {
            if (!Array.isArray(seg)) return;
            const validPoints = seg.filter(pt => pt && typeof pt.x === 'number' && typeof pt.y === 'number' && !isNaN(pt.x) && !isNaN(pt.y));
            if (validPoints.length === 0) return;

            const path = validPoints.map(pt => ({ x: pt.x * w, y: pt.y * h }));
            if (path.length > 0) {
                ctx.moveTo(path[0].x, path[0].y);
                for (let i = 1; i < path.length; i++) {
                    ctx.lineTo(path[i].x, path[i].y);
                }
            }
        });
        if (!ctx.isPointInPath(0, 0)) {
            ctx.stroke();
        }
        ctx.restore();
    });

    // 2. OCR 블록(ocrBlock) 그리기
    const ocrBlocks = state.highlights.filter(hh => hh.page === p && hh.type === 'ocrBlock');
    ocrBlocks.forEach(hh => {
        if (!hh.bbox) return;

        const rect = {
            x: hh.bbox.x0 * w,
            y: hh.bbox.y0 * h,
            width: (hh.bbox.x1 - hh.bbox.x0) * w,
            height: (hh.bbox.y1 - hh.bbox.y0) * h
        };

        ctx.save();
        ctx.fillStyle = hh.color || state.HIGHLIGHT_COLORS['OCR'];
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        
        const borderColor = (hh.color || state.HIGHLIGHT_COLORS['OCR']).replace('0.35', '0.8');
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
        
        ctx.restore();
    });
}