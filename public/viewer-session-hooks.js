// viewer-session-hooks.js

import {
  db, auth, collection, addDoc, setDoc, doc, getDocs, query, orderBy, limit,
  deleteDoc, writeBatch, Timestamp,
} from "./A.firebase.js";

// --- 설정 ---
const MAX_SESSIONS = 5;       // 세션 유지 개수 (필요시 조정)
const SESSION_TTL_DAYS = 7;   // 7일 후 만료

const PERSONA_LABEL_MAP = {
  "professor": "개념 구축형",
  "socrates": "소크라테스",
  "senior":   "개념 응용형",
};

// --- Firestore 경로 ---
function sessionsColRef(uid) {
  return collection(db, `users/${uid}/chatSessions`);
}
function turnsColRef(uid, sessionId) {
  return collection(db, `users/${uid}/chatSessions/${sessionId}/turns`);
}

// --- 오래된 세션 삭제 (유지) ---
async function enforceMaxSessions(uid) {
  const q = query(sessionsColRef(uid), orderBy("updatedAt", "desc")); // 최근 업데이트 순
  const snap = await getDocs(q);
  const docs = snap.docs;
  if (docs.length <= MAX_SESSIONS) return;

  const batch = writeBatch(db);
  const toDelete = docs.slice(MAX_SESSIONS); 
  for (const d of toDelete) {
    const turnsSnap = await getDocs(turnsColRef(uid, d.id));
    turnsSnap.forEach(t => batch.delete(t.ref));
    batch.delete(d.ref);
  }
  await batch.commit();
}

// --- 현재 세션 상태 (메모리) ---
let currentSessionDraft = null; 

// --- [수정 2] 복잡한 텍스트 분석 함수들 삭제 ---
// extractQuestionLines, isSessionEndMessage, extractTags 제거
// 대신 있는 그대로 저장하는 단순 로직 사용

// --- 세션 관리 ---
async function ensureSessionDraft(uid, personaLabel) {
  // 이미 메모리에 세션이 있으면 반환
  if (currentSessionDraft?.id) return currentSessionDraft;
  
  // 없으면 새로 생성 (무조건 새 세션으로 시작하지 않고, 가장 최근 세션을 불러올 수도 있지만
  // 여기서는 대화가 끊겼다 다시 시작되는 것을 고려해 새로 만듭니다.)
  
  // *팁: 만약 페이지 리로딩 없이 계속 대화를 잇고 싶다면
  // 최근 세션의 created time을 비교해서 1시간 이내면 재활용하는 로직을 넣을 수도 있습니다.
  // 일단은 '대화 시작 시점'에 새 세션을 파는 구조를 유지합니다.

  const ref = await addDoc(sessionsColRef(uid), {
    persona: personaLabel || "기타",
    startAt: Timestamp.now(),
    title: "대화 기록 중...", // 임시 제목
    messageCount: 0,
    updatedAt: Timestamp.now(),
  });
  
  currentSessionDraft = {
    id: ref.id,
    persona: personaLabel,
    startAt: new Date(),
    titleSet: false, // 제목 설정 여부
    messageCount: 0,
  };
  return currentSessionDraft;
}

async function saveTurn(uid, sessionId, text) {
  // [수정 3] 텍스트 전체를 하나의 Turn으로 저장
  await addDoc(turnsColRef(uid, sessionId), {
    order: Date.now(),
    text: text, // 필터링 없이 원문 저장
    createdAt: Timestamp.now(),
  });
}

// --- ⭐️ 메인 훅 함수 ---
export async function onBotMessageHook(botText, personaKey) {
  const user = auth.currentUser;
  if (!user) return;
  if (!botText || typeof botText !== 'string') return; // 빈 메시지 방지

  if (botText.includes("답변을 생성 중입니다...")) return;
  if (botText.trim() === "..." || botText.trim() === "") return;

  const personaLabel = PERSONA_LABEL_MAP[personaKey] || personaKey || "기타";

  // 1. 세션 준비 (없으면 생성)
  const draft = await ensureSessionDraft(user.uid, personaLabel);

  // 2. 메시지 저장 (조건 없이 무조건 저장)
  await saveTurn(user.uid, draft.id, botText);

  // 3. 상태 업데이트 (카운트 및 제목)
  draft.messageCount++;
  
  const updates = {
    messageCount: draft.messageCount,
    updatedAt: Timestamp.now(),
  };

  // 첫 번째 메시지일 경우, 제목을 메시지 앞부분으로 설정
  if (!draft.titleSet) {
    const cleanTitle = botText.replace(/\n/g, ' ').slice(0, 30); // 줄바꿈 제거 후 30자
    updates.title = cleanTitle + (botText.length > 30 ? "..." : "");
    draft.titleSet = true;
  }

  await setDoc(doc(db, `users/${user.uid}/chatSessions/${draft.id}`), updates, { merge: true });

  // 세션 개수 정리
  await enforceMaxSessions(user.uid);
}