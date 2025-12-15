// viewer-ui.js
// UI 이벤트, 버튼 리스너, DOM 조작, 챗봇 감지 로직을 담당합니다.

import * as state from './viewer-state.js';
import * as renderer from './viewer-renderer.js';
import * as drawing from './viewer-drawing.js';
import * as ocr from './viewer-ocr.js';
import * as search from './viewer-search.js';
import * as highlights from './viewer-highlight-manager.js';
import * as utils from './viewer-utils.js';

// ====== [헬퍼 함수] UI 유틸리티 ======

// 페이지 인디케이터 업데이트
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

// 화면 하단 임시 알림 (Toast)
let alertTimeout;
export function showTemporaryAlert(msg) {
    const old = document.getElementById('temp-alert');
    if (old) old.remove();
    clearTimeout(alertTimeout);

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

    alertTimeout = setTimeout(() => {
        div.style.opacity = '0';
        setTimeout(() => div.remove(), 300);
    }, 2000);
}

// 버튼 리플 효과 (Micro-interaction)
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

// ====== [노트 패널] ======
function noteFilterActive() {
    const btn = document.querySelector('.right-tabs button.active');
    return btn ? btn.dataset.filter : 'all';
}

export function renderNotes() {
    if (!state.els.notes) return;
    const filter = noteFilterActive();
    state.els.notes.innerHTML = '';
    
    const items = state.highlights.filter(h =>
        !h.id.startsWith('temp_') &&
        h.tag !== state.MARKER_STROKE_TAG && //[추가][12-11][끊김 방지]
        (filter === 'all' || h.tag === filter));
    if (!items.length) { 
        const empty = document.createElement('div'); 
        empty.className = 'empty'; 
        empty.textContent = '하이라이트가 없습니다'; 
        state.els.notes.appendChild(empty); 
        return; 
    }

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
        const del = document.createElement('button'); del.title = '삭제'; 
        del.innerHTML = '<i class="fa-regular fa-trash-can"></i>';
        del.addEventListener('click', () => {
            const removed = highlights.removeHighlights([h.id]);
            state.addCommand({ action: 'remove', payload: { ids: [h.id], removed } });
        });
        
        const cycle = document.createElement('button'); cycle.title = '태그 변경'; 
        cycle.innerHTML = '<i class="fa-solid fa-tag"></i>';
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

// ====== [사이드바] ======
export function switchSidebar(contentId) {
    const container = document.getElementById('sidebarContent');
    if (!container) return;
    const panels = container.children;
    for (let i = 0; i < panels.length; i++) {
        panels[i].style.display = 'none';
    }
    const targetPanel = document.getElementById(contentId);
    if (targetPanel) targetPanel.style.display = 'block';
}

//[추가][12-14][필기 모드 모달 토글 함수]
function toggleMarkerSettingModal(show) {
    if (!state.elsMarkerModal.overlay) return;

    if (show) {
        // 모달을 열 때 현재 값을 반영
        if (state.elsMarkerModal.thickness) {
            state.elsMarkerModal.thickness.value = String(state.markerCurrentThicknessPx);
        }
        if (state.elsMarkerModal.thicknessLabel) {
            state.elsMarkerModal.thicknessLabel.textContent = `${state.markerCurrentThicknessPx} px`;
        }
        
        state.elsMarkerModal.overlay.classList.remove('hidden');
    } else {
        state.elsMarkerModal.overlay.classList.add('hidden');
    }
}


// ====== [메인 이벤트 리스너] ======
document.addEventListener('DOMContentLoaded', () => {

    //[추가][12-14][DOM 요소 초기화 (모든 작업보다 먼저 실행)]
    state.initializeDOMElements();
    
    attachRipplesTo('button, .chip-btn, .label-btn, .right-tabs button, .sidebar-tabs button');

    // UI 초기화
    if (state.els.thickness) state.els.thickness.value = String(state.currentThicknessPx);
    if (state.els.thicknessLabel) state.els.thicknessLabel.textContent = `${state.currentThicknessPx} px`;
    
    // 로컬 데이터 로드
    state.loadLocal();
    renderer.renderBookmarks(); 

    console.log("Viewer UI: Event listeners setup started...");

    // 1. 네비게이션 & 줌
    state.els.prevPage?.addEventListener('click', () => { if (state.pdfDoc) { state.setCurrentPage(Math.max(1, state.currentPage - 1)); renderer.scrollToPage(state.currentPage); }});
    state.els.nextPage?.addEventListener('click', () => { if (state.pdfDoc) { state.setCurrentPage(Math.min(state.pdfDoc.numPages, state.currentPage + 1)); renderer.scrollToPage(state.currentPage); }});
    state.els.jumpInput?.addEventListener('keydown', (e) => { 
        if (e.key === 'Enter' && state.pdfDoc) { 
            const pVal = parseInt(state.els.jumpInput.value, 10); 
            if (!isNaN(pVal)) { const p = Math.max(1, Math.min(state.pdfDoc.numPages, pVal)); renderer.scrollToPage(p); } 
            state.els.jumpInput.value = ''; 
        } 
    });
    
    const rerenderWithChunkFlush = () => { if (state.pdfDoc) { drawing.flushPendingIfAny(); renderer.rerenderAll(); }};
    state.els.zoomIn?.addEventListener('click', () => { state.setScale(Math.min(3, state.scale + 0.1)); rerenderWithChunkFlush(); });
    state.els.zoomOut?.addEventListener('click', () => { state.setScale(Math.max(0.3, state.scale - 0.1)); rerenderWithChunkFlush(); });
    state.els.zoomReset?.addEventListener('click', () => { state.setScale(1.0); rerenderWithChunkFlush(); });
    
    state.els.toggleDark?.addEventListener('click', () => { document.body.classList.toggle('dark'); });
    state.els.modeContinuous?.addEventListener('click', () => { if (!state.continuousMode) { state.setContinuousMode(true); state.els.modeContinuous.classList.add('active'); state.els.modeSingle.classList.remove('active'); rerenderWithChunkFlush(); }});
    state.els.modeSingle?.addEventListener('click', () => { if (state.continuousMode) { state.setContinuousMode(false); state.els.modeSingle.classList.add('active'); state.els.modeContinuous.classList.remove('active'); rerenderWithChunkFlush(); }});

    // 2. Undo / Redo
    state.els.undoBtn?.addEventListener('click', () => {
        drawing.flushPendingIfAny();
        const cmd = state.undoStack.pop();
        if (!cmd) return;
        let redoData = null;
        switch (cmd.action) {
            case 'add': redoData = highlights.undoAddHighlight(cmd.payload.id); break;
            case 'remove': if (cmd.payload.removed?.length) { highlights.reAddHighlightsLocally(cmd.payload.removed); redoData = cmd.payload.ids; } break;
            case 'setTag': redoData = highlights.setHighlightTag(cmd.payload.id, cmd.payload.prev); break;
            case 'comment': redoData = highlights.setHighlightComment(cmd.payload.id, cmd.payload.prev); break;
        }
        if (redoData !== null) { cmd.redoPayload = redoData; state.redoStack.push(cmd); }
        state.updateButtons();
    });

    state.els.redoBtn?.addEventListener('click', () => {
        drawing.flushPendingIfAny();
        const cmd = state.redoStack.pop();
        if (!cmd) return;
        switch (cmd.action) {
            case 'add': if (cmd.payload.originalData) highlights.reAddHighlightsLocally([cmd.payload.originalData]); break;
            case 'remove': if (cmd.redoPayload?.length) highlights.removeHighlightsLocally(cmd.redoPayload); break;
            case 'setTag': if (cmd.payload.next) highlights.setHighlightTag(cmd.payload.id, cmd.payload.next); break;
            case 'comment': if (cmd.payload.next) highlights.setHighlightComment(cmd.payload.id, cmd.payload.next); break;
        }
        state.undoStack.push(cmd);
        state.updateButtons();
    });

    // 3. 툴바 버튼 (펜, 지우개, OCR)
    state.els.penBtn?.addEventListener('click', () => {
        drawing.flushPendingIfAny(); 
        state.setMode(state.selectMode === 'pen' ? 'none' : 'pen'); 
        state.setSelectedTag('기본');//[추가][12-09][형광펜 기본 모드일 때 '기본' 태그 설정]
        toggleMarkerSettingModal(false); //[추가][12-14][형광펜 클릭 시 필기 모드 모달 닫기]
    });

    state.els.markerBtn?.addEventListener('click', () => { // [추가][12-09][MarkerBtn 로직 추가]
        drawing.flushPendingIfAny(); 
        state.setMode(state.selectMode === 'marker' ? 'none' : 'marker'); 
        toggleMarkerSettingModal(false);//[추가][12-14][필기 클릭-> 혹시 모달창 열려있다면 닫기]
         // [삭제][12-11][자유 필기 모드일 때 '마커' 태그 설정 제거]
    });
    // [추가][12-14][MarkerSettingsBtn: 모달 팝업만 수행 (모드 전환 없음)]
    state.els.markerSettingsBtn?.addEventListener('click', () => { 
        // 모드가 무엇이든 설정 모달만 토글
        toggleMarkerSettingModal(state.elsMarkerModal.overlay.classList.contains('hidden'));//[논리반대로수정][12-14]
    });
    state.els.eraserBtn?.addEventListener('click', () => {
        drawing.flushPendingIfAny();
        state.setEraserTarget('pen'); //[추가][12-14][형광펜만 지우는 지우개]
        state.setMode(state.selectMode === 'eraser' ? 'none' : 'eraser');
        toggleMarkerSettingModal(false); // [12-14][추가][마커 모달 닫기]
    });
    state.els.ocrSelectBtn?.addEventListener('click', () => {
        state.setMode(state.selectMode === 'ocrSelect' ? 'none' : 'ocrSelect');
    });

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
    // [추가][12-14][필기 모드 모달 내부 이벤트 리스너]
    state.elsMarkerModal.closeBtn?.addEventListener('click', () => {
        toggleMarkerSettingModal(false);
    });

    state.elsMarkerModal.thickness?.addEventListener('input', () => {
        const px = Number(state.elsMarkerModal.thickness.value);
        state.setMarkerCurrentThicknessPx(px);
        if (state.elsMarkerModal.thicknessLabel) {
            state.elsMarkerModal.thicknessLabel.textContent = `${px} px`;
        }
        localStorage.setItem('pdfViewer.markerThicknessPx', String(px));
    });

    state.elsMarkerModal.eraserBtn?.addEventListener('click', () => {
        drawing.flushPendingIfAny();
        state.setEraserTarget('marker');//[추가][12-14][자유필기만 지우는 지우개]
        // 지우개 모드로 전환하고 모달 닫기 (모달을 통한 지우개 활성화)
        state.setMode('eraser');
        toggleMarkerSettingModal(false);
    });

    // [추가][12-14][오버레이 클릭 시 닫기]
    state.elsMarkerModal.overlay?.addEventListener('click', (e) => {
        if (e.target === state.elsMarkerModal.overlay) {
            toggleMarkerSettingModal(false);
        }
    });

    // 4. 검색 & 사이드바
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

    // 5. 북마크 & 내보내기 & 데이터 삭제
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
                    h.id, h.page, h.tag || '기본', utils.escapeCsv(h.text || ''), utils.escapeCsv(h.comment || ''),
                    h.type || 'stroke', pageHeight > 0 ? Math.round((h.thicknessNorm || 0) * pageHeight) : 0,
                    Array.isArray(h.paths) ? h.paths.length : (Array.isArray(h.path) ? 1 : 0)
                ]);
            }
        });
        const csv = rows.map(r => r.join(',')).join('\n');
        const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'notes.csv'; a.click();
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

    // 6. OCR
    state.els.ocrPage?.addEventListener('click', () => { drawing.flushPendingIfAny(); if (state.pdfDoc) ocr.runOcrForPage(state.currentPage); });
    state.els.ocrAll?.addEventListener('click', () => { drawing.flushPendingIfAny(); if (state.pdfDoc) ocr.runOcrAll(); });
    state.els.ocrToggleDebug?.addEventListener('click', ocr.toggleOcrDebug);
    
    state.elsOcrModal.closeBtn?.addEventListener('click', ocr.hideOcrResultModal);
    state.elsOcrModal.copyBtn?.addEventListener('click', () => {
        if (state.elsOcrModal.textarea) {
            state.elsOcrModal.textarea.select();
            document.execCommand('copy');
            const originalText = state.elsOcrModal.copyBtn.textContent;
            state.elsOcrModal.copyBtn.textContent = '복사 완료!';
            setTimeout(() => { state.elsOcrModal.copyBtn.textContent = originalText; }, 1500);
        }
    });
    state.elsOcrModal.overlay?.addEventListener('click', (e) => { if (e.target === state.elsOcrModal.overlay) ocr.hideOcrResultModal(); });

    // 7. 단축키 (Shortcuts)
    document.addEventListener('keydown', (e) => {
        if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
        if (e.ctrlKey && e.key.toLowerCase() === 'z') { e.preventDefault(); state.els.undoBtn?.click(); }
        if (e.ctrlKey && e.key.toLowerCase() === 'y') { e.preventDefault(); state.els.redoBtn?.click(); }
        if (e.key.toLowerCase() === 'h') { e.preventDefault(); state.els.penBtn?.click(); }
        if (e.key.toLowerCase() === 'e') { e.preventDefault(); state.els.eraserBtn?.click(); }
        if (['=','+'].includes(e.key)) { e.preventDefault(); state.els.zoomIn?.click(); }
        if (e.key === '-') { e.preventDefault(); state.els.zoomOut?.click(); }
        if (e.key === '0') { e.preventDefault(); state.els.zoomReset?.click(); }
        if (['PageDown','ArrowRight'].includes(e.key)) { e.preventDefault(); state.els.nextPage?.click(); }
        if (['PageUp','ArrowLeft'].includes(e.key)) { e.preventDefault(); state.els.prevPage?.click(); }
        const updateT = (v) => {
            state.setCurrentThicknessPx(v);
            if (state.els.thickness) state.els.thickness.value = String(v);
            if (state.els.thicknessLabel) state.els.thicknessLabel.textContent = `${v} px`;
            localStorage.setItem('pdfViewer.penThicknessPx', String(v));
        };
        if (e.key === ']') { e.preventDefault(); updateT(Math.min(48, state.currentThicknessPx + 2)); }
        if (e.key === '[') { e.preventDefault(); updateT(Math.max(6, state.currentThicknessPx - 2)); }
    });

    // -------------------------------------------------------
    // ⭐️ [추가] 백지 복습 모드 진입 버튼
    // -------------------------------------------------------
    const btnWhiteboard = document.getElementById('btn-whiteboard');
    if (btnWhiteboard) {
        btnWhiteboard.addEventListener('click', () => {
            const bookId = window.currentBookId || (state.pdfDoc ? "doc" : null); 
            if (!bookId || bookId === 'doc') {
                // bookId가 없으면 현재 URL에서 추출 시도
                const urlParams = new URLSearchParams(window.location.search);
                const bid = urlParams.get('file');
                if(bid) window.location.href = `whiteboard.html?bookId=${bid}&v=2`;
                else alert("먼저 문서를 열어주세요!");
                return;
            }
            window.location.href = `whiteboard.html?bookId=${bookId}&v=2`;
        });
    }

    // -------------------------------------------------------
    // ⭐️ [추가] 챗봇 메시지 자동 감지 (MutationObserver)
    // -------------------------------------------------------
    const CHAT_CONTAINER_SELECTORS = [ '#chat-messages', '.chat-messages', '#messages', '.messages' ];
    const BOT_BUBBLE_SELECTORS     = [ '[data-role="bot"]', '.bot', '.assistant', '.message.bot', '.message.assistant' ];

    function findChatContainer() {
      for (const sel of CHAT_CONTAINER_SELECTORS) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      return null;
    }

    function installBotMessageObserver(container) {
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (!(node instanceof HTMLElement)) continue;

            const isBot = BOT_BUBBLE_SELECTORS.some(sel => node.matches?.(sel) || node.querySelector?.(sel));
            if (!isBot) continue;

            let text = "";
            if (node.matches?.('.assistant, .bot, .message')) {
              text = node.innerText?.trim() || node.textContent?.trim() || "";
            } else {
              const target = node.querySelector?.('.assistant, .bot, .text, .content') || node;
              text = target?.innerText?.trim() || target?.textContent?.trim() || "";
            }
            if (!text) continue;

            const personaKey = document.getElementById('chat-persona-select')?.value || 'professor';
            // viewer-main.js로 이벤트 발송
            document.dispatchEvent(new CustomEvent('botMessageRendered', { detail: { text, personaKey } }));
          }
        }
      });

      observer.observe(container, { childList: true, subtree: true });
      console.log('[UI] Chat Observer installed.');
    }

    (function waitForChat() {
      const c = findChatContainer();
      if (c) return installBotMessageObserver(c);
      setTimeout(waitForChat, 400);
    })();

    console.log("Viewer UI setup complete.");
});