// calendar.js
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

function renderCalendar(state) {
  const grid = document.getElementById("calendarGrid");
  const label = document.getElementById("monthLabel");
  const selectedLabel = document.getElementById("selectedDateLabel");

  if (!grid || !label || !selectedLabel) return;

  const events = loadEvents();
  label.textContent = monthLabel(state.viewDate);

  const first = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth(), 1);
  const last = new Date(state.viewDate.getFullYear(), state.viewDate.getMonth() + 1, 0);

  // 시작 요일 보정(일~토)
  const startDay = first.getDay();
  const totalDays = last.getDate();

  grid.innerHTML = "";

  // 빈칸
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
    const hasEvent = events.some(e => e.date === key);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "day";
    btn.setAttribute("aria-selected", selected === key ? "true" : "false");

    btn.innerHTML = `
      <div class="day__num">${day}${hasEvent ? `<span class="day__dot" aria-hidden="true"></span>` : ""}</div>
    `;

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

  list.innerHTML = events.map(e => `<li>${window.UI.escapeHtml(e.title)}</li>`).join("");
}

function addEvent(date, title) {
  const events = loadEvents();
  events.push({ id: `ev_${Date.now()}`, date, title });
  saveEvents(events);
}

window.Calendar = {
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
  renderEventList,
};
