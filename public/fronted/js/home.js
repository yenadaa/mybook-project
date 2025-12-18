console.log("HOME.JS (Forgetting Curve Mode) Loaded");

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
// 1. 유틸리티 & 망각곡선 로직
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

// 🔥 [핵심] 진행률(%)을 망각곡선 단계(Level)로 변환
function getRetentionLevel(percent) {
    if (percent >= 100) return 5; // 30일차 완료 (마스터)
    if (percent >= 80) return 4;  // 14일차 완료
    if (percent >= 60) return 3;  // 7일차 완료
    if (percent >= 40) return 2;  // 3일차 완료
    if (percent >= 20) return 1;  // 1일차 완료
    return 0;                     // 시작 전
}

// 🔥 [핵심] 다음 목표 텍스트
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

// ⭐️ [중요] 마일스톤(1,3,7,14,30일) 색칠하기
function setRetentionMilestones(percent) {
    const level = getRetentionLevel(percent);
    // home.html의 ID들과 매칭
    const ids = ["ms1", "ms3", "ms7", "ms14", "ms30"];
    
    ids.forEach((id, idx) => {
        const el = document.getElementById(id);
        if (el) {
            // 현재 레벨보다 낮거나 같으면 '완료(is-done)' 처리
            if (idx < level) {
                el.classList.add("is-done");
                el.style.opacity = "1";
                el.style.fontWeight = "bold";
                el.style.color = "#4CAF50"; // 초록색 강조
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

    // 1) 문서 없음
    if (!doc){
        document.getElementById("currentDocTitle").textContent = "학습 중인 문서가 없습니다";
        document.getElementById("currentDocSub").textContent = "문서를 업로드하면 여기에 나타납니다.";
        document.getElementById("currentProgressText").textContent = "0%";
        document.getElementById("currentProgressFill").style.width = "0%";
        document.getElementById("currentNextStep").textContent = "다음 추천: 문서 업로드";
        document.getElementById("todayGoal").textContent = "새로운 문서를 업로드하고 학습을 시작해보세요!";
        renderChips([]);
        if (scheduleBtn) scheduleBtn.onclick = () => alert("먼저 문서를 열어주세요!");
        return;
    }

    // 2) 문서 있음
    document.getElementById("currentDocTitle").textContent = doc.title || "제목 없음";
    document.getElementById("currentDocSub").textContent = `마지막 학습: ${formatTs(doc.lastActivityAt)}`;

    const p = clamp(doc.progressPercent);
    const level = getRetentionLevel(p);

    // 🔥 [변경] 텍스트를 '학습 진도' -> '기억 보존율' 느낌으로 변경
    document.querySelector(".progress__label").textContent = "기억 보존율 (망각곡선)";
    document.getElementById("currentProgressText").textContent = `${p}%`; // or `Lv.${level}`
    document.getElementById("currentProgressFill").style.width = `${p}%`;
    
    // 다음 단계 멘트
    const nextDays = [1, 3, 7, 14, 30, "완료"];
    document.getElementById("currentNextStep").textContent = 
        level < 5 ? `다음 복습: ${nextDays[level]}일 후` : "모든 복습 완료!";

    document.getElementById("todayGoal").textContent = getNextGoalText(p);
    
    // 칩 & 마일스톤 렌더링
    renderChips(doc.missedKeywords || []);
    setRetentionMilestones(p); 

    const startBtn = document.getElementById("startTodayBtn");
    if(startBtn) startBtn.onclick = () => gotoIndexWithDoc(doc.docId);

    // 스케줄 버튼
    if (scheduleBtn) {
        scheduleBtn.onclick = async () => {
            if (typeof addReviewSchedule === 'function') {
                await addReviewSchedule(doc.docId, doc.title);
            } else if (window.Calendar && window.Calendar.addReviewSchedule) {
                await window.Calendar.addReviewSchedule(doc.docId, doc.title);
            } else {
                alert("캘린더 기능을 불러오는 중입니다.");
            }
        };
    }
    
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
                <span>보존율 ${p}%</span>
                <span>${formatTs(doc.lastActivityAt)}</span>
            </div>
            <div class="doc-card__foot">
                <span class="badge">Lv.${getRetentionLevel(p)}</span>
                <button type="button" class="btn btn--secondary">열기</button>
            </div>
        `;
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
    const level = getRetentionLevel(p);

    const actions = [];
    if (level === 0) actions.push("아직 초기 단계입니다. 1일차 복습을 예약하세요.");
    else if (level < 3) actions.push("기억이 휘발되기 전입니다. 퀴즈로 꽉 잡으세요.");
    else actions.push("장기 기억 단계입니다. 백지 복습으로 인출 연습을 하세요.");

    actions.forEach(t => {
        const li = document.createElement("li");
        li.textContent = t;
        ul.appendChild(li);
    });
    
    // 루틴도 레벨에 맞춰 추천
    const steps = level < 2 
        ? ["5분: 목차 훑어보기", "10분: 하이라이트 다시 읽기", "15분: 퀴즈 풀기"]
        : ["5분: 지난 퀴즈 오답 확인", "25분: 백지 복습 (아무것도 안 보고 쓰기)"];
        
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

function bindTabsAndSearch(allDocs){
    const tabs = document.querySelectorAll(".tab[data-tab]");
    const searchInput = document.getElementById("docSearch");
    let currentFilter = "incomplete"; 

    function filterAndRender(){
        let result = [...allDocs];
        if (currentFilter === "incomplete") result = result.filter(d => (d.progressPercent||0) < 100);
        else if (currentFilter === "done") result = result.filter(d => (d.progressPercent||0) >= 100);

        const q = searchInput?.value.trim().toLowerCase();
        if (q) result = result.filter(d => (d.title||"").toLowerCase().includes(q));
        
        renderDocsGrid(result);
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
                        <td>${getRetentionLevel(d.progressPercent)}단계 (${d.progressPercent}%)</td>
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
            renderDocsGrid([]);
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
            
            console.log(`🔥 문서 ${docs.length}개 로드 완료`);
            
            bindTabsAndSearch(docs);
            bindModals(docs);
            
            if(docs.length > 0) {
                const selectedId = localStorage.getItem("mybook:selectedDocId");
                const targetDoc = docs.find(d => d.docId === selectedId) || docs[0];
                
                localStorage.setItem("mybook:selectedDocId", targetDoc.docId);
                localStorage.setItem("mybook:selectedDocTitle", targetDoc.title);
                
                renderHero(user.email, 0, targetDoc);
            } else {
                renderHero(user.email, 0, null);
            }
        });
    });
});