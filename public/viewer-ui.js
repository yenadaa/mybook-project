import * as state from './viewer-state.js';
import * as renderer from './viewer-renderer.js';
import * as drawing from './viewer-drawing.js';
import * as ocr from './viewer-ocr.js';
import * as search from './viewer-search.js';
import * as highlights from './viewer-highlight-manager.js';
import * as utils from './viewer-utils.js';
//[추가][11-29][페이지 인디케이터 ui 업데이트]
export function updateToolbar() {
    const indicatorEl = document.getElementById('pageIndicator'); 
    
    if (indicatorEl && state.pdfDoc) {
        const totalPages = state.pdfDoc.numPages;
        const currentPage = state.currentPage;
        indicatorEl.textContent = `p. ${currentPage} / ${totalPages}`;
    } else if (indicatorEl) {
        indicatorEl.textContent = 'p. - / -';
    }
}

// [추가][11-24][알림 메시지를 화면에 잠시 보여주는 함수]
let alertTimeout;
export function showTemporaryAlert(msg) {
    // 기존 알림이 있으면 제거
    const old = document.getElementById('temp-alert');
    if (old) old.remove();
    clearTimeout(alertTimeout);

    // 새 알림 생성
    const div = document.createElement('div');
    div.id = 'temp-alert';
    div.textContent = msg;
    div.style.cssText = `
        position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
        background: rgba(0,0,0,0.8); color: white; padding: 10px 20px;
        border-radius: 20px; font-size: 14px; z-index: 9999;
        box-shadow: 0 2px 10px rgba(0,0,0,0.2); transition: opacity 0.3s;
    `;
    document.body.appendChild(div);

    // 2초 뒤 제거
    alertTimeout = setTimeout(() => {
        div.style.opacity = '0';
        setTimeout(() => div.remove(), 300);
    }, 2000);
}

// ====== Micro-interactions: ripple ======
function attachRipplesTo(selector) {
    document.querySelectorAll(selector).forEach(btn => {
        if (btn.__hasRipple) return; btn.__hasRipple = true;
        btn.style.position = btn.style.position || 'relative';
        btn.style.overflow = btn.style.overflow || 'hidden';
        btn.addEventListener('click', function (e) {
            const r = this.getBoundingClientRect();
            const d = Math.max(r.width, r.height);
            const s = document.createElement('span');
            s.className = 'ripple';
            Object.assign(s.style, {
                width: d + 'px', height: d + 'px',
                left: (e.clientX - r.left - d / 2) + 'px',
                top: (e.clientY - r.top - d / 2) + 'px',
                position: 'absolute', borderRadius: '999px',
                transform: 'scale(0)', opacity: '.16',
                background: 'currentColor',
                animation: 'ripple-soft .7s cubic-bezier(.25,.1,.25,1) forwards'
            });
            this.appendChild(s);
            s.addEventListener('animationend', () => s.remove());
        }, { passive: true });
    });
}

// ====== Notes Panel ======
function noteFilterActive() {
    const btn = document.querySelector('.right-tabs button.active');
    return btn ? btn.dataset.filter : 'all';
}

export function renderNotes() {
    if (!state.els.notes) return;
    const filter = noteFilterActive();
    state.els.notes.innerHTML = '';
    
    const items = state.highlights.filter(h => !h.id.startsWith('temp_') && (filter === 'all' || h.tag === filter));
    if (!items.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '하이라이트가 없습니다'; state.els.notes.appendChild(empty); return; }

    items.sort((a, b) => a.page - b.page);

    items.forEach(h => {
        if (!h.id) return;

        const div = document.createElement('div');
        div.className = 'note';
        div.dataset.id = String(h.id);
        const left = document.createElement('div');
        const topRow = document.createElement('div');
        topRow.innerHTML = `<span class="meta">p.${h.page}</span> · <span class="tag">${h.tag || '기본'}</span>`;
        const text = document.createElement('div');
        text.textContent = (h.text && h.text.trim()) ? h.text : '(형광펜 스트로크)';
        text.style.cursor = 'pointer';
        text.addEventListener('click', () => renderer.scrollToPage(h.page));
        const textarea = document.createElement('textarea');
        textarea.placeholder = '댓글 입력...';
        textarea.value = h.comment || '';
        
        let debounceTimer;
        textarea.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                highlights.setHighlightComment(h.id, textarea.value);
            }, 500);
        });
        left.appendChild(topRow); left.appendChild(text); left.appendChild(textarea);

        const right = document.createElement('div');
        const del = document.createElement('button'); del.title = '삭제'; del.innerHTML = '<i class="fa-regular fa-trash-can"></i>';
        del.addEventListener('click', () => {
            const removed = highlights.removeHighlights([h.id]);
            state.addCommand({ action: 'remove', payload: { ids: [h.id], removed } });
        });
        const cycle = document.createElement('button'); cycle.title = '태그 변경'; cycle.innerHTML = '<i class="fa-solid fa-tag"></i>';
        cycle.addEventListener('click', () => {
            const order = ['기본', '중요', '암기', '참고'];
            const cur = h.tag || '기본';
            const next = order[(order.indexOf(cur) + 1) % order.length];
            const originalTag = highlights.setHighlightTag(h.id, next);
            state.addCommand({ action: 'setTag', payload: { id: h.id, prev: originalTag, next } });
        });
        right.appendChild(cycle); right.appendChild(del);

        div.appendChild(left); div.appendChild(right);
        state.els.notes.appendChild(div);
    });
}

// ====== Sidebar ======
export function switchSidebar(contentId) {
    const container = document.getElementById('sidebarContent');
    if (!container) return;
    const panels = container.children;
    for (let i = 0; i < panels.length; i++) {
        const panel = panels[i];
        if (panel.style) {
            panel.style.display = 'none';
        }
    }
    const targetPanel = document.getElementById(contentId);
    if (targetPanel) {
        targetPanel.style.display = (targetPanel.tagName === 'UL') ? 'block' : 'block';
    }
}


// ====== Event Listeners Setup ======
document.addEventListener('DOMContentLoaded', () => {
    
    attachRipplesTo('button, .chip-btn, .label-btn, .right-tabs button, .sidebar-tabs button');

    // Init UI for thickness
    if (state.els.thickness) state.els.thickness.value = String(state.currentThicknessPx);
    if (state.els.thicknessLabel) state.els.thicknessLabel.textContent = `${state.currentThicknessPx} px`;
    
    // 로컬 데이터 로드 (북마크, OCR)
    state.loadLocal();
    renderer.renderBookmarks(); // 로드 후 북마크 렌더링

    console.log("Adding event listeners after DOMContentLoaded...");

    state.els.prevPage?.addEventListener('click', () => { if (!state.pdfDoc) return; state.setCurrentPage(Math.max(1, state.currentPage - 1)); renderer.scrollToPage(state.currentPage); });
    state.els.nextPage?.addEventListener('click', () => { if (!state.pdfDoc) return; state.setCurrentPage(Math.min(state.pdfDoc.numPages, state.currentPage + 1)); renderer.scrollToPage(state.currentPage); });
    state.els.jumpInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && state.pdfDoc && state.els.jumpInput) { const pVal = parseInt(state.els.jumpInput.value, 10); if (!isNaN(pVal)) { const p = Math.max(1, Math.min(state.pdfDoc.numPages, pVal)); renderer.scrollToPage(p); } state.els.jumpInput.value = ''; } });
    
    const rerenderWithChunkFlush = () => {
        if (!state.pdfDoc) return;
        drawing.flushPendingIfAny();
        renderer.rerenderAll();
    };
    state.els.zoomIn?.addEventListener('click', () => { state.setScale(Math.min(3, state.scale + 0.1)); rerenderWithChunkFlush(); });
    state.els.zoomOut?.addEventListener('click', () => { state.setScale(Math.max(0.3, state.scale - 0.1)); rerenderWithChunkFlush(); });
    state.els.zoomReset?.addEventListener('click', () => { state.setScale(1.0); rerenderWithChunkFlush(); });
    
    state.els.toggleDark?.addEventListener('click', () => { document.body.classList.toggle('dark'); });
    state.els.modeContinuous?.addEventListener('click', () => { if (state.continuousMode) return; state.setContinuousMode(true); state.els.modeContinuous?.classList.add('active'); state.els.modeSingle?.classList.remove('active'); rerenderWithChunkFlush(); });
    state.els.modeSingle?.addEventListener('click', () => { if (!state.continuousMode) return; state.setContinuousMode(false); state.els.modeSingle?.classList.add('active'); state.els.modeContinuous?.classList.remove('active'); rerenderWithChunkFlush(); });

    // --- Local Undo/Redo Logic ---
    state.els.undoBtn?.addEventListener('click', () => {
        drawing.flushPendingIfAny();
        const cmd = state.undoStack.pop();
        if (!cmd) { console.log("Undo stack empty"); return; }
        console.log("Attempting local undo:", cmd.action, cmd.payload);

        let redoData = null;
        switch (cmd.action) {
            case 'add':
                redoData = highlights.undoAddHighlight(cmd.payload.id); // temp ID
                break;
            case 'remove':
                if (cmd.payload.removed && cmd.payload.removed.length > 0) {
                    highlights.reAddHighlightsLocally(cmd.payload.removed); // 로컬 복원
                    redoData = cmd.payload.ids; // Redo용 ID
                }
                break;
            case 'setTag':
                redoData = highlights.setHighlightTag(cmd.payload.id, cmd.payload.prev);
                break;
            case 'comment':
                redoData = highlights.setHighlightComment(cmd.payload.id, cmd.payload.prev);
                break;
            default:
                console.warn("Unknown undo command:", cmd.action);
        }

        if (redoData !== null) {
            cmd.redoPayload = redoData;
            state.redoStack.push(cmd);
        }
        state.updateButtons();
    });

    state.els.redoBtn?.addEventListener('click', () => {
        drawing.flushPendingIfAny();
        const cmd = state.redoStack.pop();
        if (!cmd) { console.log("Redo stack empty"); return; }
        console.log("Attempting local redo:", cmd.action, cmd.payload);

        switch (cmd.action) {
            case 'add':
                if (cmd.payload.originalData) {
                    highlights.reAddHighlightsLocally([cmd.payload.originalData]);
                } else { console.warn("Cannot redo add: original data missing"); }
                break;
            case 'remove':
                if (cmd.redoPayload && cmd.redoPayload.length > 0) {
                    highlights.removeHighlightsLocally(cmd.redoPayload); // 로컬 삭제
                }
                break;
            case 'setTag':
                if (cmd.payload.next) {
                    highlights.setHighlightTag(cmd.payload.id, cmd.payload.next);
                }
                break;
            case 'comment':
                if (cmd.payload.next) {
                    highlights.setHighlightComment(cmd.payload.id, cmd.payload.next);
                }
                break;
            default:
                console.warn("Unknown redo command:", cmd.action);
        }

        state.undoStack.push(cmd);
        state.updateButtons();
    });
    // --- End Local Undo/Redo ---

    state.els.penBtn?.addEventListener('click', () => { drawing.flushPendingIfAny(); state.setMode(state.selectMode === 'pen' ? 'none' : 'pen'); });
    state.els.eraserBtn?.addEventListener('click', () => { drawing.flushPendingIfAny(); state.setMode(state.selectMode === 'eraser' ? 'none' : 'eraser'); });
    state.els.ocrSelectBtn?.addEventListener('click', () => { state.setMode(state.selectMode === 'ocrSelect' ? 'none' : 'ocrSelect'); });

    state.els.tagBtns?.forEach(btn => btn.addEventListener('click', (e) => {
        drawing.flushPendingIfAny();
        state.setSelectedTag(e.target.dataset.tag || '기본');
        state.setMode('pen');
        state.els.tagBtns.forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
    }));
    state.els.thickness?.addEventListener('input', () => {
        state.setCurrentThicknessPx(Number(state.els.thickness.value));
        if (state.els.thicknessLabel) state.els.thicknessLabel.textContent = `${state.currentThicknessPx} px`;
        localStorage.setItem('pdfViewer.penThicknessPx', String(state.currentThicknessPx));
    });

    state.els.searchPrev?.addEventListener('click', () => search.moveSearchCursor(-1));
    state.els.searchNext?.addEventListener('click', () => search.moveSearchCursor(1));
    state.els.searchInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') search.performSearch(); });

    document.querySelectorAll('.sidebar .sidebar-tabs button').forEach(b => {
        b.addEventListener('click', (e) => {
            document.querySelectorAll('.sidebar .sidebar-tabs button').forEach(btn => btn.classList.remove('active'));
            const clickedButton = e.target.closest('button');
            if (!clickedButton) return;
            clickedButton.classList.add('active');
            let contentToShow = 'thumbs';
            if (clickedButton.id === 'tabOutline') contentToShow = 'outline';
            else if (clickedButton.id === 'tabBookmarks') contentToShow = 'bookmarks';
            else if (clickedButton.id === 'tabDocs') contentToShow = 'doc-list';
            switchSidebar(contentToShow);
        });
    });

    state.els.rightFilterTabs?.forEach(b => b.addEventListener('click', (e) => {
        const clickedButton = e.target.closest('button');
        if (!clickedButton) return;
        state.els.rightFilterTabs.forEach(x => x.classList.remove('active'));
        clickedButton.classList.add('active');
        renderNotes();
    }));

    state.els.addBookmark?.addEventListener('click', () => {
        if (!state.pdfDoc) return;
        drawing.flushPendingIfAny();
        const label = prompt('북마크 이름 입력 (선택)') || '';
        state.bookmarks.push({ page: state.currentPage, label, time: Date.now() });
        renderer.renderBookmarks(); state.saveLocal();
    });

    state.els.exportNotes?.addEventListener('click', () => {
        drawing.flushPendingIfAny();
        if (!state.highlights.length) { alert('내보낼 노트가 없습니다'); return; }
        const rows = [['id', 'page', 'tag', 'text', 'comment', 'type', 'thickness_px', 'segment_count']];
        const pagesCache = renderer.getPagesCache();
        
        state.highlights.forEach(h => {
            if (h.id && !h.id.startsWith('temp_')) {
                const pageCache = pagesCache.get(h.page);
                const pageHeight = pageCache?.drawCanvas?.height || 0;
                rows.push([
                    h.id,
                    h.page,
                    h.tag || '기본',
                    utils.escapeCsv(h.text || ''),
                    utils.escapeCsv(h.comment || ''),
                    h.type || 'stroke',
                    pageHeight > 0 ? Math.round((h.thicknessNorm || 0) * pageHeight) : 0,
                    Array.isArray(h.paths) ? h.paths.length : (Array.isArray(h.path) ? 1 : 0)
                ]);
            }
        });
        const csv = rows.map(r => r.join(',')).join('\n');
        const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'notes.csv'; a.click();
        URL.revokeObjectURL(url);
    });

    state.els.clearData?.addEventListener('click', () => {
        drawing.flushPendingIfAny();
        if (confirm('로컬 북마크와 OCR 데이터를 삭제할까요? (클라우드 하이라이트는 유지됩니다)')) {
            state.setBookmarks([]); state.setOcrData({}); state.saveLocal();
            renderer.renderBookmarks();
            document.querySelectorAll('.ocr-layer').forEach(el => el.remove());
        }
    });

    state.els.ocrPage?.addEventListener('click', () => { drawing.flushPendingIfAny(); if (state.pdfDoc) ocr.runOcrForPage(state.currentPage); });
    state.els.ocrAll?.addEventListener('click', () => { drawing.flushPendingIfAny(); if (state.pdfDoc) ocr.runOcrAll(); });
    state.els.ocrToggleDebug?.addEventListener('click', ocr.toggleOcrDebug);

    // --- OCR 모달 리스너 ---
    state.elsOcrModal.closeBtn?.addEventListener('click', ocr.hideOcrResultModal);
    state.elsOcrModal.copyBtn?.addEventListener('click', () => {
        if (state.elsOcrModal.textarea) {
            state.elsOcrModal.textarea.select();
            try {
                document.execCommand('copy');
                const originalText = state.elsOcrModal.copyBtn.textContent;
                state.elsOcrModal.copyBtn.textContent = '복사 완료!';
                setTimeout(() => { state.elsOcrModal.copyBtn.textContent = originalText; }, 1500);
            } catch (err) { console.error('클립보드 복사 실패:', err); alert('복사 실패'); }
        }
    });
    state.elsOcrModal.overlay?.addEventListener('click', (e) => {
        if (e.target === state.elsOcrModal.overlay) { ocr.hideOcrResultModal(); }
    });

    // --- OCR 모드 커서 스타일 ---
    const style = document.createElement('style');
    style.textContent = `.page-wrap.ocr-select-mode .draw-layer { cursor: crosshair !important; }`;
    document.head.appendChild(style);

    // ====== Shortcuts ======
    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

        if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); state.els.undoBtn?.click(); }
        if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); state.els.redoBtn?.click(); }
        if (e.key.toLowerCase() === 'h') { e.preventDefault(); state.els.penBtn?.click(); }
        if (e.key.toLowerCase() === 'e') { e.preventDefault(); state.els.eraserBtn?.click(); }
        if (e.key === '=' || e.key === '+') { e.preventDefault(); state.els.zoomIn?.click(); }
        if (e.key === '-') { e.preventDefault(); state.els.zoomOut?.click(); }
        if (e.key === '0') { e.preventDefault(); state.els.zoomReset?.click(); }
        if (e.key === 'PageDown' || e.key === 'ArrowRight') { e.preventDefault(); state.els.nextPage?.click(); }
        if (e.key === 'PageUp' || e.key === 'ArrowLeft') { e.preventDefault(); state.els.prevPage?.click(); }
        
        const updateThickness = (newThickness) => {
            state.setCurrentThicknessPx(newThickness);
            if (state.els.thickness) state.els.thickness.value = String(newThickness);
            if (state.els.thicknessLabel) state.els.thicknessLabel.textContent = `${newThickness} px`;
            localStorage.setItem('pdfViewer.penThicknessPx', String(newThickness));
        };
        if (e.key === ']') { e.preventDefault(); updateThickness(Math.min(48, state.currentThicknessPx + 2)); }
        if (e.key === '[') { e.preventDefault(); updateThickness(Math.max(6, state.currentThicknessPx - 2)); }
    });

    console.log("Event listeners added.");
    state.updateButtons();
    // ⭐️ [추가] 백지 복습 모드 진입 버튼
    // -------------------------------------------------------
    const btnWhiteboard = document.getElementById('btn-whiteboard');
    
    if (btnWhiteboard) {
        btnWhiteboard.addEventListener('click', () => {
            // 1. 현재 열린 책 ID 가져오기 (viewer-state.js나 전역 변수 등에서)
            // (주의: viewer-state.js에 bookId가 없다면 doc_firebase.js의 함수를 써야 함)
            
            // 가장 쉬운 방법: URL이나 전역 변수 확인
            // 만약 doc_firebase.js를 import하기 어렵다면, 
            // main.js에서 window.currentBookId = ... 로 저장해두는 게 좋습니다.
            
            const bookId = window.currentBookId; // (main.js나 doc_firebase.js에서 설정해줘야 함)

            if (!bookId) {
                alert("먼저 문서를 열어주세요!");
                return;
            }

            // 2. 백지 복습 페이지로 이동 (bookId 전달)
            window.location.href = `whiteboard.html?bookId=${bookId}&v=2`;
        });
    }
});