/* ===== storage.js (문서-중립 키로만 저장/불러오기) ===== */
/* ※ 중요한 규칙: 여기서는 오직 'mybook_data' 키에
   현재 문서의 highlights 배열만 저장/복원.
   문서별 동기화는 doc.js가 훅으로 처리함. */

function saveData() {
  try {
    // highlights 배열만 저장 (doc.js가 이걸 현재 문서에 반영)
    localStorage.setItem("mybook_data", JSON.stringify(highlights || []));
    // 필요 시 타 UI 갱신은 annotate.js 쪽에서 이미 처리
  } catch (e) {
    console.error("데이터 저장 오류:", e);
  }
}

function loadData() {
  try {
    const raw = localStorage.getItem("mybook_data");
    if (!raw) {
      highlights = [];
    } else {
      const list = JSON.parse(raw);
      highlights = Array.isArray(list) ? list : [];
    }
    renderHighlights();       // annotate.js
    noteView(currentFilter);  // annotate.js
  } catch (e) {
    console.error("데이터 불러오기 오류:", e);
  }
}
