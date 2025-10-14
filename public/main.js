import { getCurrentUser } from './auth.js';
import { 
    initDocSystem, createDocFromFile, openDoc,
    deleteDocFromDb, getCurrentBookId 
} from './doc.js';
import { httpsCallable, functions } from './A.firebase.js';
import { initOcr } from './ocr.js';

// 인증 상태 변경 시 문서 시스템 초기화
document.addEventListener('authStateChanged', (e) => {
    initDocSystem(e.detail.user);
});

// DOM 로드 후 UI 이벤트 핸들러 연결
document.addEventListener('DOMContentLoaded', () => {
    initOcr();

    // --- HTML 요소 가져오기 ---
    const fileInput = document.getElementById("file-btn");
    const chalkboard = document.getElementById("chalkboard");
    const docList = document.getElementById("doc-list");
    
    const createQuizBtn = document.getElementById('create-quiz-btn');
    const quizOptionsModal = document.getElementById('quiz-options-modal');
    const modalFullDocBtn = document.getElementById('modal-full-doc-btn');
    const modalHighlightsBtn = document.getElementById('modal-highlights-btn');
    const modalCloseBtn = document.getElementById('modal-close-btn');
    
    const quizModalOverlay = document.getElementById("quiz-modal-overlay");
    const quizModalBody = document.getElementById("quiz-modal-body");
    const quizCloseBtn = document.getElementById("quiz-close-btn");

    // --- 파일 및 문서 관련 이벤트 핸들러 ---
    fileInput?.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (file) createDocFromFile(file);
    });

    chalkboard?.addEventListener("click", () => fileInput?.click());
    
    docList?.addEventListener("click", (e) => {
        const target = e.target.closest('[data-open], [data-del], .doc-add');
        if (!target) return;

        if (target.matches('.doc-add')) fileInput?.click();
        else if (target.dataset.open) openDoc(target.dataset.open);
        else if (target.dataset.del) deleteDocFromDb(target.dataset.del);
    });

    // --- 퀴즈 생성 로직 ---
    createQuizBtn?.addEventListener('click', () => {
        if (!getCurrentBookId()) {
            return alert("퀴즈를 만들 문서를 먼저 열어주세요.");
        }
        quizOptionsModal?.classList.remove('hidden');
    });

    modalCloseBtn?.addEventListener('click', () => {
        quizOptionsModal?.classList.add('hidden');
    });

    modalHighlightsBtn?.addEventListener('click', async () => {
        quizOptionsModal?.classList.add('hidden');
        showQuizModal(null, true, false, "하이라이트 기반 퀴즈 생성 중...");
        try {
            const generateQuiz = httpsCallable(functions, 'generateQuiz');
            const result = await generateQuiz({ bookId: getCurrentBookId() });
            showSimpleQuiz(result.data.quiz);
        } catch (error) {
            console.error("하이라이트 퀴즈 생성 오류:", error);
            showQuizModal(null, false, true);
        }
    });

    modalFullDocBtn?.addEventListener('click', async () => {
        quizOptionsModal?.classList.add('hidden');
        
        const bookId = getCurrentBookId();
        const user = getCurrentUser();
        if (!bookId || !user) return;

        showQuizModal(null, true, false, "AI가 전체 문서를 분석해 퀴즈와 요약을 만드는 중... (최대 2분 소요)");
        try {
            const generateFullDocQuiz = httpsCallable(functions, 'generateFullDocQuiz');
            const result = await generateFullDocQuiz({ bookId });
            showFullDocQuiz(result.data);
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

    // ✨ [수정] 퀴즈 정답 확인 로직을 올바른 구조로 정리합니다.
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
        if (!quizModalOverlay || !quizModalBody) return;
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
        quizModalOverlay?.classList.add('hidden');
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

    function showFullDocQuiz(data) {
        if (!data) {
            showQuizModal(null, false, true, "분석 결과가 없습니다.");
            return;
        }
        const { summaries, review } = data;
        let html = '<h1>AI 분석 결과</h1>';

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