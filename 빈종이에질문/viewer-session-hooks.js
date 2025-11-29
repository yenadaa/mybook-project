// viewer-session-hooks.js  // 

// Firebase 모듈 불러오기
// (A.firebase.js에서 내보낸 것들을 import)
// 
import {
  db, auth, collection, addDoc, setDoc, doc, getDocs, query, orderBy, limit, where,
  deleteDoc, writeBatch, Timestamp,
} from "./A.firebase.js"; // 

// 보관 정책
// 
const MAX_SESSIONS = 3;        // 최근 3개 세션만 유지
const SESSION_TTL_DAYS = 7;    // 7일 후 자동 만료

// 페르소나 라벨 매핑
// 
const PERSONA_LABEL_MAP = {
  "professor": "개념 구축형",
  "socrates": "소크라테스",
  "senior":   "개념 응용형",
};

// Firestore 경로 도우미 (bookId 없이 사용자 루트에 저장)
// 
function sessionsColRef(uid) {
  return collection(db, `users/${uid}/chatSessions`);
}
function turnsColRef(uid, sessionId) {
  return collection(db, `users/${uid}/chatSessions/${sessionId}/turns`);
}

// 세션 3개 유지(초과 삭제)
// 
async function enforceMaxSessions(uid) {
  const q = query(sessionsColRef(uid), orderBy("endAt", "desc"));
  const snap = await getDocs(q);
  const docs = snap.docs;
  if (docs.length <= MAX_SESSIONS) return;

  const batch = writeBatch(db);
  const toDelete = docs.slice(MAX_SESSIONS); // 4번째부터 제거
  for (const d of toDelete) {
    const turnsSnap = await getDocs(turnsColRef(uid, d.id));
    turnsSnap.forEach(t => batch.delete(t.ref));
    batch.delete(d.ref);
  }
  await batch.commit();
}

// 메모리 드래프트
// 
let currentSessionDraft = null; // { id, persona, startAt, firstQuestionPreview, questionCount }

// 질문 줄만 추출(한 줄 = 한 질문)
// 
function extractQuestionLines(text) {
  if (!text) return [];
  const lines = text
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  // 태그: (스피노자·명제) (칸트·필요조건) (후설·지향성) (비트겐·맥락)
  const tagRe = /^\((스피노자·명제|칸트·필요조건|후설·지향성|비트겐·맥락)\)/;
  return lines.filter(line => tagRe.test(line) || /[?？]$/.test(line));
}

// 세션 종료 멘트 감지(휴리스틱)
// 
function isSessionEndMessage(text) {
  if (!text) return false;
  const hasSummary = /요약|5문장|핵심 주장|정의 변화/.test(text);
  const hasOpenQs  = /약점|열린 질문|생각해볼 만한 질문|질문\s*1|질문\s*2|질문\s*3/.test(text);
  const hasEndLine = /종료|마무리|오늘 대화/.test(text);
  return [hasSummary, hasOpenQs, hasEndLine].filter(Boolean).length >= 2;
}

// 태그 추출
// 
function extractTags(text) {
  const re = /\((스피노자·명제|칸트·필요조건|후설·지향성|비트겐·맥락)\)/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

// 세션 드래프트 확보
// 
async function ensureSessionDraft(uid, personaLabel) {
  if (currentSessionDraft?.id) return currentSessionDraft;
  const ref = await addDoc(sessionsColRef(uid), {
    persona: personaLabel || "기타",
    startAt: Timestamp.now(),
    endAt: null,
    title: "", // 배너 타이틀(나중에 세팅)
    questionCount: 0,
    ttl: null,
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

// 질문 저장(줄 단위 turn 생성)
// 
async function saveQuestions(uid, sessionId, questionLines) {
  let count = 0;
  for (const [i, line] of questionLines.entries()) {
    const tags = extractTags(line);
    await addDoc(turnsColRef(uid, sessionId), {
      order: Date.now() + i, // 간단한 증가 키
      text: line,
      tags,
      createdAt: Timestamp.now(),
    });
    count++;
  }
  return count;
}

// 세션 종료 확정(only 종료된 세션 저장 + TTL + 3개 유지)
// 
async function finalizeSession(uid) {
  if (!currentSessionDraft?.id) return;
  const sessionDoc = doc(db, `users/${uid}/chatSessions/${currentSessionDraft.id}`);
  const end = new Date();
  const ttl = new Date(end.getTime() + SESSION_TTL_DAYS * 86400000);

  await setDoc(sessionDoc, {
    endAt: Timestamp.fromDate(end),
    ttl: Timestamp.fromDate(ttl), // TTL 필드는 Firestore 콘솔에서 설정 필요
    questionCount: currentSessionDraft.questionCount,
    // 배너 타이틀 규칙: 날짜 + 페르소나
    title: `${end.getFullYear()}-${String(end.getMonth()+1).padStart(2,"0")}-${String(end.getDate()).padStart(2,"0")} · ${currentSessionDraft.persona}`,
    updatedAt: Timestamp.now(),
  }, { merge: true });

  await enforceMaxSessions(uid);
  currentSessionDraft = null;
}

// 외부에서 호출할 훅(봇 메시지 렌더 직후 호출)
// 
export async function onBotMessageHook(botText, personaKey) {
  const user = auth.currentUser;
  if (!user) return;

  const personaLabel = PERSONA_LABEL_MAP[personaKey] || personaKey || "기타";

  // 종료 신호면 세션 확정
  if (isSessionEndMessage(botText)) {
    await finalizeSession(user.uid);
    return;
  }

  // 질문 라인 추출
  const questionLines = extractQuestionLines(botText);
  if (questionLines.length === 0) return;

  // 세션 드래프트 확보 → 질문 저장
  const draft = await ensureSessionDraft(user.uid, personaLabel);
  const saved = await saveQuestions(user.uid, draft.id, questionLines);

  // 첫 질문을 배너 예고로(없으면 그대로)
  if (!draft.firstQuestionPreview && questionLines[0]) {
    const first = questionLines[0].slice(0, 50);
    await setDoc(doc(db, `users/${user.uid}/chatSessions/${draft.id}`), {
      title: `${first}…`
    }, { merge: true });
    draft.firstQuestionPreview = first;
  }

  // 카운트 갱신
  draft.questionCount += saved;
  await setDoc(doc(db, `users/${user.uid}/chatSessions/${draft.id}`), {
    questionCount: draft.questionCount,
    updatedAt: Timestamp.now(),
  }, { merge: true });
}
