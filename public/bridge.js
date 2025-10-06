/* ===== bridge.js (외부 노출 API — doc.js가 의존) ===== */
window.MyBook = window.MyBook || {};

window.MyBook.renderPDF = renderPDF;             // viewer.js
window.MyBook.renderHighlights = renderHighlights; // annotate.js
window.MyBook.noteView = noteView;               // annotate.js

window.MyBook.replaceHighlights = function (list) {
  // 내부 상태 교체
  highlights = Array.isArray(list) ? list.slice() : [];
  undoStack = [];
  redoStack = [];

  // 화면 재구성
  document.querySelectorAll(".highlight-span").forEach((el) => el.remove());
  renderHighlights();

  // 정리뷰/필터 초기화
  currentFilter = "all";
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelector('.tab[data-tag="all"]')?.classList.add("active");
  noteView("all");
};

/* (선택) 나중에 OCR 결과를 하이라이트로 추가하려면 이런 브릿지도 가능
window.MyBook.addFromOCR = function (pageNumber, text, rects) {
  const cmd = new AddHighlightCommand(pageNumber, rects, text);
  executeCommand(cmd);
};
*/
