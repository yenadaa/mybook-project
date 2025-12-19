console.log("HOME.JS (Interactive Mode) Loaded");

import { auth, db } from "/A.firebase.js"; 
import { 
    collection, 
    query, 
    where, 
    onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"; 
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { addReviewSchedule } from './calendar.js';

const LS_ALARM = "mybook:alarmEnabled";

// --------------------------------------------------------
// 1. 유틸리티 & 망각곡선
// --------------------------------------------------------
function clamp(n, a=0, b=100){ return Math.max(a, Math.min(b, Number(n||0))); }

function formatTs(timestamp){
    if (!timestamp) return "-";
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    try { 
        return date.toLocaleString("ko-KR", { 
            month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false 
        }); 
    } catch { return "-"; }
}

function getRetentionLevel(percent) {
    if (percent >= 100) return 5; 
    if (percent >= 80) return 4;
    if (percent >= 60) return 3;
    if (percent >= 40) return 2;
    if (percent >= 20) return 1;
    return 0;
}

function getNextGoalText(percent) {
    const level = getRetentionLevel(percent);
    const goals = [
        "학습 시작! 1일 뒤 첫 복습을 목표로 하세요.",
        "1일차 복습 완료! 3일 뒤 기억이 흐릿해질 때 다시 만나요.",
        "3일차 통과! 이제 일주일 뒤 장기 기억으로 넘깁시다.",
        "7일차 통과! 뇌에 고속도로가 뚫리고 있습니다. 2주 뒤 체크!",
        "14일차 통과! 거의 다 왔습니다. 한 달 뒤면 영구 기억입니다.",
        "🏆 30일차 졸업! 이 내용은 이제 당신의 것입니다."
    ];
    return goals[level];
}

// --------------------------------------------------------
// 2. 렌더링 함수
// --------------------------------------------------------
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

function setRetentionMilestones(percent) {
    const level = getRetentionLevel(percent);
    const ids = ["ms1", "ms3", "ms7", "ms14", "ms30"]; // HTML ID와 일치해야 함 (msRead 등 수정 필요하면 home.html 확인)
    
    // 혹시 home.html을 수정 안 했을까봐 예외처리
    ids.forEach((id, idx) => {
        const el = document.getElementById(id) || document.getElementById(["msRead","msQuiz","msWhite"][idx]); 
        if (el) {
            if (idx < level) {
                el.classList.add("is-done");
                el.style.opacity = "1";
                el.style.fontWeight = "bold";
                el.style.color = "#4CAF50";
            } else {
                el.classList.remove("is-done");
                el.style.opacity = "0.4";
                el.style.fontWeight = "normal";
                el.style.color = "";
            }
        }
    });
}

function renderHero(userEmail, streakDays, doc){
    document.getElementById("userEmail").textContent = userEmail || "로그인 필요";
    document.getElementById("streakDays").textContent = String(streakDays || 0);

    const scheduleBtn = document.getElementById("scheduleReviewBtn");

    if (!doc){
        // 문서 없음 상태 처리
        document.getElementById("currentDocTitle").textContent = "선택된 문서가 없습니다";
        document.getElementById("currentDocSub").textContent = "아래 목록에서 문서를 선택해주세요.";
        document.getElementById("currentProgressText").textContent = "0%";
        document.getElementById("currentProgressFill").style.width = "0%";
        document.getElementById("todayGoal").textContent = "-";
        renderChips([]);
        if (scheduleBtn) scheduleBtn.onclick = () => alert("목록에서 문서를 먼저 선택해주세요.");
        return;
    }

    // 문서 정보 바인딩
    document.getElementById("currentDocTitle").textContent = doc.title || "제목 없음";
    document.getElementById("currentDocSub").textContent = `마지막 학습: ${formatTs(doc.lastActivityAt)}`;

    const p = clamp(doc.progressPercent);
    const level = getRetentionLevel(p);

    document.getElementById("currentProgressText").textContent = `${p}%`;
    document.getElementById("currentProgressFill").style.width = `${p}%`;
    
    const nextDays = [1, 3, 7, 14, 30, "완료"];
    document.getElementById("currentNextStep").textContent = 
        level < 5 ? `다음: ${nextDays[level]}일 후 복습` : "졸업!";

    document.getElementById("todayGoal").textContent = getNextGoalText(p);
    
    renderChips(doc.missedKeywords || []);
    setRetentionMilestones(p); 

    const startBtn = document.getElementById("startTodayBtn");
    if(startBtn) startBtn.onclick = () => gotoIndexWithDoc(doc.docId);

    // 스케줄 버튼 (현재 선택된 문서 기준)
    if (scheduleBtn) {
        scheduleBtn.onclick = async () => {
            if (typeof addReviewSchedule === 'function') {
                await addReviewSchedule(doc.docId, doc.title);
            } else if (window.Calendar && window.Calendar.addReviewSchedule) {
                await window.Calendar.addReviewSchedule(doc.docId, doc.title);
            } else {
                alert("캘린더 로딩 중...");
            }
        };
    }
    
    // 퀵 액션 (현재 선택된 문서 기준)
    document.querySelectorAll("[data-action]").forEach(btn => {
        btn.onclick = () => {
            const action = btn.getAttribute("data-action");
            if (action === "whiteboard") return gotoWhiteboard(doc.docId);
            localStorage.setItem("mybook:requestedAction", action);
            gotoIndexWithDoc(doc.docId);
        };
    });

    renderAI(doc);
}

// ⭐️ [핵심 수정] 목록 렌더링 - 클릭 시 Hero 섹션 업데이트
function renderDocsGrid(docs, userEmail){
    const grid = document.getElementById("docsGrid");
    if (!grid) return;
    grid.innerHTML = "";

    if (!docs || docs.length === 0){
        grid.innerHTML = `<div class="doc-card" style="grid-column:1/-1;">문서가 없습니다.</div>`;
        return;
    }

    docs.forEach(doc => {
        const p = clamp(doc.progressPercent);
        const card = document.createElement("article");
        card.className = "doc-card";
        
        // 현재 선택된 문서 하이라이트
        const currentId = localStorage.getItem("mybook:selectedDocId");
        if(doc.docId === currentId) card.style.border = "2px solid #4CAF50";

        card.innerHTML = `
            <div class="doc-card__title">${doc.title || "제목 없음"}</div>
            <div class="doc-card__meta">
                <span>보존율 ${p}%</span>
                <span>${formatTs(doc.lastActivityAt)}</span>
            </div>
            <div class="doc-card__foot">
                <span class="badge">Lv.${getRetentionLevel(p)}</span>
                <button type="button" class="btn btn--secondary open-viewer-btn">📄 문서 열기</button>
            </div>
        `;
        
        // 1. 카드 배경 클릭 -> 상단(Hero) 정보만 갱신 (뷰어 이동 X)
        card.addEventListener('click', (e) => {
            // 버튼을 눌렀을 땐 이 이벤트가 발생하면 안 됨 (아래 stopPropagation으로 방지됨)
            localStorage.setItem("mybook:selectedDocId", doc.docId);
            localStorage.setItem("mybook:selectedDocTitle", doc.title);
            
            renderHero(userEmail, 0, doc);
            
            document.querySelectorAll('.doc-card').forEach(c => c.style.border = "1px solid #eee");
            card.style.border = "2px solid #4CAF50";
            
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });

        // 2. [열기] 버튼 클릭 -> 무조건 뷰어로 납치 (이게 원하시는 기능!)
        const openBtn = card.querySelector('.open-viewer-btn');
        openBtn.onclick = (e) => {
            e.stopPropagation(); // ✋ 카드 클릭 이벤트가 발생하지 않도록 막음 (중요!)
            
            console.log(`🚀 문서 열기 클릭: ${doc.title} (${doc.docId})`);
            
            // (1) 로컬 스토리지에 "이거 열거야"라고 저장 (뷰어가 이걸 보고 문서를 띄움)
            localStorage.setItem("mybook:selectedDocId", doc.docId);
            localStorage.setItem("mybook:selectedDocTitle", doc.title);
            
            // (2) URL에도 ID를 박아서 이동 (이중 안전장치)
            window.location.href = `/index.html?docId=${encodeURIComponent(doc.docId)}`;
        };
        
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
        ul.innerHTML = `<li class="muted">문서를 선택해주세요.</li>`;
        return;
    }

    const p = clamp(doc.progressPercent);
    const level = getRetentionLevel(p);

    const actions = [];
    if (level === 0) actions.push("1일차 복습 스케줄을 생성하세요.");
    else if (level < 3) actions.push("퀴즈를 풀어 기억을 강화하세요.");
    else actions.push("백지 복습으로 마스터하세요.");

    actions.forEach(t => {
        const li = document.createElement("li");
        li.textContent = t;
        ul.appendChild(li);
    });
    
    const steps = level < 2 
        ? ["5분: 목차 훑어보기", "10분: 하이라이트 정독", "15분: 퀴즈"]
        : ["5분: 오답 노트 확인", "25분: 백지 복습"];
        
    steps.forEach(s => {
        const li = document.createElement("li");
        li.textContent = s;
        routine.appendChild(li);
    });
}

// --------------------------------------------------------
// 3. 네비게이션
// --------------------------------------------------------
function gotoIndexWithDoc(docId){
    if (!docId) { location.href = "/index.html"; return; }
    localStorage.setItem("mybook:selectedDocId", docId);
    location.href = `/index.html?docId=${encodeURIComponent(docId)}`;
}

function gotoWhiteboard(docId){
    location.href = `/whiteboard.html?docId=${encodeURIComponent(docId || "")}`;
}

function bindTabsAndSearch(allDocs, userEmail){
    const tabs = document.querySelectorAll(".tab[data-tab]");
    const searchInput = document.getElementById("docSearch");
    let currentFilter = "incomplete"; 

    function filterAndRender(){
        let result = [...allDocs];
        if (currentFilter === "incomplete") result = result.filter(d => (d.progressPercent||0) < 100);
        else if (currentFilter === "done") result = result.filter(d => (d.progressPercent||0) >= 100);

        const q = searchInput?.value.trim().toLowerCase();
        if (q) result = result.filter(d => (d.title||"").toLowerCase().includes(q));
        
        renderDocsGrid(result, userEmail);
    }

    tabs.forEach(t => {
        t.onclick = () => {
            tabs.forEach(x => { x.classList.remove("is-active"); x.setAttribute("aria-selected", "false"); });
            t.classList.add("is-active"); t.setAttribute("aria-selected", "true");
            currentFilter = t.dataset.tab;
            filterAndRender();
        };
    });

    if(searchInput) searchInput.oninput = filterAndRender;
    filterAndRender();
}

function bindModals(allDocs){
    const showAllBtn = document.getElementById("showAllBtn");
    const closeBtn = document.getElementById("closeAllDocsBtn");
    const modal = document.getElementById("allDocsModal");
    
    if(showAllBtn && modal) {
        showAllBtn.onclick = () => {
            const tbody = document.getElementById("allDocsTbody");
            if(tbody) {
                tbody.innerHTML = allDocs.filter(d => d.progressPercent < 100).map(d => `
                    <tr>
                        <td>${d.title}</td>
                        <td>${getRetentionLevel(d.progressPercent)}단계</td>
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
}

// --------------------------------------------------------
// 4. 초기화
// --------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
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

    onAuthStateChanged(auth, (user) => {
        if (!user) {
            renderHero(null, 0, null);
            renderDocsGrid([], null);
            return;
        }

        console.log(`로그인 감지: ${user.email}`);

        const appId = "default-app-id"; 
        const userDocsPath = `artifacts/${appId}/users/${user.uid}/userDocs`;

        const docsQuery = query(
            collection(db, userDocsPath)
        );

        onSnapshot(docsQuery, (snapshot) => {
            const docs = [];
            snapshot.forEach(d => {
                const data = d.data();
                docs.push({
                    docId: d.id,
                    title: data.title,
                    lastActivityAt: data.lastActivityAt || data.createdAt || new Date(), 
                    createdAt: data.createdAt,
                    progressPercent: data.progressPercent || 0,
                    missedKeywords: data.missedKeywords || []
                });
            });
            
            docs.sort((a, b) => {
                const tA = a.createdAt?.seconds || 0;
                const tB = b.createdAt?.seconds || 0;
                return tB - tA;
            });
            
            console.log(`🔥 문서 ${docs.length}개 로드`);
            
            bindTabsAndSearch(docs, user.email);
            bindModals(docs);
            
            if(docs.length > 0) {
                const selectedId = localStorage.getItem("mybook:selectedDocId");
                const targetDoc = docs.find(d => d.docId === selectedId) || docs[0];
                renderHero(user.email, 0, targetDoc);
            } else {
                renderHero(user.email, 0, null);
            }
        });
    });
});