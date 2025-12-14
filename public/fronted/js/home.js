console.log("HOME.JS VERSION = 2025-12-15-02");

// home.js (real local progress driven)
// Data source: localStorage "mybook:progress:v1", "mybook:streak:v1"

const LS_ALARM = "mybook:alarmEnabled";
const PROGRESS_KEY = "mybook:progress:v1";
const STREAK_KEY = "mybook:streak:v1";

function safeParse(str, fallback) { try { return JSON.parse(str); } catch { return fallback; } }
function clamp(n, a=0, b=100){ n = Number(n||0); return Math.max(a, Math.min(b, n)); }

function getProgressAll(){
  const raw = localStorage.getItem(PROGRESS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? parsed : {};
  } catch {
    return {};
  }
}

function getStreak(){
  const raw = localStorage.getItem(STREAK_KEY);
  if (!raw) {
    // 최초 방문 기본값
    return { days: 0, lastDate: "" };
  }

  try {
    const s = JSON.parse(raw);
    return {
      days: Number(s?.days || 0),
      lastDate: s?.lastDate || ""
    };
  } catch {
    // 깨진 데이터 방어
    return { days: 0, lastDate: "" };
  }
}

function computeProgressPercent(doc){
  // 기준(요청 6): 1차 학습 40 + 퀴즈 35 + 백지복습 25
  let p = 0;
  if (doc?.firstStudy?.done) p += 40;
  if (doc?.quiz?.done) p += 35;
  if (doc?.whiteboard?.done) p += 25;
  return clamp(p);
}

function nextStepByPercent(p){
  // UI.js helper 사용(있으면)
  return (window.UI?.getNextStepLabel ? window.UI.getNextStepLabel(p) : (p<40?"정독 계속":p<75?"퀴즈":p<100?"백지 복습":"완료"));
}

function formatTs(ms){
  if (!ms) return "-";
  try { return new Date(ms).toLocaleString("ko-KR", { hour12:false }); } catch { return "-"; }
}

function pickCurrentDocId(allDocs){
  const docsObj = (allDocs && typeof allDocs === "object") ? allDocs : {};

  const selected = localStorage.getItem("mybook:selectedDocId");
  if (selected && docsObj[selected]) return selected;

  const docs = Object.values(docsObj);
  docs.sort((a,b) => (b.lastActivityAt||0) - (a.lastActivityAt||0));
  return docs[0]?.docId || null;
}


function buildDocs(all){
  const docs = Object.values(all || {}).map(d => ({
    ...d,
    progressPercent: computeProgressPercent(d),
    lastStudiedAt: d.lastActivityAt || d.lastOpenedAt || 0,
  }));

  // title 없는 경우 안전 처리
  docs.forEach(d => { if (!d.title) d.title = d.docId; });

  const recent = [...docs].sort((a,b) => (b.lastStudiedAt||0) - (a.lastStudiedAt||0));
  const incomplete = recent.filter(d => d.progressPercent < 100);
  const done = recent.filter(d => d.progressPercent >= 100);

  return { all: recent, incomplete, recent, done };
}

function buildTodayGoal(doc){
  const p = doc?.progressPercent ?? 0;

  if (p < 40){
    return "오늘은 1차 학습(정독 & 구조화)에 집중하세요. 하이라이트/태그/노트/OCR로 '시험에 나올 구조'를 먼저 잡는 게 목표입니다.";
  }
  if (p < 75){
    return "오늘은 이해 확인 단계입니다. 하이라이트 퀴즈 → 전체 문서 퀴즈 순으로 풀고, 틀린 문제의 근거 위치로 바로 복귀하세요.";
  }
  if (p < 100){
    return "오늘은 기억 강화 단계입니다. 백지 복습(화이트보드)로 '안 보고 설명/재현'을 해보고, 채점 결과에서 부족한 개념만 재공략하세요.";
  }
  return "이 문서는 완료 상태입니다. 시험 직전에는 백지 복습 한 번 + 심화 질문으로 마무리하세요.";
}

function renderChips(list){
  const chips = document.getElementById("missedKeywords");
  const hint = document.getElementById("missedHint");
  chips.innerHTML = "";

  const arr = (list || []).filter(Boolean).slice(0, 10);
  if (arr.length === 0){
    hint.style.display = "block";
    return;
  }
  hint.style.display = "none";

  arr.forEach(k => {
    const li = document.createElement("li");
    li.className = "chip";
    li.textContent = k;
    chips.appendChild(li);
  });
}

function setMilestones(doc){
  const msRead = document.getElementById("msRead");
  const msQuiz = document.getElementById("msQuiz");
  const msWhite = document.getElementById("msWhite");

  msRead.classList.toggle("is-done", !!doc?.firstStudy?.done);
  msQuiz.classList.toggle("is-done", !!doc?.quiz?.done);
  msWhite.classList.toggle("is-done", !!doc?.whiteboard?.done);
}

function gotoIndexWithDoc(docId){
  if (!docId) { location.href = "../index.html"; return; }
  localStorage.setItem("mybook:selectedDocId", docId);
  location.href = `../index.html?docId=${encodeURIComponent(docId)}`;
}

function gotoWhiteboard(docId){
  if (!docId) { location.href = "../whiteboard.html"; return; }
  location.href = `../whiteboard.html?docId=${encodeURIComponent(docId)}`;
}

function bindAlarm(){
  const btn = document.getElementById("alarmBtn");
  if (!btn) return;

  const read = () => (localStorage.getItem(LS_ALARM) ?? "true") === "true";
  const paint = (on) => {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.textContent = on ? "알림 켜짐" : "알림 꺼짐";
  };

  paint(read());

  btn.addEventListener("click", () => {
    const next = !read();
    localStorage.setItem(LS_ALARM, String(next));
    paint(next);

    // ✅ 기존 알람 기능이 별도 스케줄러/서비스워커를 갖고 있다면,
    // 그쪽에서 LS_ALARM 값을 보고 실제 알림 전송 여부를 제어하면 됩니다.
  });
}

function renderHero(userEmail, streakDays, doc){
  document.getElementById("userEmail").textContent = userEmail || "-";
  document.getElementById("streakDays").textContent = String(streakDays || 0);

  if (!doc){
    document.getElementById("currentDocTitle").textContent = "아직 학습한 문서가 없어요";
    document.getElementById("currentDocSub").textContent = "문서 업로드 후 학습을 시작해보세요.";
    document.getElementById("currentProgressText").textContent = "0%";
    document.getElementById("currentProgressFill").style.width = "0%";
    document.getElementById("currentNextStep").textContent = "다음 추천: 문서 업로드";
    document.getElementById("todayGoal").textContent = "문서를 업로드하고 1차 학습(정독 & 구조화)부터 시작하세요.";
    renderChips([]);
    return;
  }

  document.getElementById("currentDocTitle").textContent = doc.title;
  document.getElementById("currentDocSub").textContent = `마지막 학습: ${formatTs(doc.lastStudiedAt)}`;

  const p = clamp(doc.progressPercent);
  document.getElementById("currentProgressText").textContent = `${p}%`;
  document.getElementById("currentProgressFill").style.width = `${p}%`;
  document.querySelector(".progress__bar")?.setAttribute("aria-valuenow", String(p));
  document.getElementById("currentNextStep").textContent = `다음 추천: ${nextStepByPercent(p)}`;

  document.getElementById("todayGoal").textContent = buildTodayGoal(doc);
  renderChips(doc.missedKeywords || []);
  setMilestones(doc);

  // ✅ 문서가 없을 때도 버튼이 동작하도록: index로 유도
document.getElementById("startTodayBtn")?.addEventListener("click", () => {
  location.href = "/index.html";
});

document.querySelectorAll("[data-action]")?.forEach(btn => {
  btn.addEventListener("click", () => {
    location.href = "/index.html";
  });
});


  // 추천 액션
  document.querySelectorAll("[data-action]")?.forEach(btn => {
    btn.addEventListener("click", () => {
      const action = btn.getAttribute("data-action");

      if (action === "whiteboard") return gotoWhiteboard(doc.docId);

      // index에서 해석 가능하면 이 값을 사용
      localStorage.setItem("mybook:requestedAction", action);
      gotoIndexWithDoc(doc.docId);
    });
  });
}

function renderDocsGrid(docs){
  const grid = document.getElementById("docsGrid");
  grid.innerHTML = "";

  if (!docs || docs.length === 0){
    grid.innerHTML = `
      <div class="doc-card" style="grid-column:1/-1;">
        <div class="doc-card__title">표시할 문서가 없습니다</div>
        <div class="doc-card__meta"><span>문서를 업로드하고 학습을 시작해보세요.</span></div>
        <div class="doc-card__foot">
          <span class="badge">다음: 문서 업로드</span>
          <a class="btn btn--primary" href="../index.html">업로드로 이동</a>
        </div>
      </div>
    `;
    return;
  }

  docs.forEach(doc => {
    const p = clamp(doc.progressPercent);
    const card = document.createElement("article");
    card.className = "doc-card";
    card.innerHTML = `
      <div class="doc-card__title">${window.UI?.escapeHtml ? window.UI.escapeHtml(doc.title) : doc.title}</div>
      <div class="doc-card__meta">
        <span>진도 ${p}%</span>
        <span>마지막 학습 ${formatTs(doc.lastStudiedAt)}</span>
      </div>
      <div class="doc-card__foot">
        <span class="badge">다음: ${window.UI?.escapeHtml ? window.UI.escapeHtml(nextStepByPercent(p)) : nextStepByPercent(p)}</span>
        <button type="button" class="btn btn--secondary">이어서 학습</button>
      </div>
    `;
    card.querySelector("button")?.addEventListener("click", () => gotoIndexWithDoc(doc.docId));
    card.addEventListener("dblclick", () => gotoIndexWithDoc(doc.docId));
    grid.appendChild(card);
  });
}

function renderAI(doc){
  const ul = document.getElementById("aiActionList");
  const routine = document.getElementById("aiRoutine");
  ul.innerHTML = "";
  routine.innerHTML = "";

  if (!doc){
    ul.innerHTML = `<li class="muted">학습한 문서가 없어서 추천을 만들 수 없어요.</li>`;
    return;
  }

  const p = clamp(doc.progressPercent);
  const actions = [];

  if (p < 40){
    actions.push(`지금은 “구조화”가 1순위예요: 하이라이트 → 태그(중요/암기/참고) → 노트 정리`);
    actions.push(`텍스트가 이미지면 OCR 영역 선택으로 텍스트화 후 퀴즈 생성 준비`);
  } else if (p < 75){
    actions.push(`이해 확인 단계: 하이라이트 퀴즈로 “중요 표시 구간”부터 확인`);
    actions.push(`전체 문서 퀴즈로 범위를 확장하고, 틀린 문제는 근거 하이라이트로 점프`);
  } else if (p < 100){
    actions.push(`기억 강화 단계: 백지 복습(화이트보드)에서 “안 보고 설명/재현”`);
    actions.push(`채점 후 ‘놓친 키워드’만 재공략(노트/하이라이트로 되돌아가기)`);
  } else {
    actions.push(`완료 문서: 시험 직전에는 백지 복습 1회 + 심화 질문 3개만 풀면 효율 최고`);
  }

  actions.slice(0,4).forEach(t => {
    const li = document.createElement("li");
    li.textContent = t;
    ul.appendChild(li);
  });

  // 30분 루틴(요청 8: “기준은 네가 생각해줘” → 진행도 기반)
  const steps =
    (p < 40) ? [
      "10분: 목차/구조 파악 + 중요한 정의/식 하이라이트",
      "10분: 태그(중요/암기/참고) 정리 + 노트 3줄 요약",
      "10분: OCR 필요한 구간 텍스트화 + 질문 2개 챗봇으로 확인",
    ] :
    (p < 75) ? [
      "10분: 하이라이트 퀴즈(중요/암기 태그 우선)",
      "10분: 틀린 문제 근거 위치로 돌아가서 1분 설명",
      "10분: 전체 문서 퀴즈 5문제만 풀고 취약 지점 메모",
    ] :
    (p < 100) ? [
      "15분: 백지 복습(절차/정의/수식) ‘안 보고’ 작성",
      "10분: 채점 결과에서 부족한 항목만 재학습",
      "5분: 심화 질문 1개 답변 제출",
    ] : [
      "10분: 핵심 공식/정의 백지로 재현",
      "10분: 하이라이트 퀴즈로 취약 확인",
      "10분: 심화 질문 2개로 마무리",
    ];

  steps.forEach(s => {
    const li = document.createElement("li");
    li.textContent = s;
    routine.appendChild(li);
  });
}

function openModal(id){
  const dlg = document.getElementById(id);
  if (!dlg) return;
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "true");
}
function closeModal(id){
  const dlg = document.getElementById(id);
  if (!dlg) return;
  if (typeof dlg.close === "function") dlg.close();
  else dlg.removeAttribute("open");
}

function renderAllDocsModal(allDocs){
  const tbody = document.getElementById("allDocsTbody");
  const filter = document.getElementById("incompleteFilter");

  function apply(){
    const f = filter.value;
    const docs = (allDocs || []).filter(d => (d.progressPercent ?? 0) < 100);

    const filtered = docs.filter(d => {
      const p = Number(d.progressPercent || 0);
      if (f === "read") return p < 40;
      if (f === "quiz") return p >= 40 && p < 75;
      if (f === "whiteboard") return p >= 75 && p < 100;
      return true;
    });

    tbody.innerHTML = filtered.map(d => {
      const p = clamp(d.progressPercent);
      return `
        <tr>
          <td>${window.UI?.escapeHtml ? window.UI.escapeHtml(d.title) : d.title}</td>
          <td>${p}%</td>
          <td>${window.UI?.escapeHtml ? window.UI.escapeHtml(nextStepByPercent(p)) : nextStepByPercent(p)}</td>
          <td>${formatTs(d.lastStudiedAt)}</td>
          <td><button type="button" class="btn btn--secondary" data-doc="${d.docId}">열기</button></td>
        </tr>
      `;
    }).join("");

    tbody.querySelectorAll("button[data-doc]").forEach(btn => {
      btn.addEventListener("click", () => {
        const docId = btn.getAttribute("data-doc");
        closeModal("allDocsModal");
        gotoIndexWithDoc(docId);
      });
    });
  }

  filter.addEventListener("change", apply);
  apply();
}

function bindModals(docsAll){
  document.getElementById("showAllBtn")?.addEventListener("click", () => {
    renderAllDocsModal(docsAll);
    openModal("allDocsModal");
  });
  document.getElementById("closeAllDocsBtn")?.addEventListener("click", () => closeModal("allDocsModal"));

  // 일정 모달
  document.getElementById("addEventBtn")?.addEventListener("click", () => openModal("eventModal"));
  document.getElementById("closeEventBtn")?.addEventListener("click", () => closeModal("eventModal"));
  document.getElementById("cancelEventBtn")?.addEventListener("click", () => closeModal("eventModal"));

  document.getElementById("eventForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const date = document.getElementById("eventDate").value;
    const title = document.getElementById("eventTitle").value.trim();
    if (!date || !title) return;

    window.Calendar?.addEvent(date, title);
    closeModal("eventModal");
    window.Calendar?.renderEventList(date);
    e.target.reset();
  });
}

function bindTabsAndSearch(docBuckets){
  const tabs = document.querySelectorAll(".tab");
  const input = document.getElementById("docSearch");

  let activeTab = "incomplete";

  function getBaseList(){
    if (activeTab === "done") return docBuckets.done;
    if (activeTab === "recent") return docBuckets.recent;
    return docBuckets.incomplete;
  }

  function apply(){
    const q = (input.value || "").trim().toLowerCase();
    let list = getBaseList();
    if (q){
      list = list.filter(d => String(d.title||"").toLowerCase().includes(q));
    }
    renderDocsGrid(list);
  }

  tabs.forEach(t => {
    t.addEventListener("click", () => {
      tabs.forEach(x => {
        x.classList.remove("is-active");
        x.setAttribute("aria-selected", "false");
      });
      t.classList.add("is-active");
      t.setAttribute("aria-selected", "true");
      activeTab = t.dataset.tab;
      apply();
    });
  });

  input.addEventListener("input", apply);
  apply();
}

function buildReviewHintForDate(dateISO, doc){
  // 아주 가벼운 추천 로직: 선택 날짜가 “오늘/내일/모레”면 단계별 추천을 보여줌
  if (!dateISO || !doc) return "문서를 선택하면, 진행도 기반 추천이 표시됩니다.";
  const p = clamp(doc.progressPercent);

  const base =
    (p < 40) ? "정독/구조화(하이라이트+태그+노트) 추천" :
    (p < 75) ? "퀴즈로 이해 확인(하이라이트 퀴즈 → 전체 문서 퀴즈)" :
    (p < 100) ? "백지 복습(화이트보드) + 채점으로 구멍 메우기" :
    "완료 문서: 시험 직전 루틴(백지 1회 + 심화 질문 2~3개)";

  return `선택 날짜(${dateISO}) 기준 추천: ${base}`;
}

function hookCalendarHint(currentDoc){
  const box = document.getElementById("reviewHintText");
  if (!box) return;

  // Calendar.js가 선택 날짜를 localStorage에 저장하는 구조(기존 코드)라 가정
  const LS_SELECTED_DATE = "mybook:selectedDate";

  const paint = () => {
    const date = localStorage.getItem(LS_SELECTED_DATE) || "";
    box.textContent = buildReviewHintForDate(date, currentDoc);
  };

  window.addEventListener("storage", (e) => {
    if (e.key === LS_SELECTED_DATE) paint();
  });
  paint();
}

document.addEventListener("DOMContentLoaded", () => {
  bindAlarm();

  const email = localStorage.getItem("mybook:userEmail") || localStorage.getItem("mybook:selectedDocTitle") || "-";
  const streak = getStreak();

  const all = getProgressAll();
  const buckets = buildDocs(all);

  const currentId = pickCurrentDocId(all);
  const currentDoc = currentId ? buckets.all.find(d => d.docId === currentId) : null;

  renderHero(email, streak.days, currentDoc);
  renderAI(currentDoc);

  bindTabsAndSearch(buckets);
  bindModals(buckets.all);

  // 캘린더 초기화
  window.Calendar?.init();

  // 날짜 선택에 따른 복습 추천 힌트
  hookCalendarHint(currentDoc);
});
