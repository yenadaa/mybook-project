// main.js
import * as renderer from './viewer-renderer.js'; 
import { 
    getCurrentUser, 
    initDocSystem, 
    createDocFromFile, 
    openDoc, 
    deleteDocFromDb, 
    getCurrentBookId
} from './doc_firebase.js'; 
import { httpsCallable, functions } from './A.firebase.js';

import { PROMPTS } from './viewer-personas.js';
console.log("✅ main.js 스크립트 파일 로드됨");

// --- 팝업창 표시 함수들 ---

function showQuizModal(content, isLoading = false, isError = false, loadingText = "AI가 퀴즈를 생성하고 있습니다...") {
    const quizModalOverlay = document.getElementById("quiz-modal-overlay");
    const quizModalBody = document.getElementById("quiz-modal-body");
    if (!quizModalOverlay || !quizModalBody) {
        console.error("❌ showQuizModal: 'quizModalOverlay' 또는 'quizModalBody'를 찾을 수 없습니다.");
        return;
    }
    quizModalBody.innerHTML = '';

    if (isLoading) {
        quizModalBody.innerHTML = `
            <div class="loading-container">
            <div class="spinner"></div>
            <div class="loading-text">${loadingText}</div>
            </div>
        `;
    } else if (isError) {
        quizModalBody.innerHTML = `
            <div class="loading-container">
            <div style="font-size: 48px;">❌</div>
            <div class="loading-text" style="color: #d9534f;">${loadingText || '오류가 발생했습니다. 다시 시도해주세요.'}</div>
            </div>
        `;
    } else {
        quizModalBody.innerHTML = content;
    }
    quizModalOverlay.classList.remove('hidden');
}

function hideQuizModal() {
    const quizModalOverlay = document.getElementById("quiz-modal-overlay");
    if (quizModalOverlay) {
        quizModalOverlay.classList.add('hidden');
    }
}

function showFullDocQuiz(data, saveResult) {
    if (!data || (!data.summaries?.summary && (!data.review || (!data.review.ox?.length && !data.review.short?.length && !data.review.discussion?.length)))) {
        showQuizModal(null, false, true, "AI가 퀴즈를 생성할 내용을 찾지 못했습니다.");
        return;
    }
    
    const { summaries, review } = data;
    let feedbackHtml = '';
    if (saveResult) {
        const total = (saveResult.saved?.length || 0) + (saveResult.skipped?.length || 0);
        const savedCount = saveResult.saved?.length || 0;
        const skippedCount = saveResult.skipped?.length || 0;
        if (total > 0) {
            feedbackHtml = `
                <div class="save-feedback">
                    총 ${total}개 퀴즈 생성 완료 (신규 저장: ${savedCount}개 / 유사 중복: ${skippedCount}개)
                </div>
            `;
        }
    }

    let html = `<h1>AI 분석 결과</h1>${feedbackHtml}`;

    if (summaries && summaries.summary) {
        html += `
            <div class="summary-section">
                <h2>AI 생성 요약</h2>
                <p>${summaries.summary.replace(/\n/g, '<br>')}</p>
            </div>
            <hr>
        `;
    }

    if (review) {
        html += '<h2>AI 생성 퀴즈</h2>';
        if (review.ox && review.ox.length > 0) {
            html += '<h3>OX 퀴즈</h3>';
            html += review.ox.map((item, i) => `
                <div class="quiz-item" data-answer="${item.answer}">
                    <p class="quiz-question">${i+1}. ${item.q}</p>
                    <ul class="quiz-options"><li>true</li><li>false</li></ul>
                </div>
            `).join(''); 
        }
        if (review.short && review.short.length > 0) {
            html += '<h3>단답형 퀴즈</h3>';
            html += review.short.map((item, i) => `
                <div class="quiz-item short-answer-item" data-answer="${item.answer}">
                    <p class="quiz-question">${i + 1}. ${item.q}</p>
                    <div class="short-answer-container">
                        <input type="text" class="short-answer-input" placeholder="정답을 입력하세요.">
                        <button class="check-answer-btn">정답 확인</button>
                    </div>
                    <p class="answer-feedback hidden">정답: ${item.answer}</p>
                </div>
            `).join('');
        }
        
        if (review.discussion) {
            review.discussion.forEach((item, i) => {
                html += `
                    <div class="quiz-item discussion-item">
                        <p class="quiz-question">Q${i+1}. (서술) ${item.q}</p>
                        <div class="discussion-input-container">
                            <textarea class="discussion-input" placeholder="답변을 입력하세요..."></textarea>
                        </div>
                        <div class="quiz-actions">
                            <button class="submit-discussion-btn">정답 제출 & 채점</button>
                            
                            ${item.hint ? `
                                <button class="hint-button" style="margin-left:10px; background:#f3f4f6; color:#333;">💡 힌트 보기</button>
                                <div class="hint-content" style="display:none; margin-top:10px; padding:10px; background:#fffbeb; border:1px solid #fcd34d; border-radius:5px; color:#92400e;">
                                    ${item.hint}
                                </div>
                            ` : ''}
                        </div>
                    </div>`;
            });
        }
    }
    showQuizModal(html);
}

async function handleDiscussionSubmit(submitButton) {
    const quizItem = submitButton.closest('.quiz-item');
    const textarea = quizItem.querySelector('.discussion-input');
    const answer = textarea.value.trim();
    const questionText = quizItem.querySelector('.quiz-question').textContent;

    if (!answer) 
        return alert("답변을 입력해주세요.");

    const bookId = getCurrentBookId();
    const user = getCurrentUser();

    if (!bookId || !user) return alert("로그인이 필요합니다.");

    submitButton.disabled = true;
    submitButton.textContent = "제출 중...";

    try {
        const scoreDiscussionAnswer = httpsCallable(functions, 'scoreDiscussionAnswer');
        const result = await scoreDiscussionAnswer({
            question: questionText,
            user_answer: answer
        });
        
        const { score, feedback } = result.data;

        const feedbackDiv = document.createElement('div');
        feedbackDiv.className = 'grading-result';
        feedbackDiv.style.cssText = "margin-top:10px; padding:10px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:6px;";
        feedbackDiv.innerHTML = `
            <div style="font-weight:bold; color:#166534; margin-bottom:4px;">💯 점수: ${score} / 10</div>
            <div style="font-size:14px; color:#374151;">${feedback}</div>
        `;
        
        quizItem.querySelector('.discussion-input-container').appendChild(feedbackDiv);

        submitButton.textContent = "채점 완료";
        textarea.disabled = true;

    } catch (e) {
        console.error("채점 실패:", e);
        alert("채점 중 오류가 발생했습니다.");
        submitButton.disabled = false;
        submitButton.textContent = "정답 제출";
    }
}

// ⭐️ 챗봇 변수
let chatbotInitialized = false;
let chatHistory = [];

// DOM 로드 후 UI 이벤트 핸들러 연결
document.addEventListener('DOMContentLoaded', () => {
    console.log("✅ main.js DOMContentLoaded 이벤트 발생");

    const modalFullDocBtn = document.getElementById('modal-full-doc-btn');
    const modalHighlightsBtn = document.getElementById('modal-highlights-btn');     

    // --- 퀴즈 생성 로직 ---
    modalHighlightsBtn?.addEventListener('click', async () => {
        const bookId = getCurrentBookId();
        const user = getCurrentUser();

        if (!bookId || !user) {
            console.warn("하이라이트 퀴즈 생성 중단: bookId 또는 user가 없습니다.");
            return alert("퀴즈를 만들 문서를 먼저 열어주세요.");
        }

        showQuizModal(null, true, false, "미리 생성된 하이라이트 퀴즈 로드 중...");
    
        try {
            const generateCustomReview = httpsCallable(functions, 'generateCustomReview');
            const result = await generateCustomReview({ bookId });
            const resultData = result.data; 

            console.log("🔥 전체 데이터:", resultData);
            console.log("🔥 Discussion 데이터:", resultData?.review?.discussion);

            if (resultData?.review?.discussion?.length > 0) {
                console.log("🔥 첫 번째 문제 힌트:", resultData.review.discussion[0].hint);
            }

            const items = [];
            if (resultData?.review?.ox) {
                resultData.review.ox.forEach(it =>
                    items.push({ type: 'ox', q: it.q, answer: String(it.answer), sources: it.sources || [], tags: it.tags || [] })
                );
            }
            if (resultData?.review?.short) {
                resultData.review.short.forEach(it =>
                    items.push({ type: 'short', q: it.q, answer: it.answer || "", sources: it.sources || [], tags: it.tags || [] })
                );
            }
            if (resultData?.review?.discussion) {
                resultData.review.discussion.forEach(it =>items.push({ type: 'discussion', q: it.q, hint: it.hint || '힌트가 없습니다.', sources: it.sources || [], tags: it.tags || [] }));
            }
    
            const saveQuizItems = httpsCallable(functions, 'saveQuizItems');
            const saved = await saveQuizItems({ bookId, scope: 'highlight', items });
    
            showFullDocQuiz(resultData, saved.data);
            
        } catch (error) {
            console.error("하이라이트 퀴즈 생성 오류:", error);
            let errorMessage = error.message;
            if (error.code === 'functions/deadline-exceeded') {
                errorMessage = "AI 서버가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.";
            } else if (error.code === 'functions/aborted' || error.code === 'functions/not-found') {
                errorMessage = "PDF가 아직 처리 중입니다. 1~2분 후 다시 시도해 주세요.";
            }
            showQuizModal(null, false, true, `오류가 발생했습니다: ${errorMessage}`);
        }
    });

    modalFullDocBtn?.addEventListener('click', async () => {        
        const bookId = getCurrentBookId();
        const user = getCurrentUser();
        if (!bookId || !user) {
            console.warn("전체 문서 퀴즈 생성 중단: bookId 또는 user가 없습니다.");
            return;
        }

        showQuizModal(null, true, false, "미리 생성된 전체 요약/퀴즈 로드 중...");
        
        try {
            const generateFullDocQuiz = httpsCallable(functions, 'generateFullDocQuiz');
            const result = await generateFullDocQuiz({ bookId });
            const data = result.data; 

           const items = [];
           if (data?.review?.ox) {
             data.review.ox.forEach(it => items.push({ type: 'ox', q: it.q, answer: String(it.answer), sources: it.sources || [], tags: it.tags || [] }));
           }
           if (data?.review?.short) {
             data.review.short.forEach(it => items.push({ type: 'short', q: it.q, answer: it.answer || "", sources: it.sources || [], tags: it.tags || [] }));
           }
           if (data?.review?.discussion) {
             data.review.discussion.forEach(it => items.push({ type: 'discussion', q: it.q, hint: it.hint, sources: it.sources || [], tags: it.tags || [] }));
           }

           const saveQuizItems = httpsCallable(functions, 'saveQuizItems');
           const saved = await saveQuizItems({ bookId, scope: 'full', items });
           console.log('saveQuizItems:', saved.data);

           showFullDocQuiz(data, saved.data);

        } catch (error) {
            console.error("전체 문서 퀴즈 생성 과정 오류:", error);
            let errorMessage = error.message;
            if (error.code === 'functions/deadline-exceeded') {
                errorMessage = "AI 서버가 응답하지 않습니다. (시간 초과) 잠시 후 다시 시도해 주세요.";
            } else if (error.code === 'functions/aborted' || error.code === 'functions/not-found') {
                errorMessage = "PDF가 아직 처리 중입니다. 1~2분 후 다시 시도해 주세요.";
            }
            showQuizModal(null, false, true, `오류가 발생했습니다: ${errorMessage}`);
        }
    });

    // --- 퀴즈 결과 팝업 관련 이벤트 핸들러 ---
    document.getElementById("quiz-close-btn")?.addEventListener("click", hideQuizModal);
    document.getElementById("quiz-modal-overlay")?.addEventListener("click", (e) => {
        if (e.target === document.getElementById("quiz-modal-overlay")) hideQuizModal();
    });

    // 퀴즈 정답 확인 로직
    document.getElementById("quiz-modal-body")?.addEventListener('click', (e) => {
        const target = e.target;
        const optionLI = target.closest('li');

        if (target.matches('.hint-button')) {
            const hintContent = target.nextElementSibling;
            if (hintContent && hintContent.classList.contains('hint-content')) {
                const isHidden = hintContent.style.display === 'none';
                hintContent.style.display = isHidden ? 'block' : 'none';
                target.textContent = isHidden ? '💡 힌트 숨기기' : '💡 힌트 보기';
            }
            return;
        }

        if (target.matches('.submit-discussion-btn')) {
            handleDiscussionSubmit(target);
            return;
        }

        if (optionLI && optionLI.parentElement.classList.contains('quiz-options')) {
            const quizItem = optionLI.closest('.quiz-item');
            if (!quizItem || quizItem.classList.contains('answered')) return;
            const correctAnswer = String(quizItem.dataset.answer).toLowerCase();
            const selectedAnswer = optionLI.textContent.toLowerCase();
            const options = quizItem.querySelectorAll('.quiz-options li');
            quizItem.classList.add('answered');
            if (selectedAnswer === correctAnswer) {
                optionLI.classList.add('correct');
            } else {
                optionLI.classList.add('incorrect');
                options.forEach(opt => {
                    if (opt.textContent.toLowerCase() === correctAnswer) {
                        opt.classList.add('correct');
                    }
                });
            }
            options.forEach(opt => opt.classList.add('disabled'));
        }
        else if (target.matches('.check-answer-btn')) {
            const quizItem = target.closest('.quiz-item');
            if (!quizItem || quizItem.classList.contains('answered')) return;
            const correctAnswer = quizItem.dataset.answer;
            const input = quizItem.querySelector('.short-answer-input');
            const userAnswer = input.value.trim();
            const feedback = quizItem.querySelector('.answer-feedback');
            quizItem.classList.add('answered');
            input.disabled = true;
            target.disabled = true;
            feedback.classList.remove('hidden');
            if (userAnswer.replace(/\s/g, '').toLowerCase() === correctAnswer.replace(/\s/g, '').toLowerCase()) {
                input.classList.add('correct');
            } else {
                input.classList.add('incorrect');
            }
        }
    });

    // ⭐️ 챗봇 초기화 실행
    initChatbot();

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/firebase-messaging-sw.js')
        .then((registration) => {
            console.log('✅ Service Worker 등록 성공:', registration.scope);
        })
        .catch((err) => {
            console.error('❌ Service Worker 등록 실패:', err);
        });
    }

    const viewerEl = document.querySelector('.viewer');
    if (viewerEl) {
        viewerEl.addEventListener('scroll', renderer.onScrollUpdatePage); 
    }

}); 

// ⭐️ 챗봇 로직 (내부 중복 정의 삭제됨)
function initChatbot() {
    if (chatbotInitialized) return;
    chatbotInitialized = true;

    const $ = (id) => document.getElementById(id);

    const chatToggleBtn = $("chat-toggle-btn");
    const chatWindow = $("chat-window");
    const chatCloseBtn = $("chat-close-btn");
    const chatMessages = $("chat-messages");
    const chatInput = $("chat-input");
    const chatSendBtn = $("chat-send-btn");

    if (!chatToggleBtn || !chatWindow || !chatCloseBtn || !chatMessages || !chatInput || !chatSendBtn) {
        return;
    }

    // 챗봇 창 열기
    chatToggleBtn.addEventListener("click", () => {
        chatWindow.classList.toggle("hidden");
        chatToggleBtn.classList.toggle("hidden");
    });

    // 챗봇 창 닫기
    chatCloseBtn.addEventListener("click", () => {
        chatWindow.classList.add("hidden");
        chatToggleBtn.classList.remove("hidden");
    });

    // 메시지 전송 버튼 클릭
    chatSendBtn.addEventListener("click", handleSendChatMessage);

    // Enter 키로 전송
    chatInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSendChatMessage();
        }
    });

    async function handleSendChatMessage() {
        const userText = chatInput.value.trim();
        if (!userText || chatSendBtn.disabled) return;

        // 1. (UI) 사용자 메시지 추가
        addChatMessage('user', userText);
        chatInput.value = "";
        
        // 2. 채팅 내역 업데이트
        chatHistory.push({ role: "user", content: userText });

        // 3. (UI) 로딩 메시지
        const loadingMsgId = `msg-${Date.now()}`;
        const loadingElement = addChatMessage('bot', '답변을 생성 중입니다...', 'loading', loadingMsgId);

        // 4. bookId 확인
        const currentBookId = getCurrentBookId();

        if (!currentBookId) {
            updateChatMessage(loadingElement, "오류: 먼저 문서를 열어주세요.");
            chatHistory.pop(); 
            return;
        }

        try {
            // 페르소나 파일에서 프롬프트 가져오기
            const personaSelect = document.getElementById("chat-persona-select");
            const selectedKey = personaSelect ? personaSelect.value : 'professor';

            let systemPromptText = "";
            switch (selectedKey) {
                case "socrates": 
                    systemPromptText = PROMPTS.socrates_v3;
                    break;
                case "senior":   
                    systemPromptText = PROMPTS.applier_v1;
                    break;
                case "professor":
                default:
                    systemPromptText = PROMPTS.builder_v3;
                    break;
            }

            const botAnswer = await window.sendQueryToBot(currentBookId, chatHistory, systemPromptText);
            
            updateChatMessage(loadingElement, botAnswer);
            chatHistory.push({ role: "assistant", content: botAnswer });

        } catch (error) {
            console.error("챗봇 메시지 전송 중 오류:", error);
            updateChatMessage(loadingElement, "답변 생성 중 오류가 발생했습니다.");
            chatHistory.pop(); 
        }
    }
}

// ✅ [수정] 메시지 추가 함수 (마크다운 + 수식 렌더링 기능 추가)
function addChatMessage(sender, text, type, id) {
    const msgDiv = document.createElement("div");
    msgDiv.classList.add("chat-message", sender);
    if (type === 'loading') {
        msgDiv.classList.add("loading");
    }
    if (id) {
        msgDiv.id = id;
    }

    // 1. 텍스트 포맷팅 (간단한 마크다운 처리)
    let formattedText = text
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>') // 볼드체 처리
        .replace(/\n/g, '<br>'); // 줄바꿈 처리

    const p = document.createElement("p");
    p.innerHTML = formattedText;
    msgDiv.appendChild(p);

    const chatMessages = document.getElementById("chat-messages");
    if (chatMessages) {
        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // 2. ⭐️ [핵심] MathJax에게 "방금 추가된 수식을 예쁘게 그려줘"라고 명령
    if (window.MathJax && type !== 'loading') {
        window.MathJax.typesetPromise([p]).then(() => {
            if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
        }).catch((err) => console.log('수식 렌더링 에러:', err));
    }

    return msgDiv;
}

// ✅ [수정] 챗봇 답변 업데이트 함수 (여기에 MathJax가 꼭 있어야 함!)
function updateChatMessage(element, newText) {
    if (element) {
        element.classList.remove("loading");
        
        const p = element.querySelector("p");
        if (p) {
            let formattedText = newText
                .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>') 
                .replace(/\n/g, '<br>');

            p.innerHTML = formattedText; 

            if (window.MathJax) {
                window.MathJax.typesetPromise([p]).then(() => {
                    const chatMessages = document.getElementById("chat-messages");
                    if (chatMessages) {
                        chatMessages.scrollTop = chatMessages.scrollHeight;
                    }
                }).catch((err) => {
                    console.warn('MathJax 렌더링 오류(무시 가능):', err);
                });
            }
        }

        const chatMessages = document.getElementById("chat-messages");
        if (chatMessages) {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
    }
}

// ⭐️ [복구] 전역 노출 함수
window.setChatbotEnabled = function(enabled) {
    const chatInput = document.getElementById("chat-input");
    const chatSendBtn = document.getElementById("chat-send-btn");

    if (chatInput && chatSendBtn) {
        chatInput.disabled = !enabled;
        chatSendBtn.disabled = !enabled;
        
        if (enabled) {
            chatHistory = []; 
            chatInput.placeholder = "현재 문서에 대해 질문하세요...";
            const chatMessages = document.getElementById("chat-messages");
            if (chatMessages) {
                chatMessages.innerHTML = `
                    <div class="chat-message bot">
                        <p>안녕하세요! 현재 열려있는 문서에 대해 무엇이든 물어보세요.</p>
                    </div>
                `;
            }
        } else {
            chatInput.placeholder = "문서를 먼저 열어주세요.";
            chatInput.value = "";
        }
    }
}

// ⭐️ 알림 테스트용
window.testNoti = async function() {
    console.log("🚀 알림 강제 발송 요청 중...");
    const { httpsCallable, functions } = await import('./A.firebase.js'); 
    
    const trigger = httpsCallable(functions, 'testTriggerNotifications');
    
    try {
        const result = await trigger();
        console.log("✅ 결과:", result.data.message);
        alert(`성공! ${result.data.message}`);
    } catch (e) {
        console.error("❌ 실패:", e);
        alert("에러 발생 (콘솔 확인)");
    }
};

// 🚀 [추가] 홈 화면에서 "열기" 눌렀을 때 문서 자동 로드 기능
import { auth } from './A.firebase.js'; 

auth.onAuthStateChanged(async (user) => {
    if (!user) return;
    const params = new URLSearchParams(window.location.search);
    const docId = params.get('docId');

    if (docId) {
        console.log(`🚀 [Auto-Load] 문서 ID 감지: ${docId}`);
        if (typeof openDoc === 'function') {
             setTimeout(async () => {
                await openDoc(docId); 
            }, 500);
        } else {
             const mod = await import('./doc_firebase.js');
             if(mod.openDoc) mod.openDoc(docId);
        }
    }
});