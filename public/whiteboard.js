// --- [1] 모달 제어 함수 ---
document.addEventListener("DOMContentLoaded", () => {
function showCustomModal(title, text) {
    const modal = document.getElementById('resultModal');
    if (!modal) { alert(title + "\n\n" + text); return; }
    
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').textContent = text;
    modal.style.display = 'flex';
}
function closeCustomModal() {
    const modal = document.getElementById('resultModal');
    if (modal) modal.style.display = 'none';
}

// ⭐️ [중요] 배경을 흰색으로 만들어서 이미지 추출하는 함수
function getCanvasDataURLWithWhiteBackground() {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tCtx = tempCanvas.getContext('2d');

    // 1. 흰색 배경 채우기
    tCtx.fillStyle = '#FFFFFF';
    tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

    // 2. 그 위에 원본 그림 그리기
    tCtx.drawImage(canvas, 0, 0);

    // 3. 이미지 데이터 반환 (base64)
    return tempCanvas.toDataURL('image/png').split(',')[1];
}

// 1. 뒤로가기
function goBack() { window.history.back(); }
document.getElementById('btn-back').addEventListener('click', goBack);

// 2. 변수 및 요소 초기화
const canvasContainer = document.getElementById('canvas-container');
const textContainer = document.getElementById('text-editor-container');
const canvas = document.getElementById('drawingCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const btnModeSwitch = document.getElementById('btn-mode-switch');
const drawingTools = document.getElementById('drawing-tools');

let inputMode = 'drawing'; 
let isDrawing = false; 
let currentTool = 'pen';
let currentChallengeQuestion = null;

// 3. 모드 전환 로직
btnModeSwitch.addEventListener('click', () => {
    if (inputMode === 'drawing') {
        inputMode = 'text';
        btnModeSwitch.textContent = '🎨 그리기 모드';
        canvasContainer.style.display = 'none';
        textContainer.style.display = 'block';
        drawingTools.style.display = 'none';
    } else {
        inputMode = 'drawing';
        btnModeSwitch.textContent = '⌨️ 타이핑 모드';
        canvasContainer.style.display = 'block';
        textContainer.style.display = 'none';
        drawingTools.style.display = 'flex';
        resizeCanvas();
    }
});

// 4. 캔버스 관련 로직
function resizeCanvas() {
    if(canvasContainer.clientWidth === 0) return;
    const temp = ctx.getImageData(0,0,canvas.width, canvas.height);
    canvas.width = canvasContainer.clientWidth;
    canvas.height = canvasContainer.clientHeight;
    try { ctx.putImageData(temp, 0, 0); } catch(e){} 
    
    ctx.lineCap = 'round';
    updateToolStyle();
}
window.addEventListener('resize', resizeCanvas);
setTimeout(resizeCanvas, 100);

function updateToolStyle() {
    ctx.strokeStyle = document.getElementById('colorPicker').value;
    if(currentTool === 'eraser') { 
        ctx.lineWidth = 20; 
        ctx.globalCompositeOperation = 'destination-out'; 
    } else { 
        ctx.lineWidth = 2; 
        ctx.globalCompositeOperation = 'source-over'; 
    }
}

function startDraw(e) { if(inputMode !== 'drawing') return; isDrawing = true; draw(e); }
function endDraw() { isDrawing = false; ctx.beginPath(); }
function draw(e) {
    if(!isDrawing) return;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    
    ctx.lineTo(x, y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y);
    e.preventDefault();
}

canvas.addEventListener('mousedown', startDraw); 
canvas.addEventListener('mousemove', draw);
canvas.addEventListener('mouseup', endDraw); 
canvas.addEventListener('mouseleave', endDraw);
canvas.addEventListener('touchstart', startDraw, {passive: false}); 
canvas.addEventListener('touchmove', draw, {passive: false});
canvas.addEventListener('touchend', endDraw);

document.getElementById('btn-pen').onclick = () => { currentTool='pen'; updateToolStyle(); };
document.getElementById('btn-eraser').onclick = () => { currentTool='eraser'; updateToolStyle(); };
document.getElementById('btn-clear').onclick = () => ctx.clearRect(0,0,canvas.width, canvas.height);
document.getElementById('colorPicker').onchange = () => { currentTool='pen'; updateToolStyle(); };

// --- [수정] 심화 질문 UI 로직 ---
const challengeArea = document.getElementById('challenge-area');
const challengeTextEl = document.getElementById('challenge-text');
const btnChallengeClose = document.getElementById('btn-challenge-close');
const btnOpenChallenge = document.getElementById('btn-open-challenge'); // [추가]

// 1. 질문 세팅 및 열기
function setChallengeMode(question) {
    currentChallengeQuestion = question;
    challengeTextEl.textContent = question;
    
    // 박스 보이기, 다시보기 버튼 숨기기
    challengeArea.style.display = 'block';
    if(btnOpenChallenge) btnOpenChallenge.style.display = 'none';

    const submitBtn = document.getElementById('btn-submit');
    submitBtn.textContent = '💬 답변 제출';
    submitBtn.classList.add('btn-answer');
}

// 2. 닫기 (이제 질문을 삭제하지 않고 숨기기만 함)
function closeChallenge() {
    challengeArea.style.display = 'none';
    
    // 현재 활성화된 질문이 있다면 '다시 보기' 버튼 표시
    if (currentChallengeQuestion) {
        if(btnOpenChallenge) btnOpenChallenge.style.display = 'block';
    }

    // 버튼 상태는 유지 (답변 제출 모드 유지)
    // 만약 닫았을 때 '채점받기'로 돌아가고 싶으면 아래 주석 해제
    /*
    const submitBtn = document.getElementById('btn-submit');
    submitBtn.textContent = '📝 채점받기';
    submitBtn.classList.remove('btn-answer');
    */
}

// 3. [추가] 다시 열기
if(btnOpenChallenge) {
    btnOpenChallenge.addEventListener('click', () => {
        challengeArea.style.display = 'block';
        btnOpenChallenge.style.display = 'none';
    });
}

btnChallengeClose.addEventListener('click', closeChallenge);

// 6. 서버 통신 (API)
// --- [수정] 서버 주소 설정 (각각 따로 설정해야 함!) ---

// 1. 채점/힌트용 주소 (기존 API_URL)
const GRADE_API_URL = "https://gradeblankpaper-kbtdkj4qza-du.a.run.app"; 

// 2. 저장용 주소 (터미널이나 콘솔에서 'saveWhiteboard' 주소 복사해오기)
const SAVE_API_URL = "https://savewhiteboard-kbtdkj4qza-du.a.run.app"; 

// 3. 불러오기용 주소 (터미널이나 콘솔에서 'loadWhiteboard' 주소 복사해오기)
const LOAD_API_URL = "https://loadwhiteboard-kbtdkj4qza-du.a.run.app";

// --- [2] 채점 함수 (수정됨: 흰색 배경 적용) ---
async function submitReview() {
    const loading = document.getElementById('loading');
    try {
        loading.style.display = 'flex';
        
        const payload = {
            bookId: null, 
            targetQuestion: currentChallengeQuestion
        };

        // ⭐️ 여기서 흰색 배경 함수를 호출합니다!
        if (inputMode === 'drawing') {
            payload.imageData = getCanvasDataURLWithWhiteBackground();
        } else {
            const textVal = document.getElementById('typingArea').value.trim();
            if (textVal.length < 2) throw new Error("내용을 입력해주세요!");
            payload.userTextDirect = textVal;
        }

        const res = await fetch(GRADE_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await res.json();
        if (!res.ok || result.error) throw new Error(result.error || `HTTP ${res.status}`);
        
        if (currentChallengeQuestion) {
                showCustomModal("🤖 튜터 피드백", result.feedback || '(피드백 없음)');

                if (result.next_question) setChallengeMode(result.next_question);
                else closeChallenge();
        } else {
                // [수정] 점수 표시 제거 -> 잘한점/부족한점 상세 표시
                let msg = `📋 [학습 피드백]\n\n${result.feedback || ''}\n`;
                
                if (result.good_points) {
                msg += `\n✅ [잘한 점]\n${result.good_points}\n`;
                }
                
                if (result.weak_points) {
                msg += `\n⚠️ [보완할 점]\n${result.weak_points}\n`;
                }

                // 심화 질문이 있으면 메시지에 추가
                if (result.challenge_question) {
                setChallengeMode(result.challenge_question);
                msg += "\n🔥 [알림] 심화 질문이 도착했습니다! 상단을 확인하세요.";
                }
                
                showCustomModal("📝 분석 완료", msg);
        }

    } catch (err) {
        showCustomModal("오류 발생", err.message);
    } finally {
        loading.style.display = 'none';
    }
}

// --- [3] 힌트 함수 (수정됨: 흰색 배경 적용) ---
async function requestHint() {
    const loading = document.getElementById('loading');
    try {
        loading.style.display = 'flex';
        const payload = { bookId: null, isHint: true };

        // ⭐️ 여기서도 흰색 배경 함수 호출!
        if (inputMode === 'drawing') {
            payload.imageData = getCanvasDataURLWithWhiteBackground();
        } else {
            const textVal = document.getElementById('typingArea').value.trim();
            if (!textVal) throw new Error("내용이 없습니다.");
            payload.userTextDirect = textVal;
        }
        const res = await fetch(GRADE_API_URL, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await res.json();
        if(!res.ok) throw new Error(result.error);
        
        showCustomModal("💡 AI 힌트", result.feedback);
    } catch(err) {
        showCustomModal("오류", err.message);
    } finally {
        loading.style.display = 'none';
    }
}
// --- [추가] 대화 기록 패널 열고 닫기 ---
const panel = document.getElementById('session-questions-panel');
const openBtn = document.getElementById('btn-open-panel');
const closeBtn = document.getElementById('btn-close-panel');
const contentArea = document.querySelector('.content-area'); // 메인 영역

// 닫기 버튼 클릭 시
closeBtn.addEventListener('click', () => {
    panel.style.display = 'none';
    openBtn.style.display = 'block'; // 열기 버튼 보이기
    
    // 메인 영역 넓게 쓰기 (반응형)
    contentArea.style.width = 'calc(100% - 24px)';
    resizeCanvas(); // 캔버스 크기 재조정
});

// 열기 버튼 클릭 시
openBtn.addEventListener('click', () => {
    panel.style.display = 'flex';
    openBtn.style.display = 'none'; // 열기 버튼 숨기기
    
    // 메인 영역 원래대로 (PC 기준)
    if (window.innerWidth > 1000) {
        contentArea.style.width = 'calc(100% - 24px - 380px)';
    }
    resizeCanvas(); // 캔버스 크기 재조정
});

document.getElementById('btn-submit').addEventListener('click', submitReview);
document.getElementById('btn-hint').addEventListener('click', requestHint);
// --- [추가] 임시 저장 및 불러오기 로직 (localStorage) ---
const STORAGE_KEY = 'mybook_whiteboard_temp';
const currentBookId = "test-book-1"; 

// 1. 서버 저장 (Python API 호출)
async function saveTempData() {
    const loading = document.getElementById('loading');
    try {
        loading.style.display = 'flex';
        loading.querySelector('span').textContent = "서버에 저장 중... 💾";
        
        const payload = {
            bookId: currentBookId,
            text: document.getElementById('typingArea').value,
            imageData: canvas.toDataURL() 
        };

        const res = await fetch(SAVE_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error("서버 응답 오류");

        showCustomModal("✅ 저장 완료", "파이어베이스 DB에 안전하게 저장했습니다!");

    } catch (e) {
        showCustomModal("❌ 저장 실패", e.message);
    } finally {
        loading.style.display = 'none';
        loading.querySelector('span').textContent = "AI 선생님이 채점 중입니다... 🤖";
    }
}
// 2. 서버 불러오기 (Python API 호출)
async function loadTempData() {
    console.log("Loading data for Book ID:", currentBookId);
    const loading = document.getElementById('loading');
    
    try {
        loading.style.display = 'flex';
        loading.querySelector('span').textContent = "기록 불러오는 중... 📂";

        const res = await fetch(LOAD_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bookId: currentBookId })
        });

        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`서버 에러 (${res.status}): ${errorText}`);
        }

        const data = await res.json();

        // 1. 텍스트 복원
        if (data.text) {
            document.getElementById('typingArea').value = data.text;
        }
        
        // 2. 그림 복원 (여기가 중요!)
        if (data.imageData) {
            const img = new Image();
            
            // ⭐️ [핵심] 명찰(헤더)이 없으면 강제로 붙여주기
            let imageSrc = data.imageData;
            if (!imageSrc.startsWith('data:image')) {
                imageSrc = 'data:image/png;base64,' + imageSrc;
            }

            img.onload = function() {
                // 캔버스 깨끗이 지우기
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                
                // ⭐️ [핵심] 그림을 현재 캔버스 크기에 딱 맞게 늘려서 그리기
                // (저장할 때랑 불러올 때 창 크기가 달라도 문제 없게 함)
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            };
            
            img.src = imageSrc; // 이미지 로딩 시작

        } else if (!data.text) {
             showCustomModal("알림", "저장된 기록이 없습니다.");
             return; // finally로 넘어감
        }

        showCustomModal("📂 로드 완료", "지난 학습 내용을 가져왔습니다.");

    } catch (e) {
        console.error(e);
        showCustomModal("❌ 오류", e.message);
    } finally {
        loading.style.display = 'none';
        loading.querySelector('span').textContent = "AI 선생님이 채점 중입니다... 🤖";
    }
}
// 이벤트 리스너 등록
document.getElementById('btn-save-temp').addEventListener('click', saveTempData);
document.getElementById('btn-load-temp').addEventListener('click', loadTempData);
document.getElementById('btn-modal-close').addEventListener('click', closeCustomModal);
});