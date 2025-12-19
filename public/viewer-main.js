// viewer-main.js
console.log("TEST: viewer-main.js 스크립트 시작!");

// 1. 상태 및 UI 모듈 임포트
import './viewer-state.js';
import './viewer-ui.js'; 

// 2. 렌더링 및 하이라이트 함수 임포트
import { renderDocument, scrollToPage, clearDocument } from './viewer-renderer.js';
import { setHighlightsData } from './viewer-highlight-manager.js';

// 3. 챗봇 관련 임포트
import { PROMPTS } from './viewer-personas.js'; 
import { onBotMessageHook } from "./viewer-session-hooks.js";

// 4. 파이어베이스 연동 임포트
import { 
    saveChatMessageToDb, 
    loadChatHistoryFromDb, 
    clearChatHistoryInDb,
    getCurrentBookId 
} from './doc_firebase.js';

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
    const clearDataBtn = document.getElementById('clearData');
    if (clearDataBtn) {
        clearDataBtn.addEventListener('click', async () => {
            if (!confirm("모든 필기, 하이라이트, 그리고 대화 기록을 삭제하시겠습니까?")) return;
            
            // 전역 변수 window.currentBookId 또는 import한 함수 사용
            const bookId = window.currentBookId || getCurrentBookId();
            
            if (bookId) {
                // 1. 대화 기록 DB 삭제
                if (typeof clearChatHistoryInDb === 'function') {
                    await clearChatHistoryInDb(bookId);
                }

                // 2. 화면의 채팅창 비우기
                const chatMessages = document.getElementById("chat-messages");
                if (chatMessages) chatMessages.innerHTML = '';
                
                // 3. (선택) 하이라이트/필기 삭제 로직이 있다면 여기서 호출
                // if (window.clearDocument) window.clearDocument(); // 예시
                
                alert("모든 기록이 초기화되었습니다.");
            } else {
                alert("문서 정보를 찾을 수 없습니다.");
            }
        });
    }
    // =========================================
});

function initChatbot() {
    const chatInput = document.getElementById("chat-input");
    const chatSendBtn = document.getElementById("chat-send-btn");
    const personaSelect = document.getElementById("chat-persona-select");
    const chatMessages = document.getElementById("chat-messages");

    // 현재 모드의 대화 기록을 담을 변수
    window.localChatHistory = [];
    let isSending = false;

    if (!chatInput || !chatSendBtn) return;

    // 🚀 [핵심 기능] 특정 모드의 대화를 DB에서 가져와 화면에 그리기
    window.loadChatToUI = async function(bookId, personaKey) {
        if (!bookId || !personaKey) return;
        
        // 1. 화면 비우기 (새로운 모드를 위해 청소)
        if (chatMessages) chatMessages.innerHTML = '';
        window.localChatHistory = []; // 로컬 기록도 초기화

        // 2. 로딩 표시 (선택 사항)
        // addChatMessage('bot', '대화 기록을 불러오는 중...', 'loading');

        // 3. DB에서 해당 모드의 기록만 가져오기
        if (typeof loadChatHistoryFromDb === 'function') {
            const history = await loadChatHistoryFromDb(bookId, personaKey);
            
            // 4. 가져온 기록 화면에 뿌리기
            if (history && history.length > 0) {
                history.forEach(msg => {
                    const sender = (msg.role === 'user') ? 'user' : 'bot';
                    addChatMessage(sender, msg.content);
                    window.localChatHistory.push(msg); // 전송용 기록에 추가
                });
            } else {
                // 기록이 없으면 첫 인사말
                const modeName = personaSelect.options[personaSelect.selectedIndex].text;
                addChatMessage('bot', `반갑습니다! <b>${modeName}</b> 모드입니다.<br>무엇을 도와드릴까요?`);
            }
            
            // 스크롤 맨 아래로
            if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
        }
    };

    // 전송 버튼 리스너 교체
    const newBtn = chatSendBtn.cloneNode(true);
    chatSendBtn.parentNode.replaceChild(newBtn, chatSendBtn);
    const finalSendBtn = document.getElementById("chat-send-btn");

    // ⭐️ [이벤트] 모드(페르소나) 변경 시 -> 해당 모드의 대화 불러오기
    if (personaSelect) {
        personaSelect.addEventListener("change", () => {
            const newPersona = personaSelect.value;
            const bookId = window.currentBookId || (typeof getCurrentBookId === 'function' ? getCurrentBookId() : null);
            
            if (bookId) {
                // 즉시 교체 실행!
                window.loadChatToUI(bookId, newPersona);
            }
        });
    }

        // 🗑️ [채팅방 전용] 대화 지우기 버튼 기능
    const chatClearBtn = document.getElementById("chat-clear-btn");
    if (chatClearBtn) {
        chatClearBtn.addEventListener("click", async () => {
            // 1. 현재 어떤 모드인지 확인
            const personaSelect = document.getElementById("chat-persona-select");
            const currentPersona = personaSelect ? personaSelect.value : 'professor';
            const currentModeName = personaSelect ? personaSelect.options[personaSelect.selectedIndex].text : '현재 모드';

            // 2. 진짜 지울지 물어보기
            if (!confirm(`'${currentModeName}'의 대화 기록을 모두 삭제하시겠습니까?`)) return;

            const bookId = window.currentBookId || (typeof getCurrentBookId === 'function' ? getCurrentBookId() : null);

            if (bookId) {
                // 3. DB에서 삭제 (현재 모드만!)
                if (typeof clearChatHistoryInDb === 'function') {
                    await clearChatHistoryInDb(bookId, currentPersona);
                }

                // 4. 화면 비우기
                const chatMessages = document.getElementById("chat-messages");
                if (chatMessages) chatMessages.innerHTML = '';
                
                // 5. 로컬 기록 변수 초기화
                if (window.localChatHistory) window.localChatHistory = [];

                // 6. 안내 메시지 띄우기
                addChatMessage('bot', `🧹 <b>${currentModeName}</b> 대화 내용이 초기화되었습니다.`);
            }
        });
    }

    // ⭐️ 메시지 전송 함수
    async function handleSendMessage() {
        if (isSending) return; 

        const userText = chatInput.value.trim();
        if (!userText) return;

        isSending = true;
        finalSendBtn.disabled = true;

        // 현재 선택된 모드 확인
        const currentPersona = personaSelect ? personaSelect.value : 'professor';

        try {
            const currentId = window.currentBookId || (typeof getCurrentBookId === 'function' ? getCurrentBookId() : null);

            // 1. [UI] 사용자 메시지 표시
            addChatMessage('user', userText);
            chatInput.value = ""; 

            // 💾 [저장] 현재 모드(currentPersona) 방에 저장!
            const userMsgObj = { role: "user", content: userText, timestamp: Date.now() };
            window.localChatHistory.push(userMsgObj);
            
            if (currentId && typeof saveChatMessageToDb === 'function') {
                saveChatMessageToDb(currentId, userMsgObj, currentPersona); // 👈 persona 전달
            }

            // 2. [UI] 로딩 표시
            const loadingMsgId = `msg-${Date.now()}`;
            const loadingElement = addChatMessage('bot', '답변을 생성 중입니다...', 'loading', loadingMsgId);

            // 3. 프롬프트 선택
            let systemPromptText = "";
            switch (currentPersona) {
                case "socrates": systemPromptText = PROMPTS.socrates_v3; break;
                case "senior":   systemPromptText = PROMPTS.applier_v1; break;
                case "professor": default: systemPromptText = PROMPTS.builder_v3; break;
                case "general": systemPromptText = PROMPTS.general_v1; break;
            }

            // 4. 백엔드 전송
            if (window.sendQueryToBot) {
                if (!currentId) {
                    updateChatMessage(loadingElement, "오류: 문서를 먼저 열어주세요.");
                    return;
                }

                const botReply = await window.sendQueryToBot(currentId, window.localChatHistory, systemPromptText);
                
                if (botReply) {
                    updateChatMessage(loadingElement, botReply);
                    
                    // 💾 [저장] 답변도 현재 모드 방에 저장!
                    const botMsgObj = { role: "assistant", content: botReply, timestamp: Date.now() };
                    window.localChatHistory.push(botMsgObj);
                    
                    if (currentId && typeof saveChatMessageToDb === 'function') {
                        saveChatMessageToDb(currentId, botMsgObj, currentPersona); // 👈 persona 전달
                    }
                } else {
                    updateChatMessage(loadingElement, "답변을 받아오지 못했습니다.");
                }
            } else {
                updateChatMessage(loadingElement, "서버 통신 함수 오류");
            }

        } catch (err) {
            console.error("전송 실패:", err);
            const chatList = document.getElementById("chat-messages");
            if (chatList && chatList.lastElementChild && chatList.lastElementChild.classList.contains('loading')) {
                 updateChatMessage(chatList.lastElementChild, "오류가 발생했습니다.");
            }
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
}
// ============================================================
// ⭐️ [통합 렌더러] 버튼 + 수식 + 볼드체 모두 처리하는 함수들
// ============================================================

// 1. 메시지 추가 함수
function addChatMessage(sender, text, type, id) {
    const msgDiv = document.createElement("div");
    msgDiv.classList.add("chat-message", sender);
    if (type === 'loading') msgDiv.classList.add("loading");
    if (id) msgDiv.id = id;
    
    const p = document.createElement("p");
    
    // 🤖 봇 메시지: 링크 변환 + 볼드체 + 수식 적용
    if (sender === 'bot' || sender === 'assistant') {
        p.innerHTML = formatPageLink(text); 
    } else {
        // 👤 사용자 메시지
        p.textContent = text;
    }

    msgDiv.appendChild(p);
    
    const chatMessages = document.getElementById("chat-messages");
    if (chatMessages) {
        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // ⭐️ [핵심] MathJax에게 "수식 그려줘!" 명령
    if ((sender === 'bot' || sender === 'assistant') && type !== 'loading' && window.MathJax) {
        window.MathJax.typesetPromise([p]).then(() => {
            if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
        }).catch(err => console.warn('MathJax 렌더링 에러:', err));
    }

    return msgDiv;
}

// 2. 메시지 업데이트 함수 (스트리밍 답변용)
function updateChatMessage(element, newText) {
    if (element) {
        element.classList.remove("loading");
        const p = element.querySelector("p");
        
        if (p) {
            // 🤖 봇 메시지 업데이트
            if (element.classList.contains('bot') || element.classList.contains('assistant')) {
                p.innerHTML = formatPageLink(newText); // 포맷팅 적용

                // ⭐️ [핵심] 내용이 바뀔 때마다 MathJax 다시 실행
                if (window.MathJax) {
                    window.MathJax.typesetPromise([p]).then(() => {
                        const chatMessages = document.getElementById("chat-messages");
                        if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
                    }).catch(err => console.warn('MathJax 에러(무시 가능):', err));
                }

            } else {
                p.textContent = newText;
            }
        }
        
        const chatMessages = document.getElementById("chat-messages");
        if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    }
}

// 3. 텍스트 포맷팅 함수 (버튼 + 볼드 + 줄바꿈)
function formatPageLink(text) {
    // (1) 페이지 링크 주변의 ** 제거 (버튼 깨짐 방지: **p.12** -> p.12)
    let cleanText = text.replace(/\*\*(p\.\s*\d+|page\s*\d+|페이지\s*\d+)\*\*/gi, '$1');

    // (2) 일반 텍스트 볼드체 처리 (**강조** -> <b>강조</b>)
    cleanText = cleanText.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');

    // (3) 줄바꿈 처리
    cleanText = cleanText.replace(/\n/g, '<br>');

    // (4) 페이지 링크 버튼 변환 ("p.12" -> <button...>)
    const regex = /(?:p\.|page|페이지)\s*(\d+)/gi;
    return cleanText.replace(regex, (match, pageNum) => {
        return `<button onclick="window.moveToPage(${pageNum})" 
                style="color:#2563eb; background:#eff6ff; border:none; padding:2px 6px; border-radius:4px; cursor:pointer; font-weight:bold; font-size:0.9em; margin:0 2px; vertical-align:middle;">
                📄 ${pageNum}p 이동
                </button>`;
    });
}

// 페이지 이동 함수
window.moveToPage = function(pageNum) {
    console.log(`🚀 챗봇 요청으로 ${pageNum}페이지로 이동합니다.`);
    if (typeof scrollToPage === 'function') { 
        scrollToPage(parseInt(pageNum));
    } else {
        console.error("scrollToPage 함수를 찾을 수 없습니다.");
    }
};

// [추가] 외부 트리거
document.addEventListener('triggerChatQuery', (e) => {
    const { text, mode } = e.detail;
    if (!text) return;

    const chatContainer = document.getElementById('chat-messages')?.parentElement; 
    const toggleBtn = document.getElementById('chat-toggle-btn'); 
    
    if (chatContainer && (chatContainer.style.display === 'none' || chatContainer.classList.contains('hidden'))) {
        if(toggleBtn) toggleBtn.click();
    }

    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.value = text;
        chatInput.focus(); 
    }

    setTimeout(() => {
        const sendBtn = document.getElementById('chat-send-btn');
        if (sendBtn) sendBtn.click();
    }, 500);
});