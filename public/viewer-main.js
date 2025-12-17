// viewer-main.js
console.log("TEST: viewer-main.js 스크립트 시작!");

// 1. 상태 및 UI 모듈 임포트
import './viewer-state.js';
import './viewer-ui.js'; 

// 2. 렌더링 및 하이라이트 함수 임포트
import { renderDocument, scrollToPage, clearDocument } from './viewer-renderer.js';
import { setHighlightsData } from './viewer-highlight-manager.js';

// 3. 챗봇 관련 임포트
import { PROMPTS } from './viewer-personas.js'; //[12.04 수정]
import { onBotMessageHook } from "./viewer-session-hooks.js";

// ====== 전역 등록 ======
window.renderDocument = renderDocument;
window.setHighlightsData = setHighlightsData;
window.clearDocument = clearDocument;

console.log("viewer-main.js loaded and modules initialized.");

// ====== 1. 챗봇 메시지 감지 리스너 (저장 훅) ======
document.addEventListener('botMessageRendered', async (e) => {
  const { text, personaKey } = e.detail || {};
  const key = personaKey || document.getElementById('chat-persona-select')?.value || 'professor';
  try {
    await onBotMessageHook(text, key);
  } catch (err) {
    console.warn('onBotMessageHook failed:', err);
  }
});

// ====== 2. 챗봇 초기화 및 전송 로직 ======
let isChatbotInit = false;

document.addEventListener('DOMContentLoaded', () => {
    if (!isChatbotInit) {
        initChatbot();
        isChatbotInit = true; 
    }
});

function initChatbot() {
    const chatInput = document.getElementById("chat-input");
    const chatSendBtn = document.getElementById("chat-send-btn");
    const personaSelect = document.getElementById("chat-persona-select");
    const chatMessages = document.getElementById("chat-messages"); // 👈 메시지 창 요소

    let localChatHistory = [];
    let isSending = false;

    if (!chatInput || !chatSendBtn) return;

    // 기존 리스너 제거 후 교체 (중복 방지)
    const newBtn = chatSendBtn.cloneNode(true);
    chatSendBtn.parentNode.replaceChild(newBtn, chatSendBtn);
    const finalSendBtn = document.getElementById("chat-send-btn");

    // ⭐️ 메시지 전송 함수
    async function handleSendMessage() {
        if (isSending) return; 

        const userText = chatInput.value.trim();
        if (!userText) return;

        isSending = true;
        finalSendBtn.disabled = true;

        try {
            // 1. [UI] 내 말풍선 즉시 표시 (이게 빠져있었음!)
            addChatMessage('user', userText);
            chatInput.value = ""; // 입력창 비우기

            // 2. [UI] 로딩 말풍선 표시
            const loadingMsgId = `msg-${Date.now()}`;
            const loadingElement = addChatMessage('bot', '답변을 생성 중입니다...', 'loading', loadingMsgId);

            // 3. 프롬프트 준비
            const selectedKey = personaSelect ? personaSelect.value : 'professor';
            let systemPromptText = "";

            // 화면의 선택값(value)에 따라 새로운 프롬프트 키를 매핑
            switch (selectedKey) {
                case "socrates": 
                    systemPromptText = PROMPTS.socrates_v3; // 소크라테스
                    break;
                case "senior":   
                    systemPromptText = PROMPTS.applier_v1;  // 개념 활용형 (선배)
                    break;
                case "professor":
                default:
                    systemPromptText = PROMPTS.builder_v3;  // 개념 구축형 (교수)
                    break;
                case "general":
                    systemPromptText = PROMPTS.general_v1; 
                    break;
            }

            localChatHistory.push({ role: "user", content: userText });

            // 4. 백엔드 전송
            if (window.sendQueryToBot) {
                const bookId = window.currentBookId;
                if (!bookId) {
                    updateChatMessage(loadingElement, "오류: 문서를 먼저 열어주세요.");
                    localChatHistory.pop();
                    return;
                }

                const botReply = await window.sendQueryToBot(bookId, localChatHistory, systemPromptText);
                
                if (botReply) {
                    // 5. [UI] 로딩 -> 실제 답변으로 교체 (이게 빠져있었음!)
                    updateChatMessage(loadingElement, botReply);
                    localChatHistory.push({ role: "assistant", content: botReply });
                } else {
                    updateChatMessage(loadingElement, "답변을 받아오지 못했습니다.");
                }
            } else {
                updateChatMessage(loadingElement, "서버 통신 함수 오류");
            }

        } catch (err) {
            console.error("메시지 전송 실패:", err);
            // 실패 시 에러 메시지 표시
            // (loadingElement가 정의되어 있다면 업데이트)
            const chatList = document.getElementById("chat-messages");
            if (chatList && chatList.lastElementChild && chatList.lastElementChild.classList.contains('loading')) {
                 updateChatMessage(chatList.lastElementChild, "오류가 발생했습니다.");
            }
            localChatHistory.pop();
        } finally {
            isSending = false;
            finalSendBtn.disabled = false;
            chatInput.focus();
        }
    }

    finalSendBtn.addEventListener("click", handleSendMessage);
    
    chatInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
        }
    });

    // ⭐️ [UI 헬퍼 함수] 말풍선 추가 [12.17 수정]
    function addChatMessage(sender, text, type, id) {
        const msgDiv = document.createElement("div");
        msgDiv.classList.add("chat-message", sender);
        if (type === 'loading') msgDiv.classList.add("loading");
        if (id) msgDiv.id = id;
        
        const p = document.createElement("p");
        
        // 🤖 봇이 말한 경우에만 링크 변환 기능 적용
        if (sender === 'bot' || sender === 'assistant') {
            p.innerHTML = formatPageLink(text); // 텍스트를 HTML 버튼으로 변환
        } else {
            p.textContent = text;
        }

        msgDiv.appendChild(p);
        
        if (chatMessages) {
                chatMessages.appendChild(msgDiv);
                chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        return msgDiv;
    }

    // [2] 텍스트 -> 버튼 변환 함수 (새로 추가)
    function formatPageLink(text) {
        // 1. 볼드체(**) 제거: **p.12** -> p.12 (버튼이 깨지는 원인 제거)
        let cleanText = text.replace(/\*\*(p\.\s*\d+|page\s*\d+|페이지\s*\d+)\*\*/gi, '$1');

        // 2. 정규식: "p.12", "p. 12", "page 12", "페이지 12" 다 잡음
        const regex = /(?:p\.|page|페이지)\s*(\d+)/gi;
        
        // 3. 줄바꿈 처리 및 버튼 변환
        return cleanText.replace(/\n/g, '<br>').replace(regex, (match, pageNum) => {
            return `<button onclick="window.moveToPage(${pageNum})" 
                    style="color:#2563eb; background:#eff6ff; border:none; padding:2px 6px; border-radius:4px; cursor:pointer; font-weight:bold; font-size:0.9em; margin:0 2px; vertical-align:middle;">
                    📄 ${pageNum}p 이동
                    </button>`;
        });
    }

    // ⭐️ [UI 헬퍼 함수] 말풍선 내용 업데이트
    function updateChatMessage(element, newText) {
            if (element) {
                element.classList.remove("loading");
                const p = element.querySelector("p");
                
                if (p) {
                    // 🤖 봇 메시지(bot/assistant)인 경우에만 링크 변환 + HTML 적용
                    if (element.classList.contains('bot') || element.classList.contains('assistant')) {
                        p.innerHTML = formatPageLink(newText);
                    } else {
                        // 사용자 메시지는 보안상 텍스트로 처리
                        p.textContent = newText;
                    }
                }
                
                if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
            }
        }
    }

window.moveToPage = function(pageNum) {
    console.log(`🚀 챗봇 요청으로 ${pageNum}페이지로 이동합니다.`);
    
    // [수정] renderDocument나 renderPage가 아니라, 'scrollToPage'를 호출합니다!
    if (typeof scrollToPage === 'function') { // import한 함수 직접 사용
        scrollToPage(parseInt(pageNum));
    } 
    // 만약 import가 안 되는 구조라면 window 전역 객체 등을 확인해야 함
    else {
        console.error("scrollToPage 함수를 찾을 수 없습니다.");
    }
};

// [추가] 외부에서 챗봇 질문 트리거 (드래그 검색 / OCR 연동용)
// =========================================
document.addEventListener('triggerChatQuery', (e) => {
    const { text, mode } = e.detail;
    if (!text) return;

    // 1. 채팅 패널 열기 (숨겨져 있을 경우)
    // ※ 주의: 본인의 HTML ID에 맞게 수정 필요 (보통 chat-container 또는 chat-sidebar)
    const chatContainer = document.getElementById('chat-messages')?.parentElement; 
    const toggleBtn = document.getElementById('chat-toggle-btn'); // 토글 버튼 ID
    
    // 채팅창이 안 보이면 토글 버튼 클릭해서 열기
    if (chatContainer && (chatContainer.style.display === 'none' || chatContainer.classList.contains('hidden'))) {
        if(toggleBtn) toggleBtn.click();
    }

    // 2. 채팅 입력창에 텍스트 넣기
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.value = text;
        chatInput.focus(); // 포커스 이동 (타이핑 준비)
    }

    // 3. 자동으로 전송 버튼 누르기 (0.5초 뒤)
    setTimeout(() => {
        const sendBtn = document.getElementById('chat-send-btn');
        // 모드 변경이 필요하면 여기서 select 변경 로직 추가 가능
        if (sendBtn) sendBtn.click();
    }, 500);
});