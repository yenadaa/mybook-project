import * as state from './viewer-state.js';
import { initDrawLayer, redrawStrokesForPage } from './viewer-drawing.js';
import { renderNotes } from './viewer-ui.js';

// 렌더링된 페이지 캐시
const pagesCache = new Map();
export function getPagesCache() { return pagesCache; }

// ====== PDF 렌더링 ======

// window 전역에 등록 (firebaseLoader.js에서 호출)
export async function renderDocument(arrayBuffer) {
    clearViewer();
    state.setHighlights([]);
    state.setUndoStack([]);
    state.setRedoStack([]);
    state.updateButtons();

    let doc;
    try {
        doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        state.setPdfDoc(doc);
    } catch (error) {
        console.error("Error loading PDF document:", error);
        if (state.els.empty) state.els.empty.textContent = `PDF 로딩 오류: ${error.message}`;
        if (state.els.pages) state.els.pages.style.display = 'none';
        if (state.els.empty) state.els.empty.style.display = 'grid';
        return;
    }

    if (state.els.empty) state.els.empty.style.display = 'none';
    if (state.els.pages) state.els.pages.style.display = 'grid';
    state.setCurrentPage(1);
    state.setScale(1.0);
    state.setContinuousMode(true);
    updateToolbar(); // (ui.js로 이동 고려)

    state.setSearchIndex(new Array(doc.numPages));
    if (state.els.thumbs) state.els.thumbs.innerHTML = '';
    
    for (let p = 1; p <= doc.numPages; p++) {
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
        if (state.els.pages) state.els.pages.appendChild(wrap);

        if (state.els.thumbs) {
            const thumbWrap = document.createElement('div');
            thumbWrap.className = 'thumb';
            thumbWrap.dataset.page = String(p);
            thumbWrap.addEventListener('click', () => scrollToPage(p));
            state.els.thumbs.appendChild(thumbWrap);
        }
    }
    
    const renderPromises = [];
    for (let p = 1; p <= doc.numPages; p++) {
        const wrap = document.querySelector(`.page-wrap[data-page="${p}"]`);
        const drawCanvas = wrap?.querySelector('canvas.draw-layer');
        if (drawCanvas) {
            initDrawLayer(p, drawCanvas); // (drawing.js)
        }
        renderPromises.push(renderPage(p));
        renderPromises.push(renderThumb(p));
    }
    renderOutline();
    renderBookmarks();
    renderNotes(); // (ui.js)

    const viewerElement = document.querySelector('.viewer');
    state.els.pages?.addEventListener('scroll', onScrollUpdatePage, { passive: true });
    viewerElement?.addEventListener('scroll', onScrollUpdatePage, { passive: true });

    console.log("PDF 렌더링 완료. Firestore 하이라이트 대기 중...");
}

export async function renderPage(p) {
    if (!state.pdfDoc) return;
    let page;
    try {
        page = await state.pdfDoc.getPage(p);
    } catch (error) {
        console.error(`Error getting page ${p}:`, error);
        return;
    }
    const desiredScale = state.scale * (state.continuousMode ? 1.0 : 1.2);
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

    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    try {
        await page.render({ canvasContext: ctx, viewport }).promise;
    } catch (renderError) {
        console.error(`Error rendering page ${p} canvas:`, renderError);
    }

    textLayerDiv.style.width = `${viewport.width}px`;
    textLayerDiv.style.height = `${viewport.height}px`;
    textLayerDiv.innerHTML = '';
    try {
        const textContent = await page.getTextContent();
        await pdfjsLib.renderTextLayer({
            textContentSource: textContent,
            container: textLayerDiv,
            viewport,
            textDivs: [],
        }).promise;
    } catch (textLayerError) {
        console.error(`Error rendering page ${p} text layer:`, textLayerError);
    }

    drawCanvas.width = viewport.width;
    drawCanvas.height = viewport.height;
    drawCanvas.style.width = `${viewport.width}px`;
    drawCanvas.style.height = `${viewport.height}px`;
    redrawStrokesForPage(p); // (drawing.js)

    pagesCache.set(p, { canvas, textLayer: textLayerDiv, drawCanvas });

    if (!state.searchIndex[p - 1]) {
        try {
            const textContentForIndex = await page.getTextContent();
            const fullText = textContentForIndex.items.map(item => item.str).join('');
            state.searchIndex[p - 1] = { page: p, textLower: fullText.toLowerCase() };
        } catch (getTextError) {
            console.error(`Error getting text content for page ${p} index:`, getTextError);
            state.searchIndex[p - 1] = { page: p, textLower: '' };
        }
    }
}

export async function renderThumb(p) {
    const wrap = document.querySelector(`#thumbs .thumb[data-page="${p}"]`);
    if (!wrap || !state.pdfDoc) return;

    try {
        const page = await state.pdfDoc.getPage(p);
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

        wrap.innerHTML = '';
        wrap.appendChild(canvas);
    } catch (error) {
        console.error(`Error rendering thumbnail for page ${p}:`, error);
    }
}

export async function renderOutline() {
    if (!state.els.outline || !state.pdfDoc) return;
    try {
        const outline = await state.pdfDoc.getOutline();
        state.els.outline.innerHTML = '';
        if (!outline) return;

        const buildOutline = (items, depth = 0) => {
            items.forEach(item => {
                const li = document.createElement('li');
                li.style.paddingLeft = `${depth * 14}px`;
                li.textContent = item.title || '(제목 없음)';
                li.addEventListener('click', async () => {
                    if (item.dest && typeof item.dest === 'string') {
                        try {
                            const dest = await state.pdfDoc.getDestination(item.dest);
                            if (dest && dest[0]) {
                                const pageIndex = await state.pdfDoc.getPageIndex(dest[0]);
                                scrollToPage(pageIndex + 1);
                            } else {
                                console.warn("Invalid destination object:", dest);
                            }
                        } catch (destError) {
                            console.error("Error getting destination:", destError);
                        }
                    } else if (item.url) {
                        window.open(item.url, '_blank', 'noopener,noreferrer');
                    }
                });
                state.els.outline.appendChild(li);
                if (item.items && item.items.length > 0) {
                    buildOutline(item.items, depth + 1);
                }
            });
        };
        buildOutline(outline);
    } catch (error) {
        console.error("Error rendering outline:", error);
    }
}

export function renderBookmarks() {
    if (!state.els.bookmarks) return;
    state.els.bookmarks.innerHTML = '';
    state.bookmarks.forEach((b, idx) => {
        const li = document.createElement('li');
        li.textContent = `p.${b.page} — ${b.label || '북마크'}`;
        li.title = new Date(b.time).toLocaleString();
        li.addEventListener('click', () => scrollToPage(b.page));
        const del = document.createElement('button');
        del.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        del.style.cssText = 'float:right; border:none; background:none; cursor:pointer;';
        del.addEventListener('click', (e) => { e.stopPropagation(); state.bookmarks.splice(idx, 1); renderBookmarks(); state.saveLocal(); });
        li.appendChild(del);
        state.els.bookmarks.appendChild(li);
    });
}

// ====== 뷰어 제어 함수 ======

export function updateToolbar() {
    if (state.els.pageIndicator) state.els.pageIndicator.textContent = state.pdfDoc ? `p. ${state.currentPage} / ${state.pdfDoc.numPages}` : 'p. - / -';
    if (state.els.zoomLabel) state.els.zoomLabel.textContent = Math.round(state.scale * 100) + '%';
}

// [전체 수정][11-29][수동 스크롤 시 호출되는 함수] (인디케이터 업데이트)
export function onScrollUpdatePage() {
    const viewerEl = document.querySelector('.viewer'); 
    if (!state.pdfDoc || !state.continuousMode || !viewerEl) return;
    
    const scrollTop = viewerEl.scrollTop;
    const viewerHeight = viewerEl.clientHeight;
    const thresholdPosition = scrollTop + (viewerHeight * 0.33); // 뷰어 상단 1/3 지점

    let mostVisiblePage = state.currentPage;
    const pageWraps = document.querySelectorAll('.page-wrap'); 

    for (const wrap of pageWraps) {
        const pageNum = parseInt(wrap.dataset.page, 10);
        if (isNaN(pageNum)) continue;

        const pageTopRelativeToViewer = wrap.offsetTop; 
        
        if (pageTopRelativeToViewer > thresholdPosition) {
            mostVisiblePage = Math.max(1, pageNum - 1); 
            break;
        }
        mostVisiblePage = pageNum;
    }
    
    if (state.currentPage !== mostVisiblePage) {
        state.setCurrentPage(mostVisiblePage);
        updateToolbar();
    }
}

export function clearViewer() {
    if (state.els.pages) state.els.pages.innerHTML = '';
    if (state.els.thumbs) state.els.thumbs.innerHTML = '';
    if (state.els.outline) state.els.outline.innerHTML = '';
    if (state.els.bookmarks) state.els.bookmarks.innerHTML = '';
    pagesCache.clear();
}

//[함수 전체 수정][11-25]
export function scrollToPage(p) {
    const el = document.querySelector(`.page-wrap[data-page="${p}"]`);
    const viewer = document.querySelector('.viewer');
    if (el && viewer) { 
        state.setCurrentPage(p); 
        updateToolbar();         
        
        //scrollIntoView 대신 scrollTop을 직접 계산하여 이동
        const targetTop = el.offsetTop - 10; //페이지 래퍼의 상단 위치 (약간의 여백 -10px)
        
        //viewer의 스크롤 위치를 직접 조작
        viewer.scrollTop = targetTop;
        
        // 부드러운 스크롤
        viewer.scrollTo({ top: targetTop, behavior: 'smooth' }); 
    }
}

export async function rerenderAll() {
    if (!state.pdfDoc) return;
    const renderPromises = [];
    for (let p = 1; p <= state.pdfDoc.numPages; p++) {
        renderPromises.push(renderPage(p));
    }
    await Promise.all(renderPromises);
    updateToolbar();
}

// 문서 닫기 (doc.js에서 호출 가능)
export function clearDocument() {
    state.setPdfDoc(null);
    state.setHighlights([]);
    state.setUndoStack([]);
    state.setRedoStack([]);
    pagesCache.clear();
    state.setSearchIndex([]);
    // ocrData와 bookmarks는 로컬 스토리지 기반이므로 유지
    
    clearViewer();
    if (state.els.empty) state.els.empty.style.display = 'grid';
    if (state.els.pages) state.els.pages.style.display = 'none';
    state.setCurrentPage(1);
    state.setScale(1.0);
    updateToolbar();
    renderNotes();
    renderBookmarks();
    console.log("문서 닫힘.");
    state.updateButtons();
}