console.log("HOME.JS (Hybrid Import Version) Loaded");

// 1. [공유] 로그인 정보와 DB 연결은 롤백된 A.firebase.js에서 가져옵니다. (로그인 유지됨)
import { auth, db } from "/A.firebase.js"; 

// 2. [도구] A.firebase.js가 안 주는 기능들은 CDN에서 직접 가져옵니다.
import { 
    collection, 
    query, 
    orderBy, 
    onSnapshot,
    getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { 
    onAuthStateChanged, 
    signOut 
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// UI 설정값 (알림 설정 등은 로컬에 둬도 무방)
const LS_ALARM = "mybook:alarmEnabled";

// ========================================================
// 1. 유틸리티 함수 (Utility Functions)
// ========================================================
function clamp(n, a=0, b=100){ 
    n = Number(n||0); 
    return Math.max(a, Math.min(b, n)); 
}

function formatTs(timestamp){
    if (!timestamp) return "-";
    // Firestore Timestamp 객체 처리
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    try { 
        return date.toLocaleString("ko-KR", { 
            month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false 
        }); 
    } catch { return "-"; }
}

function nextStepByPercent(p){
    // 진행도에 따른 다음 단계 추천 텍스트
    if (window.UI?.getNextStepLabel) return window.UI.getNextStepLabel(p);
    return (p < 40 ? "정독 계속" : p < 75 ? "퀴즈" : p < 100 ? "백지 복습" : "완료");
}

function buildTodayGoal(doc){
    const p = doc?.progressPercent ?? 0;
    if (p < 40) return "오늘은 1차 학습(정독 & 구조화)에 집중하세요. 하이라이트/태그/노트/OCR로 구조를 잡으세요.";
    if (p < 75) return "오늘은 이해 확인 단계입니다. 하이라이트 퀴즈 → 전체 문서 퀴즈 순으로 풀어보세요.";
    if (p < 100) return "오늘은 기억 강화 단계입니다. 백지 복습으로 안 보고 설명하는 연습을 하세요.";
    return "이 문서는 완료 상태입니다. 시험 직전 심화 질문으로 마무리하세요.";
}

// ========================================================
// 2. 렌더링 함수 (Render Functions)
// ========================================================

function renderChips(list){
    const chips = document.getElementById("missedKeywords");
    const hint = document.getElementById("missedHint");
    if (!chips || !hint) return;
    
    chips.innerHTML = "";
    const arr = (list || []).filter(Boolean).slice(0, 10);
    
    if (arr.length === 0){
        hint.style.display = "block";
    } else {
        hint.style.display = "none";
        arr.forEach(k => {
            const li = document.createElement("li");
            li.className = "chip";
            li.textContent = k;
            chips.appendChild(li);
        });
    }
}

function setMilestones(doc){
    const msRead = document.getElementById("msRead");
    const msQuiz = document.getElementById("msQuiz");
    const msWhite = document.getElementById("msWhite");
    
    if(msRead) msRead.classList.toggle("is-done", p >= 40); // 단순화된 로직 (진행률 기반)
    if(msQuiz) msQuiz.classList.toggle("is-done", p >= 75);
    if(msWhite) msWhite.classList.toggle("is-done", p >= 100);
    
    // DB에 세부 플래그가 있다면 그걸 우선 사용
    if (doc?.firstStudy?.done && msRead) msRead.classList.add("is-done");
}

// [핵심] Hero 섹션 렌더링 (가장 최근 문서)
function renderHero(userEmail, streakDays, doc){
    document.getElementById("userEmail").textContent = userEmail || "로그인 필요";
    document.getElementById("streakDays").textContent = String(streakDays || 0);

    const scheduleBtn = document.getElementById("scheduleReviewBtn");

    // 1) 문서가 없을 때
    if (!doc){
        document.getElementById("currentDocTitle").textContent = "학습 중인 문서가 없습니다";
        document.getElementById("currentDocSub").textContent = "문서를 업로드하면 여기에 나타납니다.";
        document.getElementById("currentProgressText").textContent = "0%";
        document.getElementById("currentProgressFill").style.width = "0%";
        document.getElementById("currentNextStep").textContent = "다음 추천: 문서 업로드";
        document.getElementById("todayGoal").textContent = "새로운 문서를 업로드하고 학습을 시작해보세요!";
        renderChips([]);
        
        if (scheduleBtn) {
            scheduleBtn.onclick = () => alert("먼저 문서를 열어주세요!");
        }
        return;
    }

    // 2) 문서가 있을 때
    document.getElementById("currentDocTitle").textContent = doc.title || "제목 없음";
    document.getElementById("currentDocSub").textContent = `마지막 학습: ${formatTs(doc.lastActivityAt)}`;

    const p = clamp(doc.progressPercent);
    document.getElementById("currentProgressText").textContent = `${p}%`;
    document.getElementById("currentProgressFill").style.width = `${p}%`;
    document.getElementById("currentNextStep").textContent = `다음 추천: ${nextStepByPercent(p)}`;
    document.getElementById("todayGoal").textContent = buildTodayGoal(doc);
    
    renderChips(doc.missedKeywords || []);
    // setMilestones(doc); // 필요시 주석 해제

    // 버튼 이벤트 연결
    const startBtn = document.getElementById("startTodayBtn");
    if(startBtn) {
        startBtn.onclick = () => gotoIndexWithDoc(doc.docId);
    }

    // 망각곡선 버튼 연결
    if (scheduleBtn) {
        scheduleBtn.onclick = () => {
            if(confirm(`'${doc.title}' 학습 스케줄(1,3,7,14,30일 후)을 캘린더에 등록할까요?`)) {
                if (window.Calendar && window.Calendar.addReviewSchedule) {
                    window.Calendar.addReviewSchedule(doc.docId, doc.title);
                } else {
                    alert("캘린더 모듈이 로드되지 않았습니다.");
                }
            }
        };
    }
    
    // 퀵 액션 버튼
    document.querySelectorAll("[data-action]").forEach(btn => {
        btn.onclick = () => {
            const action = btn.getAttribute("data-action");
            if (action === "whiteboard") return gotoWhiteboard(doc.docId);
            // 뷰어로 이동하면서 액션 전달
            localStorage.setItem("mybook:requestedAction", action);
            gotoIndexWithDoc(doc.docId);
        };
    });

    // AI 추천 렌더링
    renderAI(doc);
}

function renderDocsGrid(docs){
    const grid = document.getElementById("docsGrid");
    if (!grid) return;
    grid.innerHTML = "";

    if (!docs || docs.length === 0){
        grid.innerHTML = `
            <div class="doc-card" style="grid-column:1/-1;">
                <div class="doc-card__title">문서가 없습니다</div>
                <div class="doc-card__meta"><span>우측 상단 '문서 업로드'를 이용하세요.</span></div>
            </div>
        `;
        return;
    }

    docs.forEach(doc => {
        const p = clamp(doc.progressPercent);
        const card = document.createElement("article");
        card.className = "doc-card";
        card.innerHTML = `
            <div class="doc-card__title">${doc.title || "제목 없음"}</div>
            <div class="doc-card__meta">
                <span>진도 ${p}%</span>
                <span>${formatTs(doc.lastActivityAt)}</span>
            </div>
            <div class="doc-card__foot">
                <span class="badge">${nextStepByPercent(p)}</span>
                <button type="button" class="btn btn--secondary">열기</button>
            </div>
        `;
        
        // 클릭 시 뷰어로 이동
        const move = () => gotoIndexWithDoc(doc.docId);
        card.querySelector("button").onclick = move;
        card.ondblclick = move;
        
        grid.appendChild(card);
    });
}

function renderAI(doc){
    const ul = document.getElementById("aiActionList");
    const routine = document.getElementById("aiRoutine");
    if (!ul || !routine) return;
    
    ul.innerHTML = "";
    routine.innerHTML = "";

    if (!doc) {
        ul.innerHTML = `<li class="muted">최근 학습한 문서가 없습니다.</li>`;
        return;
    }

    const p = clamp(doc.progressPercent);
    // 간단한 추천 로직
    const actions = [];
    if (p < 40) actions.push("구조화(목차/하이라이트)를 먼저 진행하세요.");
    else if (p < 75) actions.push("퀴즈를 통해 이해도를 점검하세요.");
    else actions.push("백지 복습으로 장기 기억을 강화하세요.");

    actions.forEach(t => {
        const li = document.createElement("li");
        li.textContent = t;
        ul.appendChild(li);
    });
    
    // 루틴 추천 (단순화)
    const steps = p < 50 
        ? ["10분: 하이라이트/구조잡기", "10분: 주요 용어 태깅", "10분: 요약 노트 작성"]
        : ["10분: 하이라이트 퀴즈", "10분: 오답 노트 확인", "10분: 백지 복습"];
        
    steps.forEach(s => {
        const li = document.createElement("li");
        li.textContent = s;
        routine.appendChild(li);
    });
}

// ========================================================
// 3. 네비게이션 & 이벤트 (Navigation & Events)
// ========================================================

function gotoIndexWithDoc(docId){
    if (!docId) { 
        location.href = "/index.html"; 
        return; 
    }
    // 뷰어는 URL 쿼리스트링이나 로컬스토리지 ID를 참조할 수 있음
    // 여기서는 로컬스토리지에 '다음에 열 문서 ID'를 남겨두고 이동
    localStorage.setItem("mybook:selectedDocId", docId);
    location.href = `/index.html?docId=${encodeURIComponent(docId)}`;
}

function gotoWhiteboard(docId){
    location.href = `/whiteboard.html?docId=${encodeURIComponent(docId || "")}`;
}

function bindTabsAndSearch(allDocs){
    // 탭 전환 로직
    const tabs = document.querySelectorAll(".tab[data-tab]");
    const searchInput = document.getElementById("docSearch");
    let currentFilter = "incomplete"; // incomplete, recent, done

    function filterAndRender(){
        let result = [...allDocs];
        
        // 1. 탭 필터
        if (currentFilter === "incomplete") result = result.filter(d => (d.progressPercent||0) < 100);
        else if (currentFilter === "done") result = result.filter(d => (d.progressPercent||0) >= 100);
        // recent는 전체 보여주되 정렬만 함 (기본이 정렬되어 있음)

        // 2. 검색 필터
        const q = searchInput?.value.trim().toLowerCase();
        if (q) {
            result = result.filter(d => (d.title||"").toLowerCase().includes(q));
        }
        
        renderDocsGrid(result);
    }

    tabs.forEach(t => {
        t.onclick = () => {
            tabs.forEach(x => {
                x.classList.remove("is-active");
                x.setAttribute("aria-selected", "false");
            });
            t.classList.add("is-active");
            t.setAttribute("aria-selected", "true");
            currentFilter = t.dataset.tab;
            filterAndRender();
        };
    });

    if(searchInput) {
        searchInput.oninput = filterAndRender;
    }
    
    // 초기 렌더링
    filterAndRender();
}

function bindModals(allDocs){
    // "미완료 모두 보기" 등 모달 로직
    const showAllBtn = document.getElementById("showAllBtn");
    const closeBtn = document.getElementById("closeAllDocsBtn");
    const modal = document.getElementById("allDocsModal");
    
    if(showAllBtn && modal) {
        showAllBtn.onclick = () => {
            // 모달 내용 채우기
            const tbody = document.getElementById("allDocsTbody");
            if(tbody) {
                tbody.innerHTML = allDocs.filter(d => d.progressPercent < 100).map(d => `
                    <tr>
                        <td>${d.title}</td>
                        <td>${clamp(d.progressPercent)}%</td>
                        <td><button class="btn btn--xs" onclick="location.href='/index.html?docId=${d.docId}'">열기</button></td>
                    </tr>
                `).join("");
            }
            modal.showModal ? modal.showModal() : (modal.style.display = "block");
        };
    }
    
    if(closeBtn && modal) {
        closeBtn.onclick = () => modal.close ? modal.close() : (modal.style.display = "none");
    }

    // 일정 추가 모달 등은 필요시 추가...
}

// ========================================================
// 4. 초기화 및 DB 리스너 (Init & Listeners)
// ========================================================

document.addEventListener("DOMContentLoaded", () => {
    // 캘린더 초기화
    if(window.Calendar && window.Calendar.init) window.Calendar.init();

    const alarmBtn = document.getElementById("alarmBtn");
    if(alarmBtn){
        const isAppAlarmOn = (localStorage.getItem(LS_ALARM) !== "false");
        alarmBtn.textContent = isAppAlarmOn ? "알림 켜짐" : "알림 꺼짐";
        alarmBtn.onclick = () => {
            const next = !(localStorage.getItem(LS_ALARM) !== "false");
            localStorage.setItem(LS_ALARM, next);
            alarmBtn.textContent = next ? "알림 켜짐" : "알림 꺼짐";
        };
    }

    // 🔥 [수정] getAuth() 호출 삭제! 그냥 import한 'auth'를 씁니다.
    // 기존: const auth = getAuth();  <-- 이거 때문에 에러 났음
    
    onAuthStateChanged(auth, (user) => {
        if (!user) {
            console.log("로그아웃 상태");
            renderHero(null, 0, null);
            renderDocsGrid([]);
            return;
        }

        console.log(`로그인 감지: ${user.email}`);

        // 🔥 [수정] 롤백된 doc_firebase.js가 저장하는 경로("userDocs")로 맞춰줍니다.
        const appId = "default-app-id"; // 롤백된 파일에 있던 ID
        const userDocsPath = `artifacts/${appId}/users/${user.uid}/userDocs`;

        const docsQuery = query(
            collection(db, userDocsPath), 
            orderBy("createdAt", "desc") // 롤백된 버전은 lastActivityAt 대신 createdAt을 씀
        );

        onSnapshot(docsQuery, (snapshot) => {
            const docs = [];
            snapshot.forEach(d => {
                // 롤백된 데이터 구조에 맞춰 매핑
                const data = d.data();
                docs.push({
                    docId: d.id,
                    title: data.title,
                    lastActivityAt: data.createdAt, // createdAt을 lastActivityAt처럼 사용
                    progressPercent: 0 // 구버전엔 진행률이 없으므로 0 처리
                });
            });
            
            console.log(`🔥 DB 업데이트 수신: ${docs.length}개`);
            
            // (이후 렌더링 코드는 동일)
            bindTabsAndSearch(docs);
            bindModals(docs);
            renderHero(user.email, 0, docs[0]);
        });
    });
});