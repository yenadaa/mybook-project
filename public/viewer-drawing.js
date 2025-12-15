import * as state from './viewer-state.js';
import * as utils from './viewer-utils.js';
import { execAddHighlight, removeHighlights } from './viewer-highlight-manager.js';
import { getPagesCache } from './viewer-renderer.js';
import { extractAndRunOcr, removeOcrSelectionRect } from './viewer-ocr.js';

const drawState = new Map();

export function initDrawLayer(p, drawCanvas) {
    const st = { 
        drawing: false, 
        path: [], 
        pointerId: null,
        // 지우개/OCR용
        startEraser: null, // startErasher 오타 수정
        startOcr: null,
        // [핵심 추가] 부드러운 곡선을 위한 좌표 저장소 (getCoalescedEvents용)
        points: [] 
    };
    drawState.set(p, st);
    const getPos = (e) => { 
        const rect = drawCanvas.getBoundingClientRect(); 
        return { 
            x: e.clientX - rect.left, 
            y: e.clientY - rect.top 
        }; 
    };
        // [헬퍼] 중간점 계산 (부드러운 곡선용)
    const getMidPoint = (p1, p2) => {
        return {
            x: p1.x + (p2.x - p1.x) / 2,
            y: p1.y + (p2.y - p1.y) / 2
        };
    };

    drawCanvas.addEventListener('pointerdown', (e) => {
        if (!state.pdfDoc) return;
        // [추가][12-14][손가락 터치로는 필기 시작 안 함 (펜/마우스만 허용)]
        if (e.pointerType === 'touch') return;
        // [수정][12-16]][이미 그리고 있는 중이면 다운 무시 (끊김 방지 핵심)]
        if (st.drawing || (st.pointerId !== null && st.pointerId !== e.pointerId)) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;

        st.pointerId = e.pointerId;
        try { drawCanvas.setPointerCapture(e.pointerId); } catch (err) {}
        //[추가][12-15]
        const pos = getPos(e);
                                        //[수정][12-09][검정펜 버튼 눌렀을 때 그리기]
        if (state.selectMode === 'pen' || state.selectMode === 'marker') {            
            st.drawing = true;
            st.path = [pos];// 곡선 계산용 점 배열 초기화
            st.lastPos = pos;// 데이터 저장용 전체 경로 초기화

            const ctx = drawCanvas.getContext('2d');
            ctx.lineCap = 'round'; 
            ctx.lineJoin = 'round';
            ctx.globalCompositeOperation = 'source-over';//[12-14][추가][(이전 모드 설정이 남아 펜이 이전 모드처럼 작동하는 오류 방지)]
            
            // [수정][12-11][모드에 따라 독립적인 색상/두께 상태 변수를 사용]
            if (state.selectMode === 'marker') {
                ctx.strokeStyle = state.MARKER_STROKE_COLOR;
                ctx.globalAlpha = 1.0; 
                ctx.lineWidth = state.markerCurrentThicknessPx; // [오타 수정][12-14]자유 필기 모드 전용 두께 사용
            } else {//형광펜 모드
                ctx.strokeStyle = state.HIGHLIGHT_COLORS[state.selectedTag] || state.HIGHLIGHT_COLORS['기본'];
                ctx.globalAlpha = 1.0; 
                ctx.lineWidth = state.currentThicknessPx; // 형광펜 전용 두께 사용(기존 방식)
            }
            // [핵심 수정] 무조건 경로를 새로 시작 (이전 획과 연결 방지)
            ctx.beginPath();

            // 점만 찍었을 때를 위해 점 그리기
            ctx.arc(pos.x, pos.y, ctx.lineWidth / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath(); // 다시 경로 열기
            ctx.moveTo(pos.x, pos.y);

        // --- B. 지우개 모드 ---
        } else if (state.selectMode === 'eraser') {
            st.startEraser = getPos(e);
        // --- C. OCR 모드 ---
        } else if (state.selectMode === 'ocrSelect') {
            st.startOcr = getPos(e);
            state.setOcrCurrentPage(p);
            removeOcrSelectionRect(); 
            const rect = document.createElement('div');
            rect.className = 'ocr-selection-rect';
            Object.assign(rect.style, { left: `${st.startOcr.x}px`, top: `${st.startOcr.y}px`, width: '0px', height: '0px' });
            drawCanvas.parentNode.appendChild(rect);
            state.setOcrSelectionRect(rect);
        }
    });
    // 2. Pointer Move (그리는 중)
    drawCanvas.addEventListener('pointermove', (e) => {
        if (!state.pdfDoc) return;//[추가][12-14]
        if (st.pointerId !== e.pointerId) return;

        // --- A. 펜/마커 그리기 ---
        if ((state.selectMode === 'pen' || state.selectMode === 'marker') && st.drawing) {
            const ctx = drawCanvas.getContext('2d');
  // [핵심] getCoalescedEvents: 브라우저가 화면 갱신 사이에 놓친 미세한 움직임까지 모두 가져옴
            const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];

            for (let ev of events) {
                const p2 = getPos(ev);
                st.points.push(p2);
                st.path.push(p2); // 저장용 데이터에도 추가

                // 점이 3개 이상 모이면 곡선 그리기 (Quadratic Curve)
                if (st.points.length >= 3) {
                    const lastTwo = st.points.slice(-2);
                    const p0 = st.points[st.points.length - 3];
                    const p1 = lastTwo[0];
                    // p1과 p2의 중간점 계산
                    const mid = getMidPoint(p0, p1);

                    // 곡선 그리기 (이전 중간점 ~ 현재 중간점)
                    // ctx.quadraticCurveTo(controlPoint.x, controlPoint.y, endPoint.x, endPoint.y)
                    // 여기서는 단순화하여 lineTo 대신 부드러운 연결을 시도
                    
                    // 하지만 성능과 반응성을 위해 단순히 lineTo를 촘촘하게 찍는 방식이 더 안정적일 수 있음.
                    // 위 영상의 오류(직선 연결)를 막기 위해 가장 확실한 방법은
                    // coalesced event를 순회하며 lineTo를 수행하는 것입니다.
                }
            }

            // [수정] 복잡한 곡선 알고리즘 대신 Coalesced Events를 이용한 촘촘한 lineTo 방식 적용
            // 이유: 곡선 알고리즘은 계산 비용 때문에 아주 빠른 필기에서 딜레이가 생길 수 있음.
            // Coalesced Events는 브라우저가 제공하는 실제 경로이므로 이것만 잘 이어도 매우 부드러움.
            
            // 루프 재실행 (위의 for문은 points 수집용, 그리기용으로 다시 순회)
            for (let ev of events) {
                const point = getPos(ev);
                ctx.lineTo(point.x, point.y);
                ctx.stroke();
                
                // [매우 중요] stroke 후 다시 beginPath/moveTo를 하지 않으면
                // 다음 프레임에서 거대한 다각형이 그려질 수 있음.
                // 캔버스 상태 유지를 위해 아래 패턴 사용:
                ctx.beginPath();
                ctx.moveTo(point.x, point.y);
            }

        // B. OCR 선택 박스
        } else if (state.selectMode === 'ocrSelect' && st.startOcr && state.ocrSelectionRect) {
            const currentPos = getPos(e);
            const x = Math.min(st.startOcr.x, currentPos.x);
            const y = Math.min(st.startOcr.y, currentPos.y);
            const width = Math.abs(st.startOcr.x - currentPos.x);
            const height = Math.abs(st.startOcr.y - currentPos.y);
            Object.assign(state.ocrSelectionRect.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
        }
    });

    // 3. Pointer Up / Cancel / LostCapture (종료)
    //[함수 전체 수정][12-15][선 이어짐 방지]
    const handlePointerEnd = (e) => {
        // [중요] pointerleave 이벤트 제거함 (선 끊김의 주원인)
        // 오직 우리가 시작한 포인터 ID일 때만 종료 처리
        if (st.pointerId !== e.pointerId) return;


        if (st.drawing) {
            // 마지막 점까지 처리
            const ctx = drawCanvas.getContext('2d');
            ctx.closePath(); // 경로 닫기 아님, 단순히 상태 종료 의미
            finishStroke(p, st);
        } else if (state.selectMode === 'eraser' && st.startEraser) {
            finishEraser(p, st, getPos(e));
        } else if (state.selectMode === 'ocrSelect' && st.startOcr) {
            // OCR 처리 로직
            const endPos = getPos(e);
            const startPos = st.startOcr;
            if (Math.abs(startPos.x - endPos.x) > 5 || Math.abs(startPos.y - endPos.y) > 5) {
                const rect = {
                    x: Math.min(startPos.x, endPos.x),
                    y: Math.min(startPos.y, endPos.y),
                    width: Math.abs(startPos.x - endPos.x),
                    height: Math.abs(startPos.y - endPos.y)
                };
                extractAndRunOcr(state.ocrCurrentPage, rect);
            } else {
                removeOcrSelectionRect();
            }
        }

        if (drawCanvas.hasPointerCapture(e.pointerId)) {
            try { drawCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
        }
        
        // 상태 완전 초기화
        st.drawing = false;
        st.path = [];
        st.points = [];
        st.startEraser = null;
        st.startOcr = null;
        st.pointerId = null;
    };
    drawCanvas.addEventListener('pointerup', handlePointerEnd);
    drawCanvas.addEventListener('pointercancel', handlePointerEnd);
    //[추가][12-14][선 이어짐 보강]
    drawCanvas.addEventListener('lostpointercapture', handlePointerEnd);

}

// [함수전체수정][12-15]스트로크 저장 로직
function finishStroke(p, st) {
        if (!st.path || st.path.length < 2) return;

    const wrap = document.querySelector(`.page-wrap[data-page="${p}"]`);
    const draw = wrap?.querySelector('canvas.draw-layer');
    if (!draw) return;
    
    const w = parseFloat(draw.style.width);
    const h = parseFloat(draw.style.height);
    if (!w || !h) return;
    // 데이터 저장용 경로 정규화
    const normPath = { points: st.path.map(pt => ({ x: pt.x / w, y: pt.y / h })) };
    
    // 모드에 따라 태그, 색상, 두께를 독립적으로 설정
    const isMarker = (state.selectMode === 'marker');
    
    // 1. 독립 변수 결정
   const strokeTag = isMarker ? state.MARKER_STROKE_TAG : state.selectedTag;
    const strokeColor = isMarker ? state.MARKER_STROKE_COLOR : (state.HIGHLIGHT_COLORS[state.selectedTag] || state.HIGHLIGHT_COLORS['기본']);
    const thicknessPx = isMarker ? state.markerCurrentThicknessPx : state.currentThicknessPx;//[변수 수정][12-14][독립 두께 사용]
    
    // 2. 텍스트 캡처 분리 (성능 및 로직 독립성)
    const bb = utils.bboxOfPoints(st.path);
    const capturedText = isMarker ? '' : utils.collectTextUnderBox(p, bb); // 마커일 경우 텍스트 캡처 건너뜀

    // 3. 정규화 및 히트박스 계산
    const thicknessNorm = thicknessPx / h;
    const strokeRadius = thicknessPx * 0.6;
    const hitBox = { x0: Math.max(0, bb.x0 - strokeRadius), y0: Math.max(0, bb.y0 - strokeRadius), x1: Math.min(w, bb.x1 + strokeRadius), y1: Math.min(h, bb.y1 + strokeRadius) };
    
    // 4. Pending Chunk 처리 로직
    // [수정] tag, thicknessNorm을 독립적으로 계산된 strokeTag, thicknessNorm로 대체
    if (state.pendingChunk && 
        state.pendingChunk.page === p && 
        state.pendingChunk.tag === strokeTag && // 독립 태그 비교
        utils.thicknessClose(state.pendingChunk.thicknessNorm, thicknessNorm, h)) 
    {
        state.pendingChunk.paths.push(normPath);
        state.pendingChunk.bboxPx = utils.unionBox(state.pendingChunk.bboxPx, hitBox);
        clearTimeout(state.pendingChunk.timer);
        state.pendingChunk.timer = setTimeout(finalizePendingChunk, 1000);
        // 텍스트는 첫 스트로크 기준으로 유지 (마커는 빈 문자열 유지)
        if (!state.pendingChunk.text) state.pendingChunk.text = capturedText; 
    } else {
        if (state.pendingChunk) finalizePendingChunk();
        // [수정] 모든 변수(tag, color, thicknessNorm, text)에 독립적인 값 사용
        state.setPendingChunk({ 
            page: p, 
            tag: strokeTag, 
            color: strokeColor, 
            thicknessNorm, 
            paths: [normPath], 
            bboxPx: hitBox, 
            timer: setTimeout(finalizePendingChunk, 1000),
            text: capturedText 
        });
    }
}
//[함수전체수정][12-15]
function finishEraser(p, st, end) {
    if (!st.startEraser) return;
    const start = st.startEraser; 
     // 너무 작은 움직임은 무시 (클릭 실수 방지)
    if (Math.abs(end.x - start.x) < 2 && Math.abs(end.y - start.y) < 2) return;
    
    const wrap = document.querySelector(`.page-wrap[data-page="${p}"]`);
    const draw = wrap?.querySelector('canvas.draw-layer');
    if (!draw) return;
    const w = parseFloat(draw.style.width), h = parseFloat(draw.style.height);

    const x0 = Math.min(start.x, end.x), y0 = Math.min(start.y, end.y), 
          x1 = Math.max(start.x, end.x), y1 = Math.max(start.y, end.y);
          
    finalizePendingChunk(); 
    const toRemove = [];
    
    // 지우개 타겟팅 (형광펜만, 펜만, 둘다)
    state.highlights.filter(hh =>
        hh.page === p &&
        hh.id && !hh.id.startsWith('temp_') &&
        (hh.type === 'stroke' || hh.type === 'ocrBlock') &&
        // [수정][12-14][지우개 기능별로 분리 혹시 모를 전체 지우개도 남겨놓음 아직은 안 씀]
        (
            state.eraserTarget === 'both' ||
            (state.eraserTarget === 'pen' && hh.tag !== state.MARKER_STROKE_TAG) ||
            (state.eraserTarget === 'marker' && hh.tag === state.MARKER_STROKE_TAG)
        )
    ).forEach(hh => {
        let bb;
        if (hh.type === 'stroke') {
            // [조건문 추가][12-14][Marker 여부 확인 (hh.tag가 MARKER_STROKE_TAG 인지 확인)]
            const isMarker = (hh.tag === state.MARKER_STROKE_TAG);
            let thicknessPx;
            if (isMarker) {
                // 마커일 경우 저장된 norm 값 또는 Marker 독립 두께를 fallback으로 사용
                thicknessPx = Math.round((hh.thicknessNorm || (state.MARKER_DEFAULT_THICKNESS_PX / h)) * h);
            } else {
                // 형광펜일 경우 저장된 norm 값 또는 형광펜 두께를 fallback으로 사용
                thicknessPx = Math.round((hh.thicknessNorm || (state.currentThicknessPx / h)) * h);
            }
            //[수정][12-14][bb 계산 시 위에서 구한 thicknessPx 사용]
            bb = utils.bboxOfPathStyle(hh.paths, w, h, thicknessPx);
        } else if (hh.type === 'ocrBlock' && hh.bbox) {
            bb = {
                x0: hh.bbox.x0 * w, y0: hh.bbox.y0 * h, x1: hh.bbox.x1 * w, y1: hh.bbox.y1 * h };
        } else {return;}

        if (utils.boxesIntersect(
            { x0: x0 / w, y0: y0 / h, x1: x1 / w, y1: y1 / h },// Eraser norm rect
            { x0: bb.x0 / w, y0: bb.y0 / h, x1: bb.x1 / w, y1: bb.y1 / h } // Highlight norm rect
        )) {
            toRemove.push(hh.id);
        }
    });

    if (toRemove.length) {
        removeHighlights(toRemove); // (highlight-manager.js)
        state.addCommand({ action: 'remove', payload: { ids: toRemove } });
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


// ====== 하이라이트 다시 그리기 ======[중요] 저장된 스트로크 다시 그리기 (여기도 선 이어짐 방지 로직 적용)
export function redrawStrokesForPage(p) {
    const pagesCache = getPagesCache();
    const cache = pagesCache.get(p);
    if (!cache) return;
    const draw = cache.drawCanvas;
    const ctx = draw.getContext('2d');

    // 캔버스 초기화
    ctx.clearRect(0, 0, draw.width, draw.height);
    const w = draw.width, h = draw.height;
    if (!w || !h) return;

    // 1. 펜 스트로크(stroke) 그리기
    const items = state.highlights.filter(hh => hh.page === p && hh.type === 'stroke');
    items.forEach(hh => {
        //[수정][12-11][마커 태그일 경우 독립된 색상 및 두께 사용]
        const isMarker = (hh.tag === state.MARKER_STROKE_TAG);
        const strokeColor = isMarker ? state.MARKER_STROKE_COLOR : (hh.color || state.HIGHLIGHT_COLORS['기본']);
        //[수정][12-11][두께가 없거나 자유 필기 모드일 경우 자유 필기 전용 두께를 사용하도록 fallback 설정]
        const defaultThicknessNorm = state.MARKER_DEFAULT_THICKNESS_PX / h;

        const normThickness = (typeof hh.thicknessNorm === 'number') ? hh.thicknessNorm : defaultThicknessNorm;
        
        const lineW = Math.max(2, normThickness * h);

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = strokeColor;
        ctx.lineCap = 'round'; 
        ctx.lineJoin = 'round';
        ctx.lineWidth = lineW;
        
        // [추가][12-11][마커 태그일 경우 불투명도를 1.0으로 설정]
        if (isMarker || !strokeColor.startsWith('rgba')) {
            ctx.globalAlpha = 1.0;
        } else {
            ctx.globalAlpha = 1.0; 
        }

        // [핵심] 저장된 경로 그리기 (segments 분리)
        // hh.paths는 [[{x,y}, {x,y}], [{x,y}...]] 형태의 배열의 배열임
        const segments = Array.isArray(hh.paths) ? hh.paths.map(p => p.points) : (Array.isArray(hh.path) ? [hh.path] : []);

        ctx.beginPath();
        segments.forEach(seg => {
            if (!Array.isArray(seg)) return;
            const validPoints = seg.filter(pt => pt && typeof pt.x === 'number' && typeof pt.y === 'number');
            if (validPoints.length === 0) return;

            // 각 세그먼트(획)마다 moveTo로 새로 시작해야 선이 엉뚱하게 이어지지 않음
            const path = validPoints.map(pt => ({ x: pt.x * w, y: pt.y * h }));
            if (path.length > 0) {
                ctx.moveTo(path[0].x, path[0].y);// 획의 시작점
                for (let i = 1; i < path.length; i++) {
                    ctx.lineTo(path[i].x, path[i].y);
                }
            }
        });
        // path에 내용이 있을 때만 stroke
        ctx.stroke();
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
        ctx.strokeStyle = (hh.color || state.HIGHLIGHT_COLORS['OCR']).replace('0.35', '0.8');
        ctx.lineWidth = 1;
        ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
        ctx.restore();
    });
}