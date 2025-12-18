import { functions } from "/A.firebase.js"; 
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

const LS_EVENTS = "mybook:calendarEvents";
const LS_SELECTED_DATE = "mybook:selectedDate";

// --------------------------------------------------------
// 데이터 관리
// --------------------------------------------------------
function loadEvents() {
  try { return JSON.parse(localStorage.getItem(LS_EVENTS) || "[]"); } 
  catch { return []; }
}

function saveEvents(events) {
  localStorage.setItem(LS_EVENTS, JSON.stringify(events));
}

function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function monthLabel(date) {
  return date.toLocaleString("ko-KR", { year: "numeric", month: "long" });
}

// --------------------------------------------------------
// [기능 1] 망각곡선 스케줄 생성 및 표시
// --------------------------------------------------------
export async function addReviewSchedule(docId, docTitle) {
    if (!docId) return;

    if (!confirm(`'${docTitle}'의 망각곡선(1, 3, 7, 14, 30일 후) 복습 스케줄을 생성하시겠습니까?`)) return;

    // 1. 로컬 스토리지에 일정 추가 (시각적 표시용)
    const offsets = [1, 3, 7, 14, 30]; // 망각곡선 주기
    const events = loadEvents();
    const today = new Date();
    let addedCount = 0;

    offsets.forEach(dayOffset => {
        const targetDate = new Date(today);
        targetDate.setDate(today.getDate() + dayOffset);
        const dateKey = ymd(targetDate);

        // 중복 방지
        const exists = events.some(e => e.date === dateKey && e.docId === docId && e.type === 'review');
        if (!exists) {
            events.push({
                id: `rev_${docId}_${dayOffset}`,
                date: dateKey,
                title: `[복습] ${docTitle} (${dayOffset}일차)`,
                type: 'review',
                docId: docId,
                docTitle: docTitle // 제목 저장해둠
            });
            addedCount++;
        }
    });

    saveEvents(events);

    // 2. 화면 갱신
    if (window.Calendar && window.Calendar.state) {
        renderCalendar(window.Calendar.state);
        // 오늘 날짜 리스트도 갱신
        renderEventList(window.Calendar.state.selectedDate);
    }

    // 3. 백엔드에도 데이터 준비 (선택 사항: 시연을 위해 백엔드에도 퀴즈 생성 요청)
    try {
        const createFn = httpsCallable(functions, 'createDemoSchedule');
        // forceNow=false로 해서 '내일'부터 시작되게 DB 세팅 (시각적 스케줄과 맞춤)
        await createFn({ docId: docId, title: docTitle, forceNow: false });
        alert(`✅ 캘린더에 ${addedCount}개의 복습 일정이 등록되었습니다.`);
    } catch (e) {
        console.error("백엔드 동기화 실패(무시 가능):", e);
        alert(`✅ 캘린더에 일정이 등록되었습니다.`);
    }
}

// --------------------------------------------------------
// [기능 2] 퀴즈 풀러 가기 (납치 로직)
// --------------------------------------------------------
// 전역에서 접근 가능하도록 window에 등록 (HTML onClick에서 사용)
window.startReviewSession = async function(docId, docTitle) {
    if(!confirm(`'${docTitle}' 복습 퀴즈를 지금 바로 시작하시겠습니까?`)) return;

    try {
        // 1. 강제로 "지금 복습할 시간"으로 설정 (시연용 치트키)
        const createFn = httpsCallable(functions, 'createDemoSchedule');
        await createFn({ docId: docId, title: docTitle, forceNow: true });

        // 2. 세션 생성 및 ID 발급
        const triggerFn = httpsCallable(functions, 'testTriggerNotifications');
        const result = await triggerFn();
        
        if (result.data && result.data.sessionId) {
            window.location.href = `/quiz-page.html?session=${result.data.sessionId}`;
        } else {
            alert("⚠️ 복습할 문제가 없습니다.");
        }
    } catch (error) {
        alert(`오류 발생: ${error.message}`);
    }
};


// --------------------------------------------------------
// 렌더링 로직
// --------------------------------------------------------
function renderCalendar(state) {
  if (window.Calendar) window.Calendar.state = state; 

  const grid = document.getElementById("calendarGrid");
  const label = document.getElementById("monthLabel");
  const selectedLabel = document.getElementById("selectedDateLabel");

  if (!grid || !label || !selectedLabel) return;

  const events = loadEvents();
  label.textContent = monthLabel(state.viewDate);

  const first = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth(), 1);
  const last = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth() + 1, 0);

  const startDay = first.getDay();
  const totalDays = last.getDate();

  grid.innerHTML = "";

  for (let i = 0; i < startDay; i++) {
    const cell = document.createElement("div");
    cell.className = "day";
    cell.style.visibility = "hidden";
    grid.appendChild(cell);
  }

  const selected = state.selectedDate;

  for (let day = 1; day <= totalDays; day++) {
    const date = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth(), day);
    const key = ymd(date);
    
    // 해당 날짜의 이벤트 확인
    const dayEvents = events.filter(e => e.date === key);
    const hasReview = dayEvents.some(e => e.type === 'review');

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "day";
    if (hasReview) btn.classList.add("has-review"); // CSS로 색상 강조
    btn.setAttribute("aria-selected", selected === key ? "true" : "false");

    // 점(dot) 표시
    let dotHtml = "";
    if (dayEvents.length > 0) {
        const dotClass = hasReview ? "day__dot dot--review" : "day__dot";
        dotHtml = `<span class="${dotClass}" aria-hidden="true"></span>`;
    }

    btn.innerHTML = `<div class="day__num">${day}${dotHtml}</div>`;

    btn.addEventListener("click", () => {
      state.selectedDate = key;
      localStorage.setItem(LS_SELECTED_DATE, key);
      renderCalendar(state);
      renderEventList(key);
    });

    grid.appendChild(btn);
  }

  selectedLabel.textContent = `선택 날짜: ${selected || "-"}`;
}

export function renderEventList(dateKey) {
  const list = document.getElementById("eventList");
  if (!list) return;

  const events = loadEvents().filter(e => e.date === dateKey);
  
  if (!dateKey) {
    list.innerHTML = `<li class="muted">날짜를 선택해 주십시오.</li>`;
    return;
  }
  if (events.length === 0) {
    list.innerHTML = `<li class="muted">등록된 일정이 없습니다.</li>`;
    return;
  }

  list.innerHTML = events.map(e => {
    const isReview = e.type === 'review';
    const titleEscaped = e.title ? e.title.replace(/</g, "&lt;") : "제목 없음";
    
    // [핵심] 복습 일정이면 '퀴즈 풀기' 버튼 표시
    let actionBtn = "";
    if (isReview && e.docId) {
        // window.startReviewSession 호출
        actionBtn = `
          <div class="event-actions" style="margin-top:6px;">
            <button class="btn btn--xs btn--primary" 
              onclick="window.startReviewSession('${e.docId}', '${e.docTitle || e.title}')">
              🧠 퀴즈 풀기
            </button>
          </div>
        `;
    }

    return `
      <li class="event-item ${isReview ? 'review-item' : ''}">
        <div class="event-title">${titleEscaped}</div>
        ${actionBtn}
      </li>
    `;
  }).join("");
}

export function addEvent(date, title) {
  const events = loadEvents();
  events.push({ id: `ev_${Date.now()}`, date, title, type: 'manual' });
  saveEvents(events);
}

export function init() {
    const storedSelected = localStorage.getItem(LS_SELECTED_DATE) || "";
    const viewDate = new Date();

    const state = {
      viewDate,
      selectedDate: storedSelected || ymd(new Date()),
    };

    document.getElementById("prevMonthBtn")?.addEventListener("click", () => {
      state.viewDate = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth() - 1, 1);
      renderCalendar(state);
      renderEventList(state.selectedDate);
    });

    document.getElementById("nextMonthBtn")?.addEventListener("click", () => {
      state.viewDate = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth() + 1, 1);
      renderCalendar(state);
      renderEventList(state.selectedDate);
    });

    renderCalendar(state);
    renderEventList(state.selectedDate);

    return state;
}

window.Calendar = {
  state: null,
  init,
  addEvent,
  addReviewSchedule, 
  renderEventList,
};