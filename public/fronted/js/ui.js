// ui.js
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDateTime(iso) {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    return d.toLocaleString("ko-KR", { hour12: false });
  } catch {
    return "-";
  }
}

function getNextStepLabel(progress) {
  if (progress < 40) return "정독 계속";
  if (progress < 75) return "퀴즈로 이해 확인";
  if (progress < 100) return "백지 복습으로 마무리";
  return "완료";
}

window.UI = {
  escapeHtml,
  formatDateTime,
  getNextStepLabel,
};
