import { 
    getCurrentUser, 
    initDocSystem, 
    createDocFromFile, 
    openDoc,
    deleteDocFromDb, 
    getCurrentBookId
} from './doc_firebase.js';
import { httpsCallable, functions } from './A.firebase.js';
import { initOcr } from './ocr.js';

console.log("✅ main.js 스크립트 파일 로드됨");

// DOM 로드 후 UI 이벤트 핸들러 연결
document.addEventListener('DOMContentLoaded', () => {
    console.log("✅ main.js DOMContentLoaded 이벤트 발생");
    initOcr();

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
    // [수정] 옵셔널 체이닝(?.)을 제거하고 if문으로 명확하게 확인
    if (createQuizBtn) {
        createQuizBtn.addEventListener('click', () => {
            console.log("🖱️ '퀴즈 만들기' 버튼 클릭됨!"); // [디버깅 로그 1]

            const bookId = getCurrentBookId();
            console.log("현재 열린 bookId:", bookId); // [디버깅 로그 2]

            if (!bookId) {
                console.warn("bookId가 null입니다. 문서를 먼저 열어야 합니다."); // [디버깅 로그 3]
                return alert("퀴즈를 만들 문서를 먼저 열어주세요.");
            }

            if (quizOptionsModal) { // 👈 null이 아닐 때만 실행
                console.log("퀴즈 옵션 모달을 엽니다."); // [디버깅 로그 4]
                quizOptionsModal.classList.remove('hidden');
            } else {
                console.error("❌ 'quiz-options-modal'이 없어서 퀴즈 옵션을 열 수 없습니다.");
            }
        });
    } // if (createQuizBtn) 끝

    modalCloseBtn?.addEventListener('click', () => {
        quizOptionsModal?.classList.add('hidden');
    });

    // 하이라이트 기반 커스텀 리뷰 생성 (수정한 부분!)
    modalHighlightsBtn?.addEventListener('click', async () => {
        showQuizModal(null, true, false, "하이라이트만 모아 퀴즈·요약 생성 중...");
        try {
            const generateCustomReview = httpsCallable(functions, 'generateCustomReview', { timeout: 300000 });
            const { data } = await generateCustomReview({ bookId });

            // 1) 저장용 payload (full과 동일 스키마)
            const items = [];
            if (data?.review?.ox) {
                data.review.ox.forEach(it =>
                    items.push({ type: 'ox', q: it.q, answer: String(it.answer), sources: it.sources || [], tags: it.tags || [] })
                );
            }
            if (data?.review?.short) {
                data.review.short.forEach(it =>
                    items.push({ type: 'short', q: it.q, answer: it.answer || "", sources: it.sources || [], tags: it.tags || [] })
                );
            }
            if (data?.review?.discussion) {
                data.review.discussion.forEach(it =>
                    items.push({ type: 'discussion', q: it.q, sources: it.sources || [], tags: it.tags || [] })
                );
            }

            // 2) 저장 + 중복 체크 (scope만 'highlight'로)
            const saveQuizItems = httpsCallable(functions, 'saveQuizItems');
            const saved = await saveQuizItems({ bookId, scope: 'highlight', items });

            // 3) 렌더도 full과 동일 UI 재사용
            showFullDocQuiz(data, saved.data);
            } catch (error) {
            console.error("하이라이트 퀴즈 생성 오류:", error);
            showQuizModal(null, false, true, `오류가 발생했습니다: ${error.message}`);
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

        showQuizModal(null, true, false, "AI가 전체 문서를 분석해 퀴즈와 요약을 만드는 중... (최대 2분 소요)");
        try {
            const generateFullDocQuiz = httpsCallable(functions, 'generateFullDocQuiz');
            const result = await generateFullDocQuiz({ bookId });
            const data = result.data;

           // 1) 백엔드 저장용 payload 가공
           const items = [];
           if (data?.review?.ox) {
             data.review.ox.forEach(it => items.push({ type: 'ox', q: it.q, answer: String(it.answer), sources: it.sources || [], tags: it.tags || [] }));
            } // 👈 [수정] 't' 오타 삭제
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

            showFullDocQuiz(data,saved.data);
        } catch (error) {
            console.error("전체 문서 퀴즈 생성 과정 오류:", error);
            showQuizModal(null, false, true, `오류가 발생했습니다: ${error.message}`);
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
            quizModalBody.innerHTML = `<div class="loading">${loadingText}</div>`;
        } else if (isError) {
            quizModalBody.innerHTML = `<div class="loading">${loadingText || '오류가 발생했습니다. 다시 시도해주세요.'}</div>`;
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
        if (!quizData || !quizData.length === 0) {
            showQuizModal(null, false, true, "퀴즈를 생성할 내용이 부족합니다.");
            return;
        }
        const quizHtml = quizData.map((item, index) => {
            const shuffledOptions = [...item.options].sort(() => Math.random() - 0.5);
            const optionsHtml = shuffledOptions.map(opt => `<li>${opt}</li>`).join('');
            return `
                <div class="quiz-item" data-answer="${item.answer}">
                    <p class="quiz-question">${index + 1}. ${item.question}</p>
                    <ul class="quiz-options">${optionsHtml}</ul>
                </div>
            `;
        }).join('');
        showQuizModal(quizHtml);
    }

    function showFullDocQuiz(data,saveResult) {
        if (!data) {
            showQuizModal(null, false, true, "분석 결과가 없습니다.");
            return;
        }
        const { summaries, review } = data;
        // ◀◀◀ 피드백 메시지 추가
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

        let html = `<h1>AI 분석 결과</h1>${feedbackHtml}`; // ◀◀◀ 피드백 HTML 삽입

        if (summaries && summaries.summary_full) {
            html += `
                <div class="summary-section">
                    <h2>AI 생성 요약</h2>
                    <p>${summaries.summary_full.replace(/\n/g, '<br>')}</p>
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
                `).join(''); // 👈 [수정] 'label-btn' 오타 삭제
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
              _       <p class="answer-feedback hidden">정답: ${item.answer}</p>
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