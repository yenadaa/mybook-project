// public/progress_bootstrap.js
(() => {
  const PROGRESS_KEY = "mybook:progress:v1";
  const STREAK_KEY = "mybook:streak:v1";

  function safeParse(str, fallback) { try { return JSON.parse(str); } catch { return fallback; } }
  function getAll(){ return safeParse(localStorage.getItem(PROGRESS_KEY), {}); }
  function setAll(obj){ localStorage.setItem(PROGRESS_KEY, JSON.stringify(obj)); }

  function ensureDoc(all, docId, title){
    if (!all[docId]) {
      all[docId] = {
        docId,
        title: title || "",
        firstStudy: { done:false, updatedAt:0 },
        quiz: { done:false, score:null, updatedAt:0 },
        whiteboard: { done:false, score:null, updatedAt:0 },
        lastOpenedAt: 0,
        lastActivityAt: 0,
        missedKeywords: []
      };
    } else if (title && !all[docId].title) {
      all[docId].title = title;
    }
    return all[docId];
  }

  function updateStreak(nowMs){
    const cur = safeParse(localStorage.getItem(STREAK_KEY), { days:0, lastDate:"" });
    const now = new Date(nowMs);
    const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;

    if (!cur.lastDate){
      const next = { days:1, lastDate:today };
      localStorage.setItem(STREAK_KEY, JSON.stringify(next));
      return next;
    }
    if (cur.lastDate === today) return cur;

    const last = new Date(cur.lastDate + "T00:00:00");
    const diff = Math.round((new Date(today + "T00:00:00") - last) / (1000*60*60*24));
    const next = (diff === 1) ? { days:cur.days+1, lastDate:today } : { days:1, lastDate:today };
    localStorage.setItem(STREAK_KEY, JSON.stringify(next));
    return next;
  }

  function recordFirstStudy(docId, title){
    if (!docId) return;
    const all = getAll();
    const now = Date.now();
    const d = ensureDoc(all, docId, title);

    d.firstStudy = { done:true, updatedAt:now };
    d.lastOpenedAt = now;
    d.lastActivityAt = now;

    setAll(all);
    updateStreak(now);
  }

  // 외부(퀴즈/백지 결과)에서도 쓸 수 있게 최소 API 노출
  window.MyBookProgress = window.MyBookProgress || {};
  window.MyBookProgress.recordFirstStudy = recordFirstStudy;

  // currentBookId 감시(폴링)
  let last = null;
  const tick = () => {
    const curId = window.currentBookId || null;
    if (curId && curId !== last){
      last = curId;

      // 문서 제목은 doc 리스트의 active row에서 뽑아오면 꽤 정확합니다.
      const activeTitle = document.querySelector('.doc-row.active .doc-title')?.textContent?.trim();
      recordFirstStudy(curId, activeTitle);

      // home에서 사용하기 위한 선택값 저장(홈 -> index 이동에도 사용)
      localStorage.setItem("mybook:selectedDocId", curId);
      if (activeTitle) localStorage.setItem("mybook:selectedDocTitle", activeTitle);
    }
  };

  setInterval(tick, 500);
})();
