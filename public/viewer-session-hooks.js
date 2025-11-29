// viewer-session-hooks.js

import {
  db, auth, collection, addDoc, setDoc, doc, getDocs, query, orderBy, limit,
  deleteDoc, writeBatch, Timestamp,
} from "./A.firebase.js";

// --- 설정 ---
const MAX_SESSIONS = 3;       // 최근 3개 세션만 유지
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

// --- 오래된 세션 삭제 ---
async function enforceMaxSessions(uid) {
  const q = query(sessionsColRef(uid), orderBy("endAt", "desc"));
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

// --- 텍스트 분석 ---
function extractQuestionLines(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  // ⭐️ [수정] 태그 패턴을 범용적으로 변경 (괄호 안에 문자+점 등 포함)
  // 기존: /^\((스피노자·명제|칸트·필요조건...)\)/
  const tagRe = /^\([가-힣a-zA-Z0-9·\s]+\)/;
  
  return lines.filter(line => tagRe.test(line) || /[?？]$/.test(line));
}

function isSessionEndMessage(text) {
  if (!text) return false;
  const hasSummary = /요약|5문장|핵심 주장|정의 변화/.test(text);
  const hasOpenQs  = /약점|열린 질문|생각해볼 만한 질문|질문\s*1/.test(text);
  const hasEndLine = /종료|마무리|오늘 대화/.test(text);
  return [hasSummary, hasOpenQs, hasEndLine].filter(Boolean).length >= 2;
}

function extractTags(text) {
  // 범용 태그 추출
  const re = /\(([가-힣a-zA-Z0-9·\s]+)\)/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

// --- 세션 관리 ---
async function ensureSessionDraft(uid, personaLabel) {
  if (currentSessionDraft?.id) return currentSessionDraft;
  
  const ref = await addDoc(sessionsColRef(uid), {
    persona: personaLabel || "기타",
    startAt: Timestamp.now(),
    endAt: null,
    title: "", 
    questionCount: 0,
    updatedAt: Timestamp.now(),
  });
  
  currentSessionDraft = {
    id: ref.id,
    persona: personaLabel,
    startAt: new Date(),
    firstQuestionPreview: "",
    questionCount: 0,
  };
  return currentSessionDraft;
}

async function saveQuestions(uid, sessionId, questionLines) {
  let count = 0;
  for (const [i, line] of questionLines.entries()) {
    const tags = extractTags(line);
    await addDoc(turnsColRef(uid, sessionId), {
      order: Date.now() + i,
      text: line,
      tags,
      createdAt: Timestamp.now(),
    });
    count++;
  }
  return count;
}

async function finalizeSession(uid) {
  if (!currentSessionDraft?.id) return;
  const sessionDoc = doc(db, `users/${uid}/chatSessions/${currentSessionDraft.id}`);
  const end = new Date();
  const ttl = new Date(end.getTime() + SESSION_TTL_DAYS * 86400000);

  await setDoc(sessionDoc, {
    endAt: Timestamp.fromDate(end),
    ttl: Timestamp.fromDate(ttl), 
    questionCount: currentSessionDraft.questionCount,
    title: `${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,"0")}-${String(end.getDate()).padStart(2,"0")} · ${currentSessionDraft.persona}`,
    updatedAt: Timestamp.now(),
  }, { merge: true });

  await enforceMaxSessions(uid);
  currentSessionDraft = null;
}

// --- ⭐️ 메인 훅 함수 ---
export async function onBotMessageHook(botText, personaKey) {
  const user = auth.currentUser;
  if (!user) return;

  const personaLabel = PERSONA_LABEL_MAP[personaKey] || personaKey || "기타";

  // 종료 신호 감지
  if (isSessionEndMessage(botText)) {
    await finalizeSession(user.uid);
    return;
  }

  // 질문 추출
  const questionLines = extractQuestionLines(botText);
  if (questionLines.length === 0) return;

  // 저장
  const draft = await ensureSessionDraft(user.uid, personaLabel);
  const saved = await saveQuestions(user.uid, draft.id, questionLines);

  // 첫 질문을 제목 미리보기로 설정
  if (!draft.firstQuestionPreview && questionLines[0]) {
    const first = questionLines[0].slice(0, 50);
    await setDoc(doc(db, `users/${user.uid}/chatSessions/${draft.id}`), {
      title: `${first}…`
    }, { merge: true });
    draft.firstQuestionPreview = first;
  }

  // 카운트 업데이트
  draft.questionCount += saved;
  await setDoc(doc(db, `users/${user.uid}/chatSessions/${draft.id}`), {
    questionCount: draft.questionCount,
    updatedAt: Timestamp.now(),
  }, { merge: true });
}