// A.firebase.js에서 Firestore 핵심 기능들을 가져옵니다.
// (A.firebase.js가 db, doc, getDoc을 export 하고 있어야 합니다)
import { db, doc, getDoc } from './A.firebase.js';

// 퀴즈 내용을 표시할 컨테이너
const quizContent = document.getElementById('quiz-content');

/**
 * URL에서 세션 ID를 가져와 Firestore에서 퀴즈 데이터를 로드합니다.
 */
async function loadQuiz() {
    // 1. URL에서 세션 ID 가져오기 (예: .../quiz-page.html?session=abcde)
    const urlParams = new URLSearchParams(window.location.search);
    const sessionId = urlParams.get('session');

    if (!sessionId) {
        quizContent.innerHTML = '<p style="color: red;">오류: 퀴즈 세션 ID가 없습니다. 알림을 다시 확인해주세요.</p>';
        return;
    }

    try {
        // 2. Firestore에서 퀴즈 세션 문서 가져오기
        // (백엔드가 'reviewSessions' 컬렉션에 저장했다고 가정)
        const docRef = doc(db, "reviewSessions", sessionId); 
        const docSnap = await getDoc(docRef);

        if (!docSnap.exists()) {
            quizContent.innerHTML = `<p style="color: red;">오류: 퀴즈를 찾을 수 없습니다 (ID: ${sessionId}).</p>`;
            return;
        }

        // 3. 퀴즈 데이터 가져오기 
        // (백엔드가 'items' 필드에 퀴즈 배열을 저장했다고 가정)
        const quizItems = docSnap.data()?.items || [];
        
        if (quizItems.length === 0) {
            quizContent.innerHTML = '<p>복습할 퀴즈가 없습니다. 잘하고 계시네요!</p>';
            return;
        }

        // 4. 퀴즈 렌더링
        renderQuiz(quizItems);

    } catch (error) {
        console.error("퀴즈 로딩 중 오류:", error);
        quizContent.innerHTML = `<p style="color: red;">퀴즈 로딩 중 오류가 발생했습니다: ${error.message}</p>`;
    }
}

/**
 * 퀴즈 항목 배열을 HTML로 변환하여 표시합니다.
 * (main.js의 showFullDocQuiz 함수와 유사하게 작동)
 */
function renderQuiz(items) {
    let html = '';
    let oxIndex = 1, shortIndex = 1, mcqIndex = 1;

    // --- OX 퀴즈 렌더링 ---
    const oxHtml = items.filter(it => it.type === 'ox').map(it => `
        <div class="quiz-item" data-answer="${it.answer}">
            <p class="quiz-question">${oxIndex++}. ${it.q}</p>
            <ul class="quiz-options"><li>true</li><li>false</li></ul>
        </div>
    `).join('');

    // --- 단답형 퀴즈 렌더링 ---
    const shortHtml = items.filter(it => it.type === 'short').map(it => `
        <div class="quiz-item short-answer-item" data-answer="${it.answer}">
            <p class="quiz-question">${shortIndex++}. ${it.q}</p>
            <div class="short-answer-container">
                <input type="text" class="short-answer-input" placeholder="정답을 입력하세요">
                <button class="check-answer-btn">정답 확인</button>
            </div>
            <p class="answer-feedback hidden">정답: ${it.answer}</p>
        </div>
    `).join('');
    
    // --- 객관식(MCQ) 퀴즈 렌더링 (main.js의 showSimpleQuiz 로직 재활용) ---
    const mcqHtml = items.filter(it => it.type === 'mcq').map(it => {
        const options = it.options || []; // options가 없을 경우 대비
        const shuffledOptions = [...options].sort(() => Math.random() - 0.5);
        const optionsHtml = shuffledOptions.map(opt => `<li>${opt}</li>`).join('');
        return `
            <div class="quiz-item" data-answer="${it.answer}">
                <p class="quiz-question">${mcqIndex++}. ${it.q}</p>
                <ul class="quiz-options">${optionsHtml}</ul>
            </div>
        `;
    }).join('');

    // 퀴즈 종류별로 HTML 조립
    if (oxHtml) html += `<h3>OX 퀴즈</h3>${oxHtml}<hr>`;
    if (shortHtml) html += `<h3>단답형 퀴즈</h3>${shortHtml}<hr>`;
    if (mcqHtml) html += `<h3>객관식 퀴즈</h3>${mcqHtml}`;
    
    quizContent.innerHTML = html;

    // 퀴즈 항목에 클릭 이벤트 리스너 연결
    quizContent.addEventListener('click', handleQuizClick);
}

/**
 * 퀴즈 정답 확인 로직 (main.js에서 가져온 로직)
 * (이후 정답/오답 여부를 Firestore에 다시 저장하는 로직 추가 가능)
 */
function handleQuizClick(e) {
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
            // TODO: (나중에) 이 퀴즈가 '정답'임을 Firestore에 기록
        } else {
            optionLI.classList.add('incorrect');
            options.forEach(opt => {
                if (opt.textContent.toLowerCase() === correctAnswer) {
                    opt.classList.add('correct');
                }
            });
            // TODO: (나중에) 이 퀴즈가 '오답'임을 Firestore에 기록
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
            // TODO: (나중에) '정답' 기록
        } else {
            input.classList.add('incorrect');
            // TODO: (나중에) '오답' 기록
        }
    }
}

// 페이지가 로드되면 퀴즈를 바로 시작합니다.
document.addEventListener('DOMContentLoaded', loadQuiz);