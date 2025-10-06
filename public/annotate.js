import { db, collection, addDoc, deleteDoc, doc, updateDoc, Timestamp, writeBatch } from "./A.firebase.js";

/* 전역 상태 */
let highlights = [];
let currentUserId = null;
let currentBookId = null;

let isPenActive = false;
let isEraserActive = false;
let isTag = false;
let currentFilter = "all";
let lastSelectedHighlightId = null;

let undoStack = [];
let redoStack = [];

/* 버튼/DOM */
const UNDO_BUTTON = document.getElementById("undo-btn");
const REDO_BUTTON = document.getElementById("redo-btn");
const penBtn1 = document.getElementById("pen1");
const eraserBtn = document.getElementById("eraser-btn");
const tagBtn = document.getElementById("tag-btn");
const dropdown = document.getElementById("dropdown");

/* 컨텍스트 설정 (doc.js에서 호출) */
export function setAnnotationContext(userId, bookId) {
    currentUserId = userId;
    currentBookId = bookId;
    clearAnnotations();
}

/* 데이터 업데이트 (doc.js의 onSnapshot 콜백에서 호출) */
export function updateHighlightsData(newHighlights) {
    highlights = newHighlights;
    renderHighlights();
    noteView(currentFilter);
    updateButtons();
}

/* 주석 상태 초기화 */
export function clearAnnotations() {
    highlights = [];
    undoStack = [];
    redoStack = [];
    renderHighlights();
    noteView("all");
    updateButtons();
}

function updateButtons() {
    if (UNDO_BUTTON) UNDO_BUTTON.disabled = undoStack.length === 0;
    if (REDO_BUTTON) REDO_BUTTON.disabled = redoStack.length === 0;
}

/* 커맨드 실행 */
function executeCommand(command) {
    undoStack.push(command);
    redoStack = [];
    command.execute(); // Firestore 작업 실행
    updateButtons();
}

/* Undo/Redo */
async function undo() {
    if (undoStack.length > 0) {
        const last = undoStack.pop();
        await last.undo();
        redoStack.push(last);
        updateButtons();
    }
}
async function redo() {
    if (redoStack.length > 0) {
        const last = redoStack.pop();
        await last.execute();
        undoStack.push(last);
        updateButtons();
    }
}
if (UNDO_BUTTON) UNDO_BUTTON.addEventListener("click", undo);
if (REDO_BUTTON) REDO_BUTTON.addEventListener("click", redo);


/* --- ✨ 최종 개선 함수: 사각형 병합 로직 --- */
function mergeRects(rects) {
    if (!rects || rects.length === 0) return [];

    // 1. 라인별로 사각형 그룹화
    const lines = [];
    const verticalTolerance = 5; // 같은 라인으로 판단할 세로 허용 오차

    rects.forEach(rect => {
        let foundLine = false;
        for (const line of lines) {
            // 사각형의 중간점이 기존 라인의 세로 범위 안에 있는지 확인
            const rectMidY = rect.top + rect.height / 2;
            if (rectMidY >= line.top && rectMidY <= line.bottom) {
                line.rects.push(rect);
                // 라인의 세로 범위를 필요에 따라 확장
                line.top = Math.min(line.top, rect.top);
                line.bottom = Math.max(line.bottom, rect.top + rect.height);
                foundLine = true;
                break;
            }
        }
        if (!foundLine) {
            // 새로운 라인 생성
            lines.push({ top: rect.top, bottom: rect.top + rect.height, rects: [rect] });
        }
    });

    // 2. 각 라인 내에서 사각형들을 하나의 긴 사각형으로 병합
    const mergedRects = lines.map(line => {
        if (line.rects.length === 0) return null;
        
        // 라인 내 사각형들을 왼쪽에서 오른쪽으로 정렬
        line.rects.sort((a, b) => a.left - b.left);
        
        const firstRect = line.rects[0];
        const rightmostRect = line.rects[line.rects.length - 1];
        
        return {
            left: firstRect.left,
            top: line.top,
            width: (rightmostRect.left + rightmostRect.width) - firstRect.left,
            height: line.bottom - line.top,
        };
    }).filter(rect => rect !== null); // null이 된 빈 라인 제거

    return mergedRects;
}


/* --- 커맨드 (Firestore 연동) --- */

class AddHighlightCommand {
    constructor(pageNumber, rects, text) {
        this.page = pageNumber;
        this.rects = rects;
        this.text = text;
        this.firestoreId = null;
    }
    async execute() {
        if (!currentUserId || !currentBookId) return;
        const newHighlight = {
            page: this.page,
            rects: this.rects,
            text: this.text,
            tag: null,
            userId: currentUserId,
            bookId: currentBookId,
            createdAt: Timestamp.now(),
        };
        const docRef = await addDoc(collection(db, "highlights"), newHighlight);
        this.firestoreId = docRef.id;
    }
    async undo() {
        if (!this.firestoreId) return;
        await deleteDoc(doc(db, "highlights", this.firestoreId));
    }
}

class RemoveHighlightsCommand {
    constructor(ids) {
        this.ids = ids;
        this.backup = highlights.filter(h => this.ids.includes(h.id));
    }
    async execute() {
        const batch = writeBatch(db);
        this.ids.forEach(id => {
            batch.delete(doc(db, "highlights", id));
        });
        await batch.commit();
    }
    async undo() {
        if (this.backup.length === 0) return;
        const batch = writeBatch(db);
        this.backup.forEach(h => {
            const docRef = doc(db, "highlights", h.id);
            const { id, ...data } = h;
            batch.set(docRef, data);
        });
        await batch.commit();
    }
}

class AddTagCommand {
    constructor(highlightId, tag) {
        this.highlightId = highlightId;
        this.newTag = tag;
        const h = highlights.find(h => h.id === highlightId);
        this.originalTag = h ? h.tag : null;
    }
    async execute() {
        await updateDoc(doc(db, "highlights", this.highlightId), { tag: this.newTag });
    }
    async undo() {
        await updateDoc(doc(db, "highlights", this.highlightId), { tag: this.originalTag });
    }
}


/* 툴 토글 */
penBtn1?.addEventListener("click", function () {
    isPenActive = !isPenActive;
    isEraserActive = false; isTag = false;
    penBtn1.classList.toggle("active", isPenActive);
    eraserBtn.classList.remove("active");
    tagBtn.classList.remove("active");
    dropdown.classList.remove("show");
});
eraserBtn?.addEventListener("click", function () {
    isEraserActive = !isEraserActive;
    isPenActive = false; isTag = false;
    eraserBtn.classList.toggle("active", isEraserActive);
    penBtn1.classList.remove("active");
    tagBtn.classList.remove("active");
    dropdown.classList.remove("show");
});
tagBtn?.addEventListener("click", function () {
    isTag = !isTag;
    isPenActive = false; isEraserActive = false;
    tagBtn.classList.toggle("active", isTag);
    penBtn1.classList.remove("active");
    eraserBtn.classList.remove("active");
    dropdown.classList.toggle("show", isTag);
});

/* 하이라이트 클릭(지우개/태그) */
document.addEventListener("click", function (e) {
    if (!e.target.classList.contains("highlight-span")) return;
    const id = e.target.dataset.id;
    if (!id) return;
    
    if (isEraserActive) {
        executeCommand(new RemoveHighlightsCommand([id]));
    } else if (isTag) {
        lastSelectedHighlightId = id;
        dropdown.classList.add("show");
    }
    e.preventDefault(); e.stopPropagation();
});


/* 드래그 선택 → 추가/삭제/선택 */
document.addEventListener("mouseup", function () {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const selectedText = range.toString().trim();
    if (!selectedText) {
        sel.removeAllRanges();
        return;
    }

    const pageDiv = range.startContainer.parentElement.closest(".page");
    if (!pageDiv) {
        sel.removeAllRanges();
        return;
    }

    const pageNumber = parseInt(pageDiv.dataset.pageNumber, 10);
    const pageRect = pageDiv.getBoundingClientRect();
    const selectionRects = Array.from(range.getClientRects());
    
    const overlapping = highlights.filter(h =>
        h.page === pageNumber && h.rects.some(hr => {
            const absHr = { left: hr.left + pageRect.left, top: hr.top + pageRect.top, width: hr.width, height: hr.height };
            return selectionRects.some(sr =>
                absHr.left < sr.right && absHr.left + absHr.width > sr.left &&
                absHr.top < sr.bottom && absHr.top + absHr.height > sr.top
            );
        })
    );

    if (isPenActive) {
        const relativeRects = selectionRects.map(r => ({
            left: r.left - pageRect.left, top: r.top - pageRect.top,
            width: r.width, height: r.height,
        }));
        const merged = mergeRects(relativeRects);
        executeCommand(new AddHighlightCommand(pageNumber, merged, selectedText));
    } else if (isEraserActive && overlapping.length > 0) {
        executeCommand(new RemoveHighlightsCommand(overlapping.map(h => h.id)));
    }
    
    sel.removeAllRanges();
});


/* 유틸 */
function toSlug(s) { return String(s).trim().replace(/\s+/g, "-"); }

/* 렌더: 하이라이트 오버레이 */
function renderHighlights() {
    document.querySelectorAll(".highlight-span").forEach((el) => el.remove());

    highlights.forEach((h) => {
        const pageDiv = document.querySelector(`.page[data-page-number="${h.page}"]`);
        if (pageDiv && Array.isArray(h.rects)) {
            const color = h.tag === '중요' ? 'rgba(255, 105, 97, 0.4)' : h.tag === '암기' ? 'rgba(173, 216, 230, 0.4)' : h.tag === '참고' ? 'rgba(144, 238, 144, 0.4)' :'rgba(255, 255, 0, 0.4)';
            h.rects.forEach((rect) => {
                const el = document.createElement("span");
                el.className = "highlight-span";
                Object.assign(el.style, {
                    position: "absolute",
                    left: `${rect.left}px`, top: `${rect.top}px`,
                    width: `${rect.width}px`, height: `${rect.height}px`,
                    backgroundColor: color,
                    pointerEvents: "auto", cursor: "pointer",
                    zIndex: 0,
                });
                el.dataset.id = h.id;
                if (h.tag) el.classList.add(`tag-${toSlug(h.tag)}`);
                pageDiv.appendChild(el);
            });
        }
    });
}

/* 정리뷰 렌더 */
function noteView(filterTag = null) {
    const wrap = document.querySelector(".note-wrap");
    if (!wrap) return;

    const filtered = highlights.filter(h => filterTag === "all" || !filterTag || h.tag === filterTag);
    wrap.innerHTML = '';

    filtered.forEach((note) => {
        const item = document.createElement("div");
        item.className = "note-item";
        item.innerHTML = `
            <span class="note-text" data-page="${note.page}">[p.${note.page}] ${note.text}</span>
            <button class="delete-btn" data-id="${note.id}">✕</button>
        `;
        wrap.appendChild(item);
    });
}

// Note view event delegation
document.querySelector(".note-wrap")?.addEventListener('click', (e) => {
    const target = e.target;
    if (target.classList.contains('delete-btn')) {
        executeCommand(new RemoveHighlightsCommand([target.dataset.id]));
    } else if (target.classList.contains('note-text')) {
        document.querySelector(`.page[data-page-number="${target.dataset.page}"]`)?.scrollIntoView({ behavior: "smooth" });
    }
});


/* 탭 필터 */
document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        currentFilter = tab.dataset.tag;
        noteView(currentFilter);
    });
});

/* 드롭다운 버튼(태그 적용) */
dropdown?.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", function () {
        const tag = btn.dataset.tag || btn.textContent.trim();
        if (lastSelectedHighlightId) {
            executeCommand(new AddTagCommand(lastSelectedHighlightId, tag));
            lastSelectedHighlightId = null;
            dropdown.classList.remove("show");
        }
    });
});
