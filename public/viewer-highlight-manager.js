// viewer-highlight-manager.js

import * as state from './viewer-state.js';
import { redrawStrokesForPage } from './viewer-drawing.js';
import { renderNotes } from './viewer-ui.js';

// ====== Highlight Management (Firestore 연동) ======

export function execAddHighlight(hData) {
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const tempHighlight = { ...hData, id: tempId };
    state.highlights.push(tempHighlight); // .push()는 배열을 '변경'하는 것이라 괜찮습니다.
    redrawStrokesForPage(hData.page);
    renderNotes();
    state.addCommand({ action: 'add', payload: { id: tempId, originalData: tempHighlight } }); // Redo를 위해 원본 데이터 저장

    if (window.saveHighlightChange) {
        window.saveHighlightChange('add', hData)
            .then(docRef => {
                // docRef가 유효한지(undefined가 아닌지) 확인합니다.
                if (docRef && docRef.id) {
                    const realId = docRef.id;
                    const localIndex = state.highlights.findIndex(h => h.id === tempId);
                    if (localIndex !== -1) {
                        // (중요) ID가 늦게 올 수 있으므로, 이미 Firestore ID가
                        // setHighlightsData에 의해 설정되지 않았는지 확인합니다.
                        if (state.highlights[localIndex].id === tempId) {
                             state.highlights[localIndex].id = realId;
                        }
                    }
                    renderNotes();
                } else {
                    console.log("Firestore 'add' 응답에서 docRef.id를 받지 못했습니다. (onSnapshot이 처리할 수 있음)");
                }
            })
            .catch(err => console.error("Error saving highlight:", err));
    } else {
        console.error("saveHighlightChange 함수를 찾을 수 없음.");
    }
}


// Undo/Redo 용 로컬 함수
export function undoAddHighlight(tempId) {
    const idx = state.highlights.findIndex(x => x.id === tempId);
    if (idx !== -1) {
        const pg = state.highlights[idx].page;
        const removedHighlight = state.highlights.splice(idx, 1)[0]; // .splice()는 배열 '변경'이라 괜찮습니다.
        redrawStrokesForPage(pg);
        renderNotes();
        return removedHighlight; // Redo 스택용
    }
    return null;
}

// Firestore ID 배열을 받아 삭제
export function removeHighlights(ids) {
    const affected = new Set();
    const removedItems = [];

    // 🔴 [수정 1] state.highlights = ... (대입) 대신 state.setHighlights(...) 사용
    const newHighlights = state.highlights.filter(h => {
        if (ids.includes(h.id) && !h.id.startsWith('temp_')) {
            affected.add(h.page);
            removedItems.push(h);
            return false;
        }
        return true;
    });
    state.setHighlights(newHighlights); // 👈 수정된 부분

    affected.forEach(p => redrawStrokesForPage(p));
    renderNotes();

    if (window.saveHighlightChange) {
        removedItems.forEach(removedHighlight => {
            window.saveHighlightChange('delete', removedHighlight);
        });
    } else {
        console.error("saveHighlightChange 함수를 찾을 수 없음.");
    }
    return removedItems; // Undo용
}

// 로컬 Redo용 (Firestore 호출 X)
export function reAddHighlightsLocally(items) {
    if (!items || items.length === 0) return;
    state.highlights.push(...items); // .push()는 괜찮습니다.
    const affectedPages = new Set(items.map(h => h.page));
    affectedPages.forEach(p => redrawStrokesForPage(p));
    renderNotes();
}

// 로컬 Redo용 (Firestore 호출 X)
export function removeHighlightsLocally(ids) {
    const affected = new Set();
    // 🔴 [수정 2] state.highlights = ... (대입) 대신 state.setHighlights(...) 사용
    const newHighlights = state.highlights.filter(h => {
        if (ids.includes(h.id)) {
            affected.add(h.page);
            return false;
        }
        return true;
    });
    state.setHighlights(newHighlights); // 👈 수정된 부분

    affected.forEach(p => redrawStrokesForPage(p));
    renderNotes();
}


export function setHighlightTag(id, tag) {
    const hIndex = state.highlights.findIndex(x => x.id === id && !x.id.startsWith('temp_'));
    if (hIndex === -1) return;

    const originalTag = state.highlights[hIndex].tag;
    state.highlights[hIndex].tag = tag; // 객체 속성 변경은 괜찮습니다.
    state.highlights[hIndex].color = state.HIGHLIGHT_COLORS[tag] || state.HIGHLIGHT_COLORS['기본'];

    redrawStrokesForPage(state.highlights[hIndex].page);
    renderNotes();

    if (window.saveHighlightChange) {
        window.saveHighlightChange('update', state.highlights[hIndex]);
    } else {
        console.error("saveHighlightChange 함수를 찾을 수 없음.");
    }
    return originalTag; // Undo용
}

export function setHighlightComment(id, comment) {
    const hIndex = state.highlights.findIndex(x => x.id === id && !x.id.startsWith('temp_'));
    if (hIndex === -1) return;

    const originalComment = state.highlights[hIndex].comment;
    state.highlights[hIndex].comment = comment; // 객체 속성 변경은 괜찮습니다.

    renderNotes(); // 노트 패널만 업데이트

    if (window.saveHighlightChange) {
        window.saveHighlightChange('update', state.highlights[hIndex]);
    } else {
        console.error("saveHighlightChange 함수를 찾을 수 없음.");
    }
    return originalComment; // Undo용
}

// Firestore에서 데이터 받을 때 호출되는 함수
export function setHighlightsData(newHighlights) {
    if (Array.isArray(newHighlights)) {
        // 🔴 [수정 3] state.highlights = ... (대입) 대신 state.setHighlights(...) 사용
        const highlightsCopy = newHighlights.map(h => ({ ...h }));
        state.setHighlights(highlightsCopy); // 👈 수정된 부분

        console.log("Firestore 하이라이트 업데이트:", state.highlights.length, "개");

        if (state.pdfDoc) {
            for (let p = 1; p <= state.pdfDoc.numPages; p++) {
                redrawStrokesForPage(p);
            }
        }
        renderNotes();
        state.updateButtons();
    } else {
        console.error("잘못된 하이라이트 데이터:", newHighlights);
        state.setHighlights([]); // 👈 수정된 부분
        if (state.pdfDoc) {
            for (let p = 1; p <= state.pdfDoc.numPages; p++) redrawStrokesForPage(p);
        }
        renderNotes();
        state.updateButtons();
    }
}