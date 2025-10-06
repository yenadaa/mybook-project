import { getCurrentUser } from './auth.js';
import { 
    initDocSystem, 
    createDocFromFile, 
    openDoc,
    deleteDocFromDb,
    analyzeDocWithOcr,
    getCurrentBookId
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

    const fileInput = document.getElementById("file-btn");
    const chalkboard = document.getElementById("chalkboard");
    const docList = document.getElementById("doc-list");
    const quizBtn = document.getElementById("quiz-btn");
    const quizModalOverlay = document.getElementById("quiz-modal-overlay");
    const quizModalBody = document.getElementById("quiz-modal-body");
    const quizCloseBtn = document.getElementById("quiz-close-btn");
    
    fileInput?.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (file) createDocFromFile(file);
    });

    chalkboard?.addEventListener("click", () => fileInput?.click());
    
    docList?.addEventListener("click", (e) => {
        const target = e.target;
        if (target.matches('.doc-add')) fileInput?.click();
        else if (target.dataset.open) openDoc(target.dataset.open);
        else if (target.dataset.del) deleteDocFromDb(target.dataset.del);
        else if (target.dataset.ocr) analyzeDocWithOcr(target.dataset.ocr);
    });

    quizBtn?.addEventListener('click', async () => {
        const bookId = getCurrentBookId();
        const user = getCurrentUser();
        if (!bookId || !user) {
            return alert("퀴즈를 만들 문서를 먼저 열어주세요.");
        }
        
        showQuizModal(null, true);

        try {
            const generateQuiz = httpsCallable(functions, 'generateQuiz');
            const result = await generateQuiz({ bookId: bookId });
            showQuizModal(result.data.quiz);
        } catch (error) {
            console.error("Error generating quiz:", error);
            showQuizModal(null, false, true); // 에러 상태 표시
        }
    });

    quizCloseBtn?.addEventListener("click", hideQuizModal);
    quizModalOverlay?.addEventListener("click", (e) => {
        if (e.target === quizModalOverlay) hideQuizModal();
    });

    // --- ✨ 퀴즈 보기 클릭 이벤트 핸들러 추가 ---
    quizModalBody?.addEventListener('click', (e) => {
        const target = e.target.closest('li');
        if (!target || !target.parentElement.classList.contains('quiz-options')) return;

        const quizItem = target.closest('.quiz-item');
        if (!quizItem || quizItem.classList.contains('answered')) return; // 이미 답한 문제는 무시

        const correctAnswer = quizItem.dataset.answer;
        const selectedAnswer = target.textContent;
        const options = quizItem.querySelectorAll('.quiz-options li');

        quizItem.classList.add('answered'); // 답변 완료 상태로 변경

        if (selectedAnswer === correctAnswer) {
            target.classList.add('correct');
        } else {
            target.classList.add('incorrect');
            options.forEach(opt => {
                if (opt.textContent === correctAnswer) {
                    opt.classList.add('correct');
                }
            });
        }
        
        // 모든 보기를 클릭 불가능하게 만듦
        options.forEach(opt => opt.classList.add('disabled'));
    });
});

// --- 퀴즈 팝업창 관련 함수 ---
function showQuizModal(quizData, isLoading = false, isError = false) {
    const overlay = document.getElementById("quiz-modal-overlay");
    const body = document.getElementById("quiz-modal-body");
    if (!overlay || !body) return;

    body.innerHTML = '';

    if (isLoading) {
        body.innerHTML = `<div class="loading">AI가 퀴즈를 생성하고 있습니다...</div>`;
    } else if (isError) {
        body.innerHTML = `<div class="loading">퀴즈 생성 중 오류가 발생했습니다.<br>하이라이트를 추가한 후 다시 시도해 주세요.</div>`;
    } else if (quizData && Array.isArray(quizData) && quizData.length > 0) {
        quizData.forEach((item, index) => {
            const quizItemDiv = document.createElement('div');
            quizItemDiv.className = 'quiz-item';
            // 정답을 data-answer 속성에 저장
            quizItemDiv.dataset.answer = item.answer; 

            // 보기(options)를 랜덤으로 섞어서 표시
            const shuffledOptions = [...item.options].sort(() => Math.random() - 0.5);
            const optionsHtml = shuffledOptions.map(option => `<li>${option}</li>`).join('');

            quizItemDiv.innerHTML = `
                <p class="quiz-question">${index + 1}. ${item.question}</p>
                <ul class="quiz-options">
                    ${optionsHtml}
                </ul>
            `;
            body.appendChild(quizItemDiv);
        });
    } else {
        body.innerHTML = `<div class="loading">퀴즈를 생성할 내용이 부족합니다.<br>하이라이트를 추가한 후 다시 시도해 주세요.</div>`;
    }

    overlay.classList.remove('hidden');
}

function hideQuizModal() {
    const overlay = document.getElementById("quiz-modal-overlay");
    overlay?.classList.add('hidden');
}

