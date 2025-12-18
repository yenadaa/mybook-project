// quiz-page.js

// 1. A.firebase.js에서 필요한 기능들을 가져옵니다.
import { db, doc, getDoc, functions } from './A.firebase.js'; 
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js"; 

// UI 요소 참조
const quizContent = document.getElementById('quiz-content');
const sidebarNav = document.getElementById('sidebar-nav');
const submitBtn = document.getElementById('submit-session-btn');

// 현재 세션 ID 저장용
let currentSessionId = null;

/**
 * [초기화] 페이지 로드 시 실행
 */
async function loadQuiz() {
    const urlParams = new URLSearchParams(window.location.search);
    currentSessionId = urlParams.get('session');

    if (!currentSessionId) {
        showError('퀴즈 세션 ID가 없습니다. 알림 링크를 다시 확인해주세요.');
        return;
    }

    try {
        const docRef = doc(db, "reviewSessions", currentSessionId); 
        const docSnap = await getDoc(docRef);

        if (!docSnap.exists()) {
            showError(`퀴즈 데이터를 찾을 수 없습니다. (ID: ${currentSessionId})`);
            return;
        }

        const data = docSnap.data();

        if (data.status === 'completed') {
            alert("이미 제출이 완료된 퀴즈입니다.\n결과 점수: " + (data.score || "기록 없음"));
            window.location.href = '/'; 
            return;
        }

        const quizItems = data.items || [];
        if (quizItems.length === 0) {
            quizContent.innerHTML = '<div class="loading">복습할 퀴즈가 없습니다.</div>';
            return;
        }

        renderQuiz(quizItems);

    } catch (error) {
        console.error("퀴즈 로딩 오류:", error);
        showError(`로딩 중 오류가 발생했습니다: ${error.message}`);
    }
}

/**
 * [렌더링] 퀴즈 본문과 사이드바 버튼 생성
 */
function renderQuiz(items) {
    let html = '';
    if (sidebarNav) sidebarNav.innerHTML = '';

    let globalIndex = 0; 

    items.forEach(item => {
        globalIndex++;
        const type = item.type || 'unknown';
        const qId = `question-${globalIndex}`;
        
        // 사이드바 버튼
        if (sidebarNav) {
            const navBtn = document.createElement('button');
            navBtn.className = 'nav-btn';
            navBtn.textContent = globalIndex;
            navBtn.dataset.targetId = qId;
            navBtn.onclick = () => {
                document.getElementById(qId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            };
            sidebarNav.appendChild(navBtn);
        }

        // 퀴즈 아이템 HTML
        const commonAttr = `
            id="${qId}" 
            class="quiz-item" 
            data-index="${globalIndex}" 
            data-original-id="${item.originalDocId}" 
            data-type="${type}"
            data-answer="${item.answer}"
        `;

        if (type === 'ox') {
            html += `
                <div ${commonAttr}>
                    <p class="quiz-question">Q${globalIndex}. ${item.q}</p>
                    <ul class="quiz-options">
                        <li>True</li>
                        <li>False</li>
                    </ul>
                </div>
            `;
        } else if (type === 'short') {
            html += `
                <div ${commonAttr} class="short-answer-item">
                    <p class="quiz-question">Q${globalIndex}. ${item.q}</p>
                    <div class="short-answer-container">
                        <input type="text" class="short-answer-input" placeholder="정답을 입력하세요">
                        <button class="check-answer-btn">확인</button>
                    </div>
                    <p class="answer-feedback hidden">정답: ${item.answer}</p>
                </div>
            `;
        } else if (type === 'mcq') {
            const options = item.options || [];
            const optionsHtml = options.map(opt => `<li>${opt}</li>`).join('');
            html += `
                <div ${commonAttr}>
                    <p class="quiz-question">Q${globalIndex}. ${item.q}</p>
                    <ul class="quiz-options">${optionsHtml}</ul>
                </div>
            `;
        } else if (type === 'discussion') {
            html += `
                <div ${commonAttr}>
                      <p class="quiz-question">Q${globalIndex}. ${item.q}</p>
                      <textarea class="discussion-input" placeholder="답변을 입력하세요"></textarea>
                      <button class="save-discussion-btn">저장</button>
                </div>
            `;
        }
    });

    quizContent.innerHTML = html;
    quizContent.addEventListener('click', handleQuizInteraction);

    if (submitBtn) {
        submitBtn.style.display = 'block';
        const newBtn = submitBtn.cloneNode(true);
        submitBtn.parentNode.replaceChild(newBtn, submitBtn);
        newBtn.addEventListener('click', handleSubmitSession);
    }
}

/**
 * [상호작용] 클릭 이벤트 핸들러
 */
function handleQuizInteraction(e) {
    const target = e.target;
    
    // OX / 객관식
    const optionLI = target.closest('li');
    if (optionLI && optionLI.parentElement.classList.contains('quiz-options')) {
        const quizItem = optionLI.closest('.quiz-item');
        if (!quizItem || quizItem.classList.contains('answered')) return;

        const userVal = optionLI.textContent.trim();
        quizItem.dataset.userAnswer = userVal;

        const correctAnswer = String(quizItem.dataset.answer).toLowerCase();
        const selectedAnswer = userVal.toLowerCase();
        
        quizItem.classList.add('answered');

        if (selectedAnswer === correctAnswer) {
            optionLI.classList.add('correct');
        } else {
            optionLI.classList.add('incorrect');
            const options = quizItem.querySelectorAll('.quiz-options li');
            options.forEach(opt => {
                if (opt.textContent.toLowerCase() === correctAnswer) opt.classList.add('correct');
            });
        }
        
        const options = quizItem.querySelectorAll('.quiz-options li');
        options.forEach(opt => opt.classList.add('disabled'));
        updateSidebarStatus(quizItem.dataset.index);
    }
    
    // 단답형
    else if (target.matches('.check-answer-btn')) {
        const quizItem = target.closest('.quiz-item');
        if (!quizItem || quizItem.classList.contains('answered')) return;

        const input = quizItem.querySelector('.short-answer-input');
        const userVal = input.value.trim();
        
        quizItem.dataset.userAnswer = userVal;

        const correctAnswer = quizItem.dataset.answer;
        const feedback = quizItem.querySelector('.answer-feedback');

        quizItem.classList.add('answered');
        input.disabled = true;
        target.disabled = true;
        
        if (userVal.replace(/\s/g, '').toLowerCase() === correctAnswer.replace(/\s/g, '').toLowerCase()) {
            input.classList.add('correct');
        } else {
            input.classList.add('incorrect');
        }
        
        feedback.classList.remove('hidden');
        updateSidebarStatus(quizItem.dataset.index);
    }
    
    // 서술형
    else if (target.matches('.save-discussion-btn')) {
        const quizItem = target.closest('.quiz-item');
        const textarea = quizItem.querySelector('.discussion-input');
        const userVal = textarea.value.trim();
        
        if(!userVal) return alert("내용을 입력해주세요.");

        quizItem.dataset.userAnswer = userVal;
        quizItem.classList.add('answered');
        textarea.disabled = true;
        target.textContent = "저장됨";
        target.disabled = true;
        
        updateSidebarStatus(quizItem.dataset.index);
    }
}

function updateSidebarStatus(index) {
    if (!sidebarNav) return;
    const btns = sidebarNav.querySelectorAll('.nav-btn');
    const targetBtn = btns[index - 1];
    if (targetBtn) targetBtn.classList.add('completed');
}

/**
 * [제출] 결과 서버 전송 및 오답노트 저장
 */
async function handleSubmitSession() {
    if (!currentSessionId) return alert("세션 정보가 없습니다.");

    const totalItems = document.querySelectorAll('.quiz-item').length;
    const answeredItems = document.querySelectorAll('.quiz-item.answered').length;

    if (answeredItems < totalItems) {
        if (!confirm(`총 ${totalItems}문제 중 ${answeredItems}문제만 풀었습니다.\n제출할까요?`)) return;
    } else {
        if (!confirm("모든 문제를 풀었습니다. 결과를 제출할까요?")) return;
    }

    const btn = document.getElementById('submit-session-btn');
    btn.disabled = true;
    btn.textContent = "채점 중...";

    const answersPayload = {};
    document.querySelectorAll('.quiz-item').forEach(item => {
        const originalId = item.dataset.originalId;
        const userAnswer = item.dataset.userAnswer || "";
        if (originalId) answersPayload[originalId] = userAnswer;
    });

    try {
        console.log("📤 서버로 제출 중:", answersPayload);

        const submitFunc = httpsCallable(functions, 'submitReviewSession');
        const result = await submitFunc({
            sessionId: currentSessionId,
            answers: answersPayload
        });

        console.log("✅ 채점 완료:", result.data);
        const { correctCount, totalCount, message } = result.data;

        // ===== [오답 분석 및 저장 로직 통합] =====
        
        // 1. 오답 추리기
        const wrongQuestions = [];
        const normalize = (s) => String(s || "").replace(/\s/g, "").toLowerCase();

        document.querySelectorAll(".quiz-item").forEach(item => {
            const qText = item.querySelector(".quiz-question")?.textContent?.trim() || "";
            const correctAnswer = (item.dataset.answer || "").trim();
            const userAnswer = (item.dataset.userAnswer || "").trim();

            if (!normalize(userAnswer) || normalize(userAnswer) !== normalize(correctAnswer)) {
                wrongQuestions.push({ question: qText, userAnswer, correctAnswer });
            }
        });

        // 2. 점수 계산
        const score = totalCount ? Math.round((correctCount / totalCount) * 100) : 0;
        
        // 3. 현재 Doc ID 가져오기 (없으면 unknown)
        const docId = localStorage.getItem("mybook:selectedDocId") || 
                      localStorage.getItem("mybook:currentDocId") || 
                      "unknown-doc";

        // 4. 로컬 스토리지 저장 (홈 화면 진행률 반영용)
        saveQuizResultToProgress(docId, score, wrongQuestions);

        alert(`🎉 채점 완료!\n\n맞은 개수: ${correctCount} / ${totalCount}\n점수: ${score}점\n\n${message}`);
        window.location.href = "/";

    } catch (error) {
        console.error("제출 실패:", error);
        alert(`제출 중 오류가 발생했습니다.\n${error.message}`);
        btn.disabled = false;
        btn.textContent = "결과 제출하기";
    }
}

/**
 * [저장] 로컬 스토리지에 퀴즈 결과 저장 (홈 화면 연동)
 */
function saveQuizResultToProgress(docId, score, wrongQuestions) {
    try {
        const PROGRESS_KEY = "mybook:progress:v1";
        const progress = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
        const docInfo = progress[docId] || { docId, missedKeywords: [] };

        docInfo.quiz = {
            done: score >= 80,
            lastScore: score,
            wrongQuestions
        };

        // 오답 키워드 추출 (간단 버전)
        const STOP_WORDS = new Set(["무엇", "의미", "설명", "이란", "하는", "것은", "다음", "중", "옳은", "틀린", "대한"]);
        const keywords = new Set(docInfo.missedKeywords || []);

        wrongQuestions.forEach(wq => {
            const combined = `${wq.question || ""} ${wq.correctAnswer || ""}`;
            combined.replace(/[^\w가-힣 ]/g, " ")
                .split(/\s+/)
                .filter(w => w.length >= 2 && !STOP_WORDS.has(w))
                .forEach(w => keywords.add(w));
        });

        docInfo.missedKeywords = Array.from(keywords).slice(0, 50);
        docInfo.lastActivityAt = Date.now();

        progress[docId] = docInfo;
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
        console.log("💾 퀴즈 결과 저장 완료:", docId, score);
    } catch (e) {
        console.error("저장 중 오류:", e);
    }
}

function showError(msg) {
    if (quizContent) quizContent.innerHTML = `<div class="loading" style="color:red;">⚠️ ${msg}</div>`;
    else alert(msg);
}

// 시작
document.addEventListener('DOMContentLoaded', loadQuiz);