console.log("TEST: viewer-main.js 스크립트 시작!");
// 상태 및 UI 모듈을 먼저 임포트하여 초기화 코드가 실행되도록 합니다.
import './viewer-state.js'; // 👈 'import * as state' 대신 이렇게 변경
import './viewer-ui.js'; 

// 다른 모듈에서 필요한 함수들을 가져옵니다.
import { renderDocument, clearDocument } from './viewer-renderer.js';
import { setHighlightsData } from './viewer-highlight-manager.js';
import { onBotMessageHook } from "./viewer-session-hooks.js"; // 수정사항!!

// ====== 전역 등록 ======
// 다른 스크립트(예: doc.js)에서 호출할 수 있도록 window 객체에 등록합니다.
window.renderDocument = renderDocument;
window.setHighlightsData = setHighlightsData;
window.clearDocument = clearDocument;

console.log("viewer-main.js loaded and modules initialized.");

// ▼ 봇 메시지 렌더 이벤트를 받아 세션 훅 호출  // 수정사항!!
document.addEventListener('botMessageRendered', async (e) => { // 수정사항!!
  const { text, personaKey } = e.detail || {};                 // 수정사항!!
  const key = personaKey || document.getElementById('chat-persona-select')?.value || 'professor'; // 수정사항!!
  try {                                                        // 수정사항!!
    await onBotMessageHook(text, key);                         // 수정사항!!
  } catch (err) {                                              // 수정사항!!
    console.warn('onBotMessageHook failed:', err);             // 수정사항!!
  }                                                            // 수정사항!!
});                                                            // 수정사항!!