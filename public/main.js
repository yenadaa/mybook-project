import { 
    getCurrentUser, 
    initDocSystem, 
    createDocFromFile, 
    openDoc,
    deleteDocFromDb, 
    getCurrentBookId
} from './doc_firebase.js';
import { httpsCallable, functions } from './A.firebase.js';

console.log("✅ main.js 스크립트 파일 로드됨");

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

    // --- [디버깅 1] 버튼과 모달을 제대로 찾았는지 확인 ---
    if (!createQuizBtn) {
        console.error("❌ main.js: HTML에서 'create-quiz-btn' ID를 가진 버튼을 찾을 수 없습니다!");
    }
    if (!quizOptionsModal) {
        console.error("❌ main.js: HTML에서 'quiz-options-modal' ID를 가진 모달을 찾을 수 없습니다!");
    }
    if (!quizModalOverlay || !quizModalBody || !quizCloseBtn) {
         console.warn("⚠️ main.js: 퀴즈 결과 팝업 HTML 요소 중 일부를 찾을 수 없습니다.");
    }

    // --- 퀴즈 생성 로직 ---
    if (createQuizBtn) {
        createQuizBtn.addEventListener('click', () => {
            console.log("🖱️ '퀴즈 만들기' 버튼 클릭됨!"); 

            const bookId = getCurrentBookId();
            console.log("현재 열린 bookId:", bookId); 

            if (!bookId) {
                console.warn("bookId가 null입니다. 문서를 먼저 열어야 합니다."); 
                return alert("퀴즈를 만들 문서를 먼저 열어주세요.");
            }

            if (quizOptionsModal) { 
                console.log("퀴즈 옵션 모달을 엽니다."); 
                quizOptionsModal.classList.remove('hidden');
            } else {
                console.error("❌ 'quiz-options-modal'이 없어서 퀴즈 옵션을 열 수 없습니다.");
            }
        });
    } // if (createQuizBtn) 끝

    modalCloseBtn?.addEventListener('click', () => {
        quizOptionsModal?.classList.add('hidden');
    });

    modalHighlightsBtn?.addEventListener('click', async () => {
    
        // 1. 옵션 모달을 닫습니다.
        quizOptionsModal?.classList.add('hidden');

        // 2. bookId와 user를 가져옵니다.
        const bookId = getCurrentBookId();
        const user = getCurrentUser();

        // 3. bookId가 없으면 경고하고 중단합니다.
        if (!bookId || !user) {
            console.warn("하이라이트 퀴즈 생성 중단: bookId 또는 user가 없습니다.");
            return alert("퀴즈를 만들 문서를 먼저 열어주세요.");
        }

        // 4. 로딩창을 켭니다.
        showQuizModal(null, true, false, "하이라이트 퀴즈 생성 중... (최대 9분 소요)");
    
        try {
            // 5. [복원] 'bookId'만 보내는 원래 코드로 되돌립니다.
            const generateCustomReview = httpsCallable(functions, 'generateCustomReview', { timeout: 540000 });
            
            // 'chunkIds'와 'counts'를 보내지 않습니다.
            const { data } = await generateCustomReview({ bookId });
            
            // 6. ⭐️ [수정] 'result' 객체를 data 변수에 할당 (data.result)
            const resultData = data.result; 

            // 7. 'items' 가공
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
    
            // 8. DB에 저장
            const saveQuizItems = httpsCallable(functions, 'saveQuizItems');
            const saved = await saveQuizItems({ bookId, scope: 'highlight', items });
    
            // 9. ⭐️ [수정] data 대신 'resultData'를 렌더링
            showFullDocQuiz(resultData, saved.data);
            
        } catch (error) {
            // 10. 오류 처리
            console.error("하이라이트 퀴즈 생성 오류:", error);
            let errorMessage = error.message;
            if (error.code === 'functions/deadline-exceeded') {
                errorMessage = "AI 서버가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.";
            }
            showQuizModal(null, false, true, `오류가 발생했습니다: ${errorMessage}`);
        }
    });

    modalFullDocBtn?.addEventListener('click', async () => {
        quizOptionsModal?.classList.add('hidden');
        
        const bookId = getCurrentBookId();
        const user = getCurrentUser();
        if (!bookId || !user) {
            console.warn("전체 문서 퀴즈 생성 중단: bookId 또는 user가 없습니다.", "bookId:", bookId, "user:", user);
            return;
        }

        showQuizModal(null, true, false, "AI가 전체 문서를 분석해 퀴즈와 요약을 만드는 중... (최대 9분 소요)");
        try {
            // 5. ⭐️ 9분(540,000ms) 타임아웃
            const generateFullDocQuiz = httpsCallable(functions, 'generateFullDocQuiz', { timeout: 540000 });
            const result = await generateFullDocQuiz({ bookId });
            
            // ⭐️ [수정] 서버가 보낸 객체는 result.data 안에 { result: ... } 입니다.
            const data = result.data.result; // ⭐️ .result를 추가합니다.

           // 1) 백엔드 저장용 payload 가공
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

           // 2) 저장 + 중복 체크
           const saveQuizItems = httpsCallable(functions, 'saveQuizItems');
           const saved = await saveQuizItems({ bookId, scope: 'full', items });
           console.log('saveQuizItems:', saved.data);

            // ⭐️ data (data.result)를 렌더링
            showFullDocQuiz(data, saved.data);

        } catch (error) {
            console.error("전체 문서 퀴즈 생성 과정 오류:", error);
            let errorMessage = error.message;
            if (error.code === 'functions/deadline-exceeded') {
                errorMessage = "AI 서버가 응답하지 않습니다. (시간 초과) 잠시 후 다시 시도해 주세요.";
            }
            showQuizModal(null, false, true, `오류가 발생했습니다: ${errorMessage}`);
        }
    });

    // --- 퀴즈 결과 팝업 관련 이벤트 핸들러 ---
    
    quizCloseBtn?.addEventListener("click", hideQuizModal);
    quizModalOverlay?.addEventListener("click", (e) => {
        if (e.target === quizModalOverlay) hideQuizModal();
    });

    // 퀴즈 정답 확인 로직 (이하 동일)
    quizModalBody?.addEventListener('click', (e) => {
        const target = e.target;
        const optionLI = target.closest('li');

        // --- OX 및 객관식 보기 클릭 시 ---
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
        // --- 단답형 '정답 확인' 버튼 클릭 시 ---
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

    function showSimpleQuiz(quizData) {
        // ... (이 함수는 현재 사용되지 않는 것 같으므로 그대로 둡니다) ...
    }

    function showFullDocQuiz(data, saveResult) {
        
        // ⭐️ [수정] 퀴즈가 하나도 없는 경우 "분석 결과 없음" 처리
        // ⭐️ (summary_full -> summary)
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

        // ⭐️ [수정] (summary_full -> summary)
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

}); // ✨ DOMContentLoaded가 여기서 끝납니다.