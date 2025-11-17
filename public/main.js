import { 
    getCurrentUser, 
    initDocSystem, 
    createDocFromFile, 
    openDoc,
    deleteDocFromDb, 
    getCurrentBookId
} from './doc_firebase.js'; // ⭐️ './doc_firebase.js'를 사용
import { httpsCallable, functions } from './A.firebase.js';

// ⛔️ [삭제] 'getHighlights' import를 삭제 (SyntaxError의 원인)
// import { getHighlights } from './viewer-state.js'; 

console.log("✅ main.js 스크립트 파일 로드됨");

// ⭐️ [챗봇] 챗봇 UI 초기화 여부 플래그
let chatbotInitialized = false;
// ⭐️ [챗봇] 채팅 내역 저장 배열
let chatHistory = [];

// DOM 로드 후 UI 이벤트 핸들러 연결
document.addEventListener('DOMContentLoaded', () => {
    console.log("✅ main.js DOMContentLoaded 이벤트 발생");

    // --- HTML 요소 가져오기 ---
    const createQuizBtn = document.getElementById('create-quiz-btn');
    const quizOptionsModal = document.getElementById('quiz-options-modal');
    const modalFullDocBtn = document.getElementById('modal-full-doc-btn');
    const modalHighlightsBtn = document.getElementById('modal-highlights-btn');
    const modalCloseBtn = document.getElementById('modal-close-btn');
    
    const quizModalOverlay = document.getElementById("quiz-modal-overlay");
    const quizModalBody = document.getElementById("quiz-modal-body");
    const quizCloseBtn = document.getElementById("quiz-close-btn");

    // ... (버튼/모달 찾기 null 체크 - 기존 코드 유지) ...

    // --- 퀴즈 생성 로직 ---
    if (createQuizBtn) {
        createQuizBtn.addEventListener('click', () => {
            console.log("🖱️ '퀴즈 만들기' 버튼 클릭됨!"); 
            const bookId = getCurrentBookId();
            console.log("현재 열린 bookId:", bookId); 
            if (!bookId) {
                return alert("퀴즈를 만들 문서를 먼저 열어주세요.");
            }
            if (quizOptionsModal) { 
                console.log("퀴즈 옵션 모달을 엽니다."); 
                quizOptionsModal.classList.remove('hidden');
            } else {
                console.error("❌ 'quiz-options-modal'이 없어서 퀴즈 옵션을 열 수 없습니다.");
            }
        });
    }

    modalCloseBtn?.addEventListener('click', () => {
        quizOptionsModal?.classList.add('hidden');
    });

    modalHighlightsBtn?.addEventListener('click', async () => {
    
        quizOptionsModal?.classList.add('hidden');
        const bookId = getCurrentBookId();
        const user = getCurrentUser();

        if (!bookId || !user) {
            console.warn("하이라이트 퀴즈 생성 중단: bookId 또는 user가 없습니다.");
            return alert("퀴즈를 만들 문서를 먼저 열어주세요.");
        }

        // ⭐️ [수정] 님이 18:31에 올리신 '하이라이트' 버튼은 'customReviewPayload'를 읽으므로,
        // ⭐️ 로딩 메시지를 "미리 생성된 퀴즈 로드 중..."으로 변경 (1초 만에 뜸)
        showQuizModal(null, true, false, "미리 생성된 하이라이트 퀴즈 로드 중...");
    
        try {
            // ⭐️ '파이프라인'을 사용하므로 9분 타임아웃은 필요 없습니다. (기본 60초)
            const generateCustomReview = httpsCallable(functions, 'generateCustomReview');
            
            // ⭐️ [수정] 'chunkIds'와 'counts'를 보내지 않습니다. (파이프라인 버전이므로)
            const result = await generateCustomReview({ bookId });
            
            // ⭐️ [수정] 'result.data'가 서버가 보낸 payload입니다. (result.data.result 아님)
            const resultData = result.data; 

            // (items 가공 - 기존 코드 유지)
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
                resultData.review.discussion.forEach(it =>
                    items.push({ type: 'discussion', q: it.q, sources: it.sources || [], tags: it.tags || [] })
                );
            }
    
            // (DB에 저장 - 기존 코드 유지)
            const saveQuizItems = httpsCallable(functions, 'saveQuizItems');
            const saved = await saveQuizItems({ bookId, scope: 'highlight', items });
    
            // (결과 렌더링 - 'resultData' 전달)
            showFullDocQuiz(resultData, saved.data);
            
        } catch (error) {
            // (오류 처리 - 기존 코드 유지)
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
        quizOptionsModal?.classList.add('hidden');
        
        const bookId = getCurrentBookId();
        const user = getCurrentUser();
        if (!bookId || !user) {
            console.warn("전체 문서 퀴즈 생성 중단: bookId 또는 user가 없습니다.");
            return;
        }

        // ⭐️ [수정] "미리 생성된 요약 로드 중..." (1초 만에 뜸)
        showQuizModal(null, true, false, "미리 생성된 전체 요약/퀴즈 로드 중...");
        
        try {
            // ⭐️ '파이프라인'을 사용하므로 9분 타임아웃은 필요 없습니다.
            const generateFullDocQuiz = httpsCallable(functions, 'generateFullDocQuiz');
            const result = await generateFullDocQuiz({ bookId });
            
            // ⭐️ [수정] 'result.data'가 서버가 보낸 payload입니다. (result.data.result 아님)
            const data = result.data; 

           // (items 가공 - 기존 코드 유지)
           const items = [];
           if (data?.review?.ox) {
             data.review.ox.forEach(it => items.push({ type: 'ox', q: it.q, answer: String(it.answer), sources: it.sources || [], tags: it.tags || [] }));
           }
           if (data?.review?.short) {
             data.review.short.forEach(it => items.push({ type: 'short', q: it.q, answer: it.answer || "", sources: it.sources || [], tags: it.tags || [] }));
           }
           if (data?.review?.discussion) {
             data.review.discussion.forEach(it => items.push({ type: 'discussion', q: it.q, sources: it.sources || [], tags: it.tags || [] }));
           }

           // (저장 - 기존 코드 유지)
           const saveQuizItems = httpsCallable(functions, 'saveQuizItems');
           const saved = await saveQuizItems({ bookId, scope: 'full', items });
           console.log('saveQuizItems:', saved.data);

            // ⭐️ 'data' (result.data)를 렌더링
            showFullDocQuiz(data, saved.data);

        } catch (error) {
            // (오류 처리 - 기존 코드 유지)
            console.error("전체 문서 퀴즈 생성 과정 오류:", error);
            let errorMessage = error.message;
            if (error.code === 'functions/deadline-exceeded') {
                errorMessage = "AI 서버가 응답하지 않습니다. (시간 초과) 잠시 후 다시 시도해 주세요.";
            } else if (error.code === 'functions/aborted' || error.code === 'functions/not-found') {
                // ⭐️ 404, aborted 오류는 "파이프라인 처리 중"이라는 뜻
                errorMessage = "PDF가 아직 처리 중입니다. 1~2분 후 다시 시도해 주세요.";
            }
            showQuizModal(null, false, true, `오류가 발생했습니다: ${errorMessage}`);
        }
    });

    // --- 퀴즈 결과 팝업 관련 이벤트 핸들러 ---
    
    quizCloseBtn?.addEventListener("click", hideQuizModal);
    quizModalOverlay?.addEventListener("click", (e) => {
        if (e.target === quizModalOverlay) hideQuizModal();
    });

    // 퀴즈 정답 확인 로직
    quizModalBody?.addEventListener('click', (e) => {
        const target = e.target;
        const optionLI = target.closest('li');

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

    // --- 팝업창 표시 함수들 ---

    function showQuizModal(content, isLoading = false, isError = false, loadingText = "AI가 퀴즈를 생성하고 있습니다...") {
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
        if (quizModalOverlay) {
            quizModalOverlay.classList.add('hidden');
        }
    }

    function showFullDocQuiz(data, saveResult) {
        
        // (님이 18:31에 올린 코드 - 'summary'로 이미 수정됨)
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

        // (님이 18:31에 올린 코드 - 'summary'로 이미 수정됨)
        if (summaries && summaries.summary) {
            html += `
                <div class="summary-section">
                    <h2>AI 생성 요약</h2>
                    <p>${summaries.summary.replace(/\n/g, '<br>')}</p>
                </div>
                <hr>
            `;
        }

        // (이하 퀴즈 렌더링 HTML은 님이 18:31에 올린 코드와 동일)
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
                            <input type="text" class="short-answer-input" placeholder="정답을 입력하세요">
                            <button class="check-answer-btn">정답 확인</button>
                        </div>
                        <p class="answer-feedback hidden">정답: ${item.answer}</p>
                    </div>
                `).join('');
            }
            if (review.discussion && review.discussion.length > 0) {
                html += '<h3>서술형/토론</h3>';
                html += review.discussion.map((item, i) => `
                    <div class="quiz-item discussion-item">
                        <p class="quiz-question">${i + 1}. ${item.q}</p>
                        <p class="discussion-hint">💡 힌트: ${item.hint}</p>
                    </div>
                `).join('');
            }
        }
        showQuizModal(html);
    }
    
    // ⭐️ [챗봇] 챗봇 UI 초기화 함수 호출
    initChatbot();

}); // ✨ DOMContentLoaded가 여기서 끝납니다.

// 
// 
// 
// --- ⭐️ [챗봇] 챗봇 관련 함수들 (파일 하단에 추가) ---
// 
// 
// 
/**
 * 챗봇 UI의 모든 이벤트 리스너를 설정합니다.
 */
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
        console.warn("챗봇 UI 요소를 찾을 수 없어 초기화에 실패했습니다.");
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

    /**
     * 채팅 메시지를 전송하는 핸들러
     */
    async function handleSendChatMessage() {
        const userText = chatInput.value.trim();
        if (!userText || chatSendBtn.disabled) return;

        // 1. (UI) 사용자 메시지 추가
        addChatMessage('user', userText);
        chatInput.value = "";
        
        // 2. [수정] 채팅 내역 배열에 사용자 메시지 추가
        chatHistory.push({ role: "user", content: userText });

        // 3. (UI) 로딩 메시지 추가
        const loadingMsgId = `msg-${Date.now()}`;
        const loadingElement = addChatMessage('bot', '답변을 생성 중입니다...', 'loading', loadingMsgId);

        // 4. (Logic) doc_firebase.js에서 현재 bookId 가져오기
        const currentBookId = getCurrentBookId();

        if (!currentBookId) {
            updateChatMessage(loadingElement, "오류: 먼저 문서를 열어주세요.");
            chatHistory.pop(); // [수정] 실패 시, 보냈던 메시지 내역에서 제거
            return;
        }

        try {
            
            // 👇 [수정 1] 페르소나 선택 <select>에서 값 읽어오기
            const personaSelect = document.getElementById("chat-persona-select");
            const selectedValue = personaSelect.value; // "professor", "socrates" 등

            // 👇 [수정 2] 백엔드가 이해하는 '전체 프롬프트 텍스트'로 변환
            const personaMap = {
                "professor": "당신은 '해설형 챗봇(교수)'입니다. 사용자의 질문에 대해 교수의 입장에서 친절하고 상세하게 설명해주세요.",
                "socrates": "당신은 '설명 유도형 챗봇(소크라테스)'입니다. 정답을 알려주지 말고, 사용자가 스스로 답을 찾도록 질문을 던지세요.",
                "senior": "당신은 '주변 정보형 챗봇(선배)'입니다. 질문과 관련된 재밌는 배경지식이나 팁을 친근하게 알려주세요."
            };
            const systemPromptText = personaMap[selectedValue] || personaMap["professor"];

            
            // ⭐️ window.sendQueryToBot은 doc_firebase.js에 정의되어 있음
            // 👇 [수정 3] systemPromptText를 함께 전달
            const botAnswer = await window.sendQueryToBot(currentBookId, chatHistory, systemPromptText);
            
            // 6. (UI) 로딩 메시지를 실제 답변으로 교체
            updateChatMessage(loadingElement, botAnswer);
            
            // 7. [수정] 채팅 내역 배열에 봇의 답변 추가
            chatHistory.push({ role: "assistant", content: botAnswer });

        } catch (error) {
            console.error("챗봇 메시지 전송 중 오류:", error);
            updateChatMessage(loadingElement, "답변 생성 중 오류가 발생했습니다.");
            chatHistory.pop(); // [수정] 실패 시, 보냈던 메시지 내역에서 제거
        }
    }

    /**
     * 채팅 메시지를 화면에 추가 (헬퍼 함수)
     * @param {'user' | 'bot'} sender
     * @param {string} text
     * @param {'loading' | undefined} type
     * @param {string | undefined} id
     * @returns {HTMLElement} 생성된 메시지 div 요소
     */
    function addChatMessage(sender, text, type, id) {
        const msgDiv = document.createElement("div");
        msgDiv.classList.add("chat-message", sender);
        if (type === 'loading') {
            msgDiv.classList.add("loading");
        }
        if (id) {
            msgDiv.id = id;
        }
        
        const p = document.createElement("p");
        p.textContent = text;
        msgDiv.appendChild(p);
        
        const chatMessages = document.getElementById("chat-messages");
        if (chatMessages) {
             chatMessages.appendChild(msgDiv);
             // 새 메시지로 스크롤
             chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        return msgDiv;
    }

    /**
     * 기존 메시지 내용을 업데이트 (로딩 -> 답변)
     * @param {HTMLElement} element
     * @param {string} newText
     */
    function updateChatMessage(element, newText) {
        if (element) {
            element.classList.remove("loading");
            const p = element.querySelector("p");
            if (p) {
                p.textContent = newText;
            }
             // 업데이트 후 스크롤
            const chatMessages = document.getElementById("chat-messages");
            if (chatMessages) {
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }
        }
    }
}

/**
 * ⭐️ [챗봇] 챗봇 활성화/비활성화
 * doc_firebase.js의 openDoc / resetToHome에서 호출합니다.
 * (window에 노출시켜야 doc_firebase.js에서 호출 가능)
 */
window.setChatbotEnabled = function(enabled) {
    const chatInput = document.getElementById("chat-input");
    const chatSendBtn = document.getElementById("chat-send-btn");

    if (chatInput && chatSendBtn) {
        chatInput.disabled = !enabled;
        chatSendBtn.disabled = !enabled;
        
        if (enabled) {
            // [수정] 새 문서가 열리면 채팅 내역 초기화
            chatHistory = []; 
            chatInput.placeholder = "현재 문서에 대해 질문하세요...";
            
            // (옵션) 챗봇 창의 기존 메시지 삭제
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