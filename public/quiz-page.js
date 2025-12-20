import { db, doc, getDoc, functions } from './A.firebase.js'; 
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js"; 

const quizContent = document.getElementById('quiz-content');
const sidebarNav = document.getElementById('sidebar-nav');
const submitBtn = document.getElementById('submit-session-btn');
let currentSessionId = null;

// 1. 로드
async function loadQuiz() {
    const urlParams = new URLSearchParams(window.location.search);
    currentSessionId = urlParams.get('session');
    if (!currentSessionId) return showError('세션 ID가 없습니다.');

    try {
        const docRef = doc(db, "reviewSessions", currentSessionId); 
        const docSnap = await getDoc(docRef);
        if (!docSnap.exists()) return showError(`퀴즈를 찾을 수 없습니다.`);

        const data = docSnap.data();
        if (data.status === 'completed') {
            alert(`이미 제출된 퀴즈입니다. (점수: ${data.score}점)`);
            window.location.href = '/'; 
            return;
        }

        const quizItems = data.items || [];
        if (quizItems.length === 0) {
            quizContent.innerHTML = '<div class="loading">생성된 문제가 없습니다.</div>';
            return;
        }

        renderQuiz(quizItems);

    } catch (error) {
        console.error("로딩 에러:", error);
        showError(error.message);
    }
}

// 2. 렌더링 (★템플릿 스타일 적용됨★)
function renderQuiz(items) {
    let html = '';
    
    // (1) 유형별로 분류하기
    const oxItems = items.filter(i => i.type === 'ox');
    const shortItems = items.filter(i => i.type === 'short');
    const mcqItems = items.filter(i => i.type === 'mcq' || i.type === '객관식');

    let globalIndex = 0;

    // (2) OX 퀴즈 섹션
    if (oxItems.length > 0) {
        html += `<h2 style="margin: 30px 0 15px 0; border-left:5px solid #3b82f6; padding-left:10px;">OX 퀴즈</h2>`;
        oxItems.forEach(item => {
            globalIndex++;
            html += buildQuizItemHtml(item, globalIndex);
        });
    }

    // (3) 단답형 퀴즈 섹션
    if (shortItems.length > 0) {
        html += `<h2 style="margin: 40px 0 15px 0; border-left:5px solid #22c55e; padding-left:10px;">단답형 퀴즈</h2>`;
        shortItems.forEach(item => {
            globalIndex++;
            html += buildQuizItemHtml(item, globalIndex);
        });
    }

    // (4) 객관식 퀴즈 섹션
    if (mcqItems.length > 0) {
        html += `<h2 style="margin: 40px 0 15px 0; border-left:5px solid #f59e0b; padding-left:10px;">객관식 퀴즈</h2>`;
        mcqItems.forEach(item => {
            globalIndex++;
            html += buildQuizItemHtml(item, globalIndex);
        });
    }

    // (5) HTML 삽입
    quizContent.innerHTML = html;
    quizContent.addEventListener('click', handleQuizInteraction);

    // 사이드바 업데이트
    updateSidebar(globalIndex);

    // 제출 버튼 활성화
    if (submitBtn) {
        submitBtn.style.display = 'block';
        const newBtn = submitBtn.cloneNode(true);
        submitBtn.parentNode.replaceChild(newBtn, submitBtn);
        newBtn.addEventListener('click', handleSubmitSession);
    }
}

// 헬퍼: 개별 문제 HTML 생성
function buildQuizItemHtml(item, index) {
    const qId = `question-${index}`;
    const type = item.type || 'unknown';
    
    // 원본 보기 버튼
    let sourceBtn = '';
    if (item.originalDocId && item.originalDocId !== 'dummy') {
        sourceBtn = `
            <div style="margin-bottom:8px; text-align:right;">
                <button type="button" class="btn-text-small" onclick="window.openViewer('${item.originalDocId}')">
                    📄 원본 확인 ↗
                </button>
            </div>
        `;
    }

    const commonAttr = `id="${qId}" class="quiz-item" data-index="${index}" data-original-id="${item.originalDocId}" data-type="${type}" data-answer="${item.answer}"`;

    // 1. OX
    if (type === 'ox') {
        return `
            <div ${commonAttr}>
                ${sourceBtn}
                <p class="quiz-question">Q${index}. ${item.q}</p>
                <ul class="quiz-options">
                    <li>True</li>
                    <li>False</li>
                </ul>
            </div>`;
    } 
    // 2. 단답형
    else if (type === 'short') {
        return `
            <div ${commonAttr}>
                ${sourceBtn}
                <p class="quiz-question">Q${index}. ${item.q}</p>
                <div class="short-answer-container">
                    <input type="text" class="short-answer-input" placeholder="정답 입력">
                    <button class="check-answer-btn">확인</button>
                </div>
                <p class="answer-feedback hidden">정답: ${item.answer}</p>
            </div>`;
    } 
    // 3. 객관식
    else if (type === 'mcq' || type === '객관식') {
        const options = item.options || [];
        const optionsHtml = options.length > 0 
            ? options.map(opt => `<li>${opt}</li>`).join('') 
            : `<li style="color:red;">보기 데이터 없음</li>`;
        
        return `
            <div ${commonAttr}>
                ${sourceBtn}
                <p class="quiz-question">Q${index}. ${item.q}</p>
                <ul class="quiz-options">${optionsHtml}</ul>
            </div>`;
    }
    return '';
}

// 사이드바 생성 함수
function updateSidebar(totalCount) {
    if (sidebarNav) {
        sidebarNav.innerHTML = '';
        for (let i = 1; i <= totalCount; i++) {
            const navBtn = document.createElement('button');
            navBtn.className = 'nav-btn';
            navBtn.textContent = i;
            navBtn.onclick = () => document.getElementById(`question-${i}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            sidebarNav.appendChild(navBtn);
        }
    }
}

// 3. 상호작용 (클릭 처리)
function handleQuizInteraction(e) {
    const target = e.target;
    
    // (A) 보기 클릭 (OX, 객관식 공통)
    const optionLI = target.closest('li');
    if (optionLI && optionLI.parentElement.classList.contains('quiz-options')) {
        const quizItem = optionLI.closest('.quiz-item');
        if (!quizItem || quizItem.classList.contains('answered')) return;

        const userVal = optionLI.textContent.trim();
        quizItem.dataset.userAnswer = userVal;

        const correctAnswer = String(quizItem.dataset.answer).toLowerCase().trim();
        const selectedAnswer = userVal.toLowerCase().trim();
        
        quizItem.classList.add('answered');

        if (selectedAnswer === correctAnswer) {
            optionLI.classList.add('correct');
        } else {
            optionLI.classList.add('incorrect');
            const options = quizItem.querySelectorAll('.quiz-options li');
            options.forEach(opt => {
                if (opt.textContent.toLowerCase().trim() === correctAnswer) opt.classList.add('correct');
            });
        }
        markSidebarCompleted(quizItem.dataset.index);
    }
    
    // (B) 단답형 확인 버튼
    else if (target.matches('.check-answer-btn')) {
        const quizItem = target.closest('.quiz-item');
        if (!quizItem || quizItem.classList.contains('answered')) return;

        const input = quizItem.querySelector('.short-answer-input');
        const userVal = input.value.trim();
        
        quizItem.dataset.userAnswer = userVal;
        const correctAnswer = String(quizItem.dataset.answer).toLowerCase().replace(/\s/g, '');
        const userInputClean = userVal.toLowerCase().replace(/\s/g, '');

        quizItem.classList.add('answered');
        input.disabled = true;
        target.disabled = true;
        
        const feedback = quizItem.querySelector('.answer-feedback');
        feedback.classList.remove('hidden');

        if (userInputClean === correctAnswer) {
            input.classList.add('correct');
        } else {
            input.classList.add('incorrect');
        }
        markSidebarCompleted(quizItem.dataset.index);
    }
}

function markSidebarCompleted(index) {
    if (!sidebarNav) return;
    const btns = sidebarNav.querySelectorAll('.nav-btn');
    const targetBtn = btns[index - 1];
    if (targetBtn) targetBtn.classList.add('completed');
}

// 4. 제출 (자동 채점)
async function handleSubmitSession() {
    if (!currentSessionId) return;
    
    const total = document.querySelectorAll('.quiz-item').length;
    const answered = document.querySelectorAll('.quiz-item.answered').length;
    if (answered < total && !confirm(`${total - answered}문제 안 풀었습니다. 제출할까요?`)) return;

    const btn = document.getElementById('submit-session-btn');
    btn.disabled = true;
    btn.textContent = "채점 중...";

    const answersPayload = {};
    document.querySelectorAll('.quiz-item').forEach(item => {
        const oid = item.dataset.originalId;
        if (oid) answersPayload[oid] = item.dataset.userAnswer || "";
    });

    try {
        const submitFunc = httpsCallable(functions, 'submitReviewSession');
        const result = await submitFunc({ sessionId: currentSessionId, answers: answersPayload });
        const { score, correctCount, totalCount } = result.data;

        alert(`💯 채점 완료!\n점수: ${score}점 (${correctCount}/${totalCount})`);
        window.location.href = '/';
    } catch (e) {
        alert("제출 실패: " + e.message);
        btn.disabled = false;
        btn.textContent = "결과 제출하기";
    }
}

function showError(msg) {
    if (quizContent) quizContent.innerHTML = `<div style="padding:20px; color:red; text-align:center;">⚠️ ${msg}</div>`;
    else alert(msg);
}

window.openViewer = function(docId) {
    if(!docId || docId === 'undefined') return alert("문서 정보 없음");
    window.open(`/index.html?docId=${docId}`, '_blank');
};

document.addEventListener('DOMContentLoaded', loadQuiz);