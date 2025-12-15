// keyword_extractor.js
// 매우 단순하지만 효과 좋은 방식

export function extractKeywordsFromText(text = "") {
  if (!text) return [];

  const STOP_WORDS = [
    "무엇", "의미", "설명", "이란", "하는", "것은",
    "다음", "중", "옳은", "틀린"
  ];

  return text
    .replace(/[^\w가-힣 ]/g, " ")
    .split(/\s+/)
    .filter(w =>
      w.length >= 2 &&
      !STOP_WORDS.includes(w)
    );
}

export function extractMissedKeywords(wrongQuestions = []) {
  const keywords = new Set();

  wrongQuestions.forEach(q => {
    [
      q.question,
      q.correctAnswer
    ].forEach(text => {
      extractKeywordsFromText(text).forEach(k => keywords.add(k));
    });
  });

  return Array.from(keywords);
}
