// calendar.js

// 1. [핵심] Firebase Functions 기능을 사용하기 위해 Import
import { functions, httpsCallable } from "/A.firebase.js"; 

const LS_EVENTS = "mybook:calendarEvents";
const LS_SELECTED_DATE = "mybook:selectedDate";

function loadEvents() {
  try {
    return JSON.parse(localStorage.getItem(LS_EVENTS) || "[]");
  } catch {
    return [];
  }
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

// =========================================================
// [수정] 망각곡선 스케줄 생성 (백엔드 연동 버전)
// =========================================================
async function addReviewSchedule(docId, docTitle) {
    if (!docId) return;
    
    // 1. 테스트 모드 여부 확인 (시연용)
    const isTestMode = confirm(
        `'${docTitle}'의 복습 스케줄을 생성합니다.\n\n[확인] = 지금 당장 알림 테스트 (시연용)\n[취소] = 내일부터 정상 스케줄 시작`
    );

    try {
        console.log(`📡 스케줄 생성 요청: ${docTitle} (TestMode: ${isTestMode})`);
        
        // 2. 파이썬 백엔드 호출 (createDemoSchedule)
        const createScheduleFn = httpsCallable(functions, 'createDemoSchedule');
        
        const result = await createScheduleFn({
            docId: docId,
            title: docTitle,
            forceNow: isTestMode // True면 1분 전으로 시간 조작
        });

        const data = result.data;
        
        // 3. 로컬 캘린더에도 표시를 위해 더미 이벤트 추가 (시각적 피드백용)
        const today = new Date();
        const targetDate = isTestMode ? today : new Date(today.setDate(today.getDate() + 1));
        const dateKey = ymd(targetDate);
        
        const events = loadEvents();
        events.push({
             id: `rev_${Date.now()}`,
             date: dateKey,
             title: `📖 ${isTestMode ? '[즉시]' : '[내일]'} 복습: ${docTitle}`,
             docId: docId,
             type: 'review'
        });
        saveEvents(events);

        alert(`✅ ${data.message}`);

        // 4. '지금 당장' 모드라면 알림 강제 발송 트리거
        if (isTestMode) {
            console.log("🚀 알림 강제 발송 요청 중...");
            const triggerNotifyFn = httpsCallable(functions, 'testTriggerNotifications');
            await triggerNotifyFn(); 
            alert("📩 알림 발송 완료! (FCM 혹은 콘솔 확인)");
        }

        // 현재 화면 갱신
        const state = window.Calendar.state; 
        if(state) {
            renderCalendar(state);
            renderEventList(state.selectedDate);
        }

    } catch (error) {
        console.error("스케줄 생성 실패:", error);
        alert(`오류 발생: ${error.message}`);
    }
}


function renderCalendar(state) {
  // 전역 state 참조를 위해 저장
  window.Calendar.state = state; 

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
    
    // 이벤트가 있는지 확인 (복습 일정은 색상을 다르게 표시할 수도 있음)
    const dayEvents = events.filter(e => e.date === key);
    const hasEvent = dayEvents.length > 0;
    const hasReview = dayEvents.some(e => e.type === 'review');

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "day";
    if (hasReview) btn.classList.add("has-review"); // CSS로 색상 다르게 처리 가능
    btn.setAttribute("aria-selected", selected === key ? "true" : "false");

    // 점(dot) 표시 로직
    let dotHtml = "";
    if (hasEvent) {
        // 복습 일정이면 빨간 점, 일반 일정이면 기본 점 (예시)
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

function renderEventList(dateKey) {
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

  // [수정] 일정 리스트 렌더링 (복습 버튼 추가)
  list.innerHTML = events.map(e => {
    const isReview = e.type === 'review';
    const titleEscaped = window.UI?.escapeHtml ? window.UI.escapeHtml(e.title) : e.title;
    
    // 복습 일정이면 '학습하러 가기' 버튼 표시
    let actionBtn = "";
    if (isReview && e.docId) {
        actionBtn = `
          <div class="event-actions" style="margin-top:4px;">
            <button class="btn btn--xs btn--primary" onclick="location.href='../index.html?docId=${encodeURIComponent(e.docId)}'">📄 문서 보기</button>
            <button class="btn btn--xs btn--secondary" onclick="location.href='../whiteboard.html?docId=${encodeURIComponent(e.docId)}'">📝 백지 복습</button>
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

function addEvent(date, title) {
  const events = loadEvents();
  events.push({ id: `ev_${Date.now()}`, date, title, type: 'manual' });
  saveEvents(events);
}

// 전역 객체 노출
window.Calendar = {
  state: null, // renderCalendar에서 갱신됨
  init() {
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
  },

  addEvent,
  addReviewSchedule, // 백엔드 연동된 함수
  renderEventList,
};