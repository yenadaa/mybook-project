import { ocrData } from './viewer-state.js'; // collectTextUnderBox용

export function unionBox(a, b) { return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }; }
export function thicknessClose(tnA, tnB, h) { const pxA = (tnA || 0) * h, pxB = (tnB || 0) * h; return Math.abs(pxA - pxB) <= 2; }
export function rectsOverlapPx(a, b) { return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0; }
export function boxesIntersect(a, b) { return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0; }
export function escapeCsv(s) { const t = String(s ?? '').replaceAll('"', '""'); return `"${t}"`; }

export function bboxOfPoints(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach(p => { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
    return { x0, y0, x1, y1 };
}

export function bboxOfPathStyle(pathOrPaths, w, h, thicknessPx) {
    const r = (thicknessPx || 20) * 0.6;
    let points = [];
    const processSegment = seg => {
        if (Array.isArray(seg)) {
            seg.forEach(pt => {
                if (pt && typeof pt.x === 'number' && typeof pt.y === 'number' && !isNaN(pt.x) && !isNaN(pt.y)) {
                    points.push({ x: pt.x * w, y: pt.y * h });
                }
            });
        }
    };

    if (Array.isArray(pathOrPaths)) {
        if (pathOrPaths.length > 0 && pathOrPaths[0] && typeof pathOrPaths[0] === 'object' && Array.isArray(pathOrPaths[0].points)) {
            pathOrPaths.forEach(p => processSegment(p.points));
        }
        else if (pathOrPaths.length > 0 && pathOrPaths[0] && typeof pathOrPaths[0].x === 'number') {
            processSegment(pathOrPaths);
        }
    }
    if (!points.length) return { x0: 0, y0: 0, x1: 0, y1: 0 };
    const bb = bboxOfPoints(points);
    return { x0: Math.max(0, bb.x0 - r), y0: Math.max(0, bb.y0 - r), x1: Math.min(w, bb.x1 + r), y1: Math.min(h, bb.y1 + r) };
}

export function collectTextUnderBox(pageNumber, boxStylePx) {
    const wrap = document.querySelector(`.page-wrap[data-page="${pageNumber}"]`);
    if (!wrap) return '';
    const textLayer = wrap.querySelector('.textLayer');
    if (!textLayer) return '';
    const base = wrap.getBoundingClientRect();
    const items = [];

    // 1) TextLayer spans
    const spans = Array.from(textLayer.querySelectorAll('span'));
    spans.forEach(s => {
        const r = s.getBoundingClientRect();
        const rect = { x0: r.left - base.left, y0: r.top - base.top, x1: r.right - base.left, y1: r.bottom - base.top };
        if (rect.x1 > rect.x0 && rect.y1 > rect.y0 && rectsOverlapPx(boxStylePx, rect)) {
            const t = (s.textContent || '').trim();
            if (t) items.push({ t, top: rect.y0, left: rect.x0 });
        }
    });

    // 2) OCR words
    const pageOcrData = ocrData[pageNumber];
    if (pageOcrData && pageOcrData.words && pageOcrData.words.length) {
        const renderCanvas = wrap.querySelector('canvas.page');
        if (!renderCanvas) return items.map(i => i.t).join(' ').replace(/\s+/g, ' ').trim();

        const styleWStr = renderCanvas.style.width;
        const styleHStr = renderCanvas.style.height;
        if (!styleWStr || !styleHStr) return items.map(i => i.t).join(' ').replace(/\s+/g, ' ').trim();

        const styleW = parseFloat(styleWStr);
        const styleH = parseFloat(styleHStr);
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

    items.sort((a, b) => Math.abs(a.top - b.top) < 5 ? a.left - b.left : a.top - b.top);
    
    let finalText = '';
    let lastTop = -Infinity;
    items.forEach(item => {
        if (item.top > lastTop + 10) {
            finalText += '\n';
        } else {
            finalText += ' ';
        }
        finalText += item.t;
        lastTop = item.top;
    });

    return finalText.replace(/\s+/g, ' ').trim();
}