// quiz-page.js

// 1. A.firebase.js에서 필요한 기능들을 가져옵니다.
// ⚠️ 주의: A.firebase.js에서 'functions'를 export 해야 합니다.
import { db, doc, getDoc, functions } from './A.firebase.js'; 
import { httpsCallable } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-functions.js"; 

// UI 요소 참조
const quizContent = document.getElementById('quiz-content');
const sidebarNav = document.getElementById('sidebar-nav');
const submitBtn = document.getElementById('submit-session-btn');

// 현재 세션 ID 저장용
let currentSessionId = null;

/**
 * [초기화] 페이지 로드 시 실행
 * URL에서 세션 ID를 파싱하고 데이터를 로드합니다.
 */
async function loadQuiz() {
    // 1. URL 파라미터 확인
    const urlParams = new URLSearchParams(window.location.search);
    currentSessionId = urlParams.get('session');

    if (!currentSessionId) {
        showError('퀴즈 세션 ID가 없습니다. 알림 링크를 다시 확인해주세요.');
        return;
    }

    try {
        // 2. Firestore에서 세션 정보 조회
        const docRef = doc(db, "reviewSessions", currentSessionId); 
        const docSnap = await getDoc(docRef);

        if (!docSnap.exists()) {
            showError(`퀴즈 데이터를 찾을 수 없습니다. (ID: ${currentSessionId})`);
            return;
        }

        const data = docSnap.data();

        // 3. 이미 제출된 세션인지 확인
        if (data.status === 'completed') {
            alert("이미 제출이 완료된 퀴즈입니다.\n결과 점수: " + (data.score || "기록 없음"));
            window.location.href = '/'; // 홈으로 이동
            return;
        }

        // 4. 퀴즈 아이템 확인
        const quizItems = data.items || [];
        if (quizItems.length === 0) {
            quizContent.innerHTML = '<div class="loading">복습할 퀴즈가 없습니다.</div>';
            return;
        }

        // 5. 화면 렌더링 시작
        renderQuiz(quizItems);

    } catch (error) {
        console.error("퀴즈 로딩 오류:", error);
        showError(`로딩 중 오류가 발생했습니다: ${error.message}`);
    }
}

/**
 * [렌더링] 퀴즈 본문과 사이드바 버튼을 생성합니다.
 */
function renderQuiz(items) {
    let html = '';
    
    // 사이드바 초기화
    if (sidebarNav) sidebarNav.innerHTML = '';

    let globalIndex = 0; 

    // 개별 문제 HTML 생성 헬퍼 함수
    const createItem = (item) => {
        globalIndex++;
        const type = item.type || 'unknown';
        const qId = `question-${globalIndex}`;
        
        // --- A. 사이드바 버튼 생성 ---
        if (sidebarNav) {
            const navBtn = document.createElement('button');
            navBtn.className = 'nav-btn';
            navBtn.textContent = globalIndex;
            navBtn.dataset.targetId = qId;
            
            // 클릭 시 해당 문제로 스크롤
            navBtn.onclick = () => {
                document.getElementById(qId).scrollIntoView({ behavior: 'smooth', block: 'center' });
            };
            sidebarNav.appendChild(navBtn);
        }

        // --- B. 퀴즈 본문 HTML 생성 ---
        // ⭐️ data-original-id: 채점 시 백엔드가 어떤 문제인지 식별하는 핵심 키
        const commonAttr = `
            id="${qId}" 
            class="quiz-item" 
            data-index="${globalIndex}" 
            data-original-id="${item.originalDocId}" 
            data-type="${type}"
            data-answer="${item.answer}"
        `;

        // 타입별 템플릿
        if (type === 'ox') {
            return `
                <div ${commonAttr}>
                    <p class="quiz-question">Q${globalIndex}. ${item.q}</p>
                    <ul class="quiz-options">
                        <li>True</li>
                        <li>False</li>
                    </ul>
                </div>
            `;
        } else if (type === 'short') {
            return `
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
            // 보기 섞기 (선택사항)
            // const shuffledOptions = [...options].sort(() => Math.random() - 0.5);
            const optionsHtml = options.map(opt => `<li>${opt}</li>`).join('');
            return `
                <div ${commonAttr}>
                    <p class="quiz-question">Q${globalIndex}. ${item.q}</p>
                    <ul class="quiz-options">${optionsHtml}</ul>
                </div>
            `;
        } else if (type === 'discussion') {
            // 서술형 (필요시 추가)
            return `
                <div ${commonAttr}>
                     <p class="quiz-question">Q${globalIndex}. ${item.q}</p>
                     <textarea class="discussion-input" placeholder="답변을 입력하세요"></textarea>
                     <button class="save-discussion-btn">저장</button>
                </div>
            `;
        }
        return '';
    };

    // 아이템 순회하며 HTML 조립
    items.forEach(item => {
        html += createItem(item);
    });

    // DOM 삽입
    quizContent.innerHTML = html;

    // 이벤트 리스너 연결 (이벤트 위임)
    quizContent.addEventListener('click', handleQuizInteraction);

    // 제출 버튼 활성화
    if (submitBtn) {
        submitBtn.style.display = 'block'; // 혹시 숨겨져 있었다면 표시
        // 기존 리스너 제거(복제) 후 새 리스너 연결
        const newBtn = submitBtn.cloneNode(true);
        submitBtn.parentNode.replaceChild(newBtn, submitBtn);
        newBtn.addEventListener('click', handleSubmitSession);
    }
}

/**
 * [상호작용] 퀴즈 클릭 이벤트 핸들러
 */
function handleQuizInteraction(e) {
    const target = e.target;
    
    // --- 1. OX / 객관식 보기 클릭 ---
    const optionLI = target.closest('li');
    if (optionLI && optionLI.parentElement.classList.contains('quiz-options')) {
        const quizItem = optionLI.closest('.quiz-item');
        if (!quizItem || quizItem.classList.contains('answered')) return;

        // 사용자 선택값 저장 (DOM 데이터 속성에 저장)
        const userVal = optionLI.textContent.trim();
        quizItem.dataset.userAnswer = userVal;

        // 정답 체크 (UI 표시용 - 실제 채점은 서버가 함)
        const correctAnswer = String(quizItem.dataset.answer).toLowerCase();
        const selectedAnswer = userVal.toLowerCase();
        
        quizItem.classList.add('answered');

        if (selectedAnswer === correctAnswer) {
            optionLI.classList.add('correct');
        } else {
            optionLI.classList.add('incorrect');
            // 정답 표시해주기
            const options = quizItem.querySelectorAll('.quiz-options li');
            options.forEach(opt => {
                if (opt.textContent.toLowerCase() === correctAnswer) opt.classList.add('correct');
            });
        }
        
        // 다시 클릭 못하게 막기
        const options = quizItem.querySelectorAll('.quiz-options li');
        options.forEach(opt => opt.classList.add('disabled'));

        // 사이드바 업데이트
        updateSidebarStatus(quizItem.dataset.index);
    }
    
    // --- 2. 단답형 확인 버튼 클릭 ---
    else if (target.matches('.check-answer-btn')) {
        const quizItem = target.closest('.quiz-item');
        if (!quizItem || quizItem.classList.contains('answered')) return;

        const input = quizItem.querySelector('.short-answer-input');
        const userVal = input.value.trim();
        
        // 사용자 입력값 저장
        quizItem.dataset.userAnswer = userVal;

        // 정답 체크 (UI 표시용)
        const correctAnswer = quizItem.dataset.answer;
        const feedback = quizItem.querySelector('.answer-feedback');

        quizItem.classList.add('answered');
        input.disabled = true;
        target.disabled = true;
        
        // 공백 제거 후 비교
        if (userVal.replace(/\s/g, '').toLowerCase() === correctAnswer.replace(/\s/g, '').toLowerCase()) {
            input.classList.add('correct');
        } else {
            input.classList.add('incorrect');
        }
        
        // 정답 공개
        feedback.classList.remove('hidden');

        // 사이드바 업데이트
        updateSidebarStatus(quizItem.dataset.index);
    }
    
    // --- 3. 서술형 저장 (필요시) ---
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

/**
 * [UI 업데이트] 사이드바 버튼 색상 변경
 */
function updateSidebarStatus(index) {
    if (!sidebarNav) return;
    const btns = sidebarNav.querySelectorAll('.nav-btn');
    // index는 1부터 시작하므로 -1
    const targetBtn = btns[index - 1];
    if (targetBtn) {
        targetBtn.classList.add('completed');
    }
}

/**
 * [서버 통신] 결과 제출하기
 */
async function handleSubmitSession() {
    if (!currentSessionId) return alert("세션 정보가 없습니다.");

    // 1. 진행 상황 체크
    const totalItems = document.querySelectorAll('.quiz-item').length;
    const answeredItems = document.querySelectorAll('.quiz-item.answered').length;

    if (answeredItems < totalItems) {
        if (!confirm(`총 ${totalItems}문제 중 ${answeredItems}문제만 풀었습니다.\n나머지는 오답 처리됩니다. 제출할까요?`)) {
            return;
        }
    } else {
        if (!confirm("모든 문제를 풀었습니다. 결과를 제출할까요?")) return;
    }

    // 버튼 비활성화 (중복 클릭 방지)
    const btn = document.getElementById('submit-session-btn');
    btn.disabled = true;
    btn.textContent = "채점 중...";

    // 2. 데이터 수집 ({ 원본ID: 사용자답안 })
    const answersPayload = {};
    document.querySelectorAll('.quiz-item').forEach(item => {
        const originalId = item.dataset.originalId;
        const userAnswer = item.dataset.userAnswer || ""; // 안 푼 건 빈값
        if (originalId) {
            answersPayload[originalId] = userAnswer;
        }
    });

    try {
        console.log("📤 서버로 제출 중:", answersPayload);

        // 3. Cloud Function 호출
        const submitFunc = httpsCallable(functions, 'submitReviewSession');
        const result = await submitFunc({
            sessionId: currentSessionId,
            answers: answersPayload
        });

        console.log("✅ 채점 완료:", result.data);
        const { correctCount, totalCount, message } = result.data;
// ===== [정답] docId 확보 =====
const docId =
  localStorage.getItem("mybook:selectedDocId") ||
  localStorage.getItem("mybook:currentDocId") ||
  "unknown-doc";

<<<<<<< HEAD

=======
// ===== [정답] 오답 목록 만들기: 서버 결과 우선, 없으면 fallback =====
let wrongQuestions = [];

// 1) 서버가 results를 준다면 그걸 사용(가장 정확)
const serverResults = result.data.results;
if (Array.isArray(serverResults) && serverResults.length > 0) {
  wrongQuestions = serverResults
    .filter(r => r.correct === false)
    .map(r => {
      const item = document.querySelector(`.quiz-item[data-original-id="${r.originalId}"]`);
      const qText = item?.querySelector(".quiz-question")?.textContent?.trim() || "";
      const userAnswer = item?.dataset.userAnswer || "";
      return {
        question: qText,
        userAnswer,
        correctAnswer: r.correctAnswer || "" // 서버가 주는 정답(있다면)
      };
    });
} else {
  // 2) fallback: 클라이언트 비교(현재 data-answer가 있으니 가능)
  const normalize = (s) => String(s || "").replace(/\s/g, "").toLowerCase();

  document.querySelectorAll(".quiz-item").forEach(item => {
    const qText = item.querySelector(".quiz-question")?.textContent?.trim() || "";
    const correctAnswer = (item.dataset.answer || "").trim();
    const userAnswer = (item.dataset.userAnswer || "").trim();

    if (!normalize(userAnswer) || normalize(userAnswer) !== normalize(correctAnswer)) {
      wrongQuestions.push({ question: qText, userAnswer, correctAnswer });
    }
  });
}

// ===== [정답] 점수 계산 + progress 저장(딱 1번만) =====
const score = totalCount ? Math.round((correctCount / totalCount) * 100) : 0;
saveQuizResultToProgress(docId, score, wrongQuestions);


        // 4. 결과 알림
        alert(`🎉 채점 완료!\n\n맞은 개수: ${correctCount} / ${totalCount}\n점수: ${score}점\n\n${message}`);

        // 5. 이동 (홈으로)
        // ✅ home.html을 쓰는 경우 이게 더 정확함:
        window.location.href = "/";
        // 프로젝트가 / 라우팅 홈이면 아래를 쓰세요:
        // window.location.href = '/';
>>>>>>> 19196ec (home 업데이트(로직 구현중))

    } catch (error) {
        console.error("제출 실패:", error);
        alert(`제출 중 오류가 발생했습니다.\n${error.message}`);
        
        // 실패 시 버튼 복구
        btn.disabled = false;
        btn.textContent = "결과 제출하기";
    }
}

/**
 * [헬퍼] 에러 메시지 표시
 */
function showError(msg) {
    if (quizContent) {
        quizContent.innerHTML = `<div class="loading" style="color:red;">⚠️ ${msg}</div>`;
    } else {
        alert(msg);
    }
}

// DOM 로드 완료 시 시작
<<<<<<< HEAD
document.addEventListener('DOMContentLoaded', loadQuiz);
=======
document.addEventListener('DOMContentLoaded', loadQuiz);
// ===== [추가] 퀴즈 결과를 localStorage progress에 저장 =====
function saveQuizResultToProgress(docId, score, wrongQuestions) {
  const PROGRESS_KEY = "mybook:progress:v1";
  const progress = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
  const doc = progress[docId] || { docId, missedKeywords: [] };

  doc.quiz = {
    done: score >= 80,
    lastScore: score,
    wrongQuestions
  };

  // 놓친 키워드: (질문+정답)에서 단어 뽑기(간단 버전)
  const STOP_WORDS = new Set(["무엇", "의미", "설명", "이란", "하는", "것은", "다음", "중", "옳은", "틀린"]);
  const keywords = new Set(doc.missedKeywords || []);

  wrongQuestions.forEach(wq => {
    const combined = `${wq.question || ""} ${wq.correctAnswer || ""}`;
    combined
      .replace(/[^\w가-힣 ]/g, " ")
      .split(/\s+/)
      .filter(w => w.length >= 2 && !STOP_WORDS.has(w))
      .forEach(w => keywords.add(w));
  });

  doc.missedKeywords = Array.from(keywords).slice(0, 50);
  doc.lastActivityAt = Date.now();

  progress[docId] = doc;
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
}
// ===== [추가 끝] =====
>>>>>>> 22893a8 (feat: home 업데이트(로직 연결중))
