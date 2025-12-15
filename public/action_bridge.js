// public/action_bridge.js
(() => {
  const KEY = "mybook:requestedAction";

  function clear(){
    try { localStorage.removeItem(KEY); } catch {}
  }

  function waitUntil(fn, { timeoutMs = 6000, intervalMs = 150 } = {}) {
    const start = Date.now();
    return new Promise((resolve) => {
      const t = setInterval(() => {
        const ok = fn();
        if (ok) { clearInterval(t); resolve(true); return; }
        if (Date.now() - start > timeoutMs) { clearInterval(t); resolve(false); }
      }, intervalMs);
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    const action = localStorage.getItem(KEY);
    if (!action) return;

    // 기본은 index에서 현재 문서가 열리도록 이미 상태가 유지되게 둡니다.
    if (action === "continue") { clear(); return; }

    if (action === "upload") {
      // 보안상 자동 file picker 오픈은 제한될 수 있어 강조/안내만 합니다.
      const fileInput = document.getElementById("file");
      const label = document.getElementById("pipeline-status");
      if (label) label.textContent = "PDF 업로드를 진행해 주십시오.";
      if (fileInput) {
        fileInput.scrollIntoView({ behavior:"smooth", block:"center" });
        fileInput.focus();
      }
      clear();
      return;
    }

    if (action === "highlightQuiz") {
      // 버튼이 활성화(파이프라인 완료)될 때까지 기다렸다가 클릭
      const ok = await waitUntil(() => {
        const btn = document.getElementById("modal-highlights-btn");
        if (!btn) return false;
        if (btn.disabled) return false;
        btn.click();
        return true;
      });
      if (!ok) {
        const label = document.getElementById("pipeline-status");
        if (label) label.textContent = "하이라이트 퀴즈는 문서 분석 완료 후 사용할 수 있습니다.";
      }
      clear();
      return;
    }

    if (action === "fullQuiz") {
      const ok = await waitUntil(() => {
        const btn = document.getElementById("modal-full-doc-btn");
        if (!btn) return false;
        if (btn.disabled) return false;
        btn.click();
        return true;
      });
      if (!ok) {
        const label = document.getElementById("pipeline-status");
        if (label) label.textContent = "전체 요약/퀴즈는 문서 분석 완료 후 사용할 수 있습니다.";
      }
      clear();
      return;
    }

    clear();
  });
})();
