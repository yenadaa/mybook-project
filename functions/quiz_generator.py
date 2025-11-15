from __future__ import annotations
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass
import re
import fitz  # PyMuPDF
from langchain_text_splitters import RecursiveCharacterTextSplitter
from pydantic import BaseModel
from openai import OpenAI
from sklearn.feature_extraction.text import TfidfVectorizer
import json
from json.decoder import JSONDecodeError
import random
import textwrap
import os
import numpy as np
import hashlib
import itertools
import collections
import math

# ---------------------------------------------
# --- 1. PDF 처리 (fitz + LangChain) ---
# ---------------------------------------------

class PdfReadError(Exception): pass

def pdf_to_preprocessed_doc(
    pdf_bytes: bytes,
    doc_id: Optional[str] = None,
) -> PreprocessedDoc:
    """
    [챗봇 방식과 통합된 새 파이프라인]
    PDF 바이트를 입력받아, fitz로 텍스트를 추출하고 
    LangChain으로 쪼갠 뒤, PreprocessedDoc 객체로 반환합니다.
    """
    all_text = ""
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf") 
    except Exception as e:
        print(f"fitz PDF 열기 오류: {e}")
        raise PdfReadError(f"fitz PDF 처리 오류: {e}") 

    for page_num in range(len(doc)):
        try:
            page = doc.load_page(page_num)
            text = page.get_text("text")
            all_text += text
            all_text += "\n\n"
        except Exception as page_e:
            print(f"Warning: {page_num} 페이지 처리 중 오류: {page_e}")
            continue
    doc.close()

    if not all_text.strip():
        print("Warning: PDF에서 텍스트를 추출하지 못했습니다 (빈 문서).")
        return PreprocessedDoc(doc_id=doc_id, chunks=[])

    try:
        text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=1000,
            chunk_overlap=100,
            separators=["\n\n", "\n", " ", ""]
        )
        split_texts: List[str] = text_splitter.split_text(all_text)
    except Exception as e:
        print(f"LangChain 텍스트 분할 중 오류: {e}")
        split_texts = [all_text] if all_text else []

    chunks: List[Chunk] = []
    for i, text_chunk in enumerate(split_texts):
        new_chunk = Chunk(
            id=f"c{i}",
            text=text_chunk,
            section_path=None, 
            anchors=[]
        )
        chunks.append(new_chunk)
    
    print(f"--- ✅ PDF 처리 완료 (PyMuPDF + LangChain): 총 {len(chunks)}개 청크 생성 ---")

    return PreprocessedDoc(
        doc_id=doc_id,
        chunks=chunks
    )

# ---------------------------------------------
# --- 2. OpenAI 클라이언트 및 헬퍼 ---
# ---------------------------------------------

def _get_client() -> "OpenAI":
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("환경변수 OPENAI_API_KEY가 필요합니다.")
    return OpenAI(api_key=api_key)

def get_openai_embeddings(
    texts: List[str], 
    model: str = "text-embedding-3-small"
) -> List[List[float]]:
    """
    [⭐️ 챗봇용 신규 함수]
    """
    if not texts:
        return []
    try:
        client = _get_client() 
        texts_to_embed = [t.strip() or " " for t in texts]
        response = client.embeddings.create(
            input=texts_to_embed,
            model=model
        )
        embeddings = [item.embedding for item in response.data]
        return embeddings
    except Exception as e:
        print(f"OpenAI 임베딩 API 호출 중 오류: {e}")
        return [[] for _ in texts]

def _system_prompt() -> str:
    return (
        "당신은 교재 기반 학습 도우미입니다. 제공된 텍스트만을 근거로 요약과 문제를 생성합니다. "
        "각 결과에는 가능한 한 출처(chunk id)를 포함하세요."
    )

def _ask_gpt_json(prompt: str, model: str, temperature: float, max_tokens: int) -> Any:
    client = _get_client()
    try:
        rsp = client.chat.completions.create(
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": _system_prompt()},
                {"role": "user", "content": prompt},
            ],
        )
        text = rsp.choices[0].message.content
        try:
            return json.loads(text)
        except JSONDecodeError as e:
            print(f"JSON 디코딩 오류 발생: {e}. 유효하지 않은 JSON 응답입니다.")
            return {}
    except Exception as e1:
        print(f"API 호출 중 오류 발생: {e1}")
        return {"error": str(e1), "status": "api_fail"}

def _normalize_ids(doc: PreprocessedDoc) -> List[str]:
    for i, ch in enumerate(doc.chunks):
        if not ch.id:
            ch.id = f"c{i}"
    return [c.id for c in doc.chunks]

def _select_scope(
    doc: PreprocessedDoc,
    section_contains: Optional[str],
    chunk_ids: Optional[List[str]],
    auto_chars: int = 4000,
) -> Tuple[str, List[str]]:
    chunks = doc.chunks
    if section_contains:
        sel = [c for c in chunks if section_contains in " / ".join(c.section_path or [])]
    elif chunk_ids:
        s = set(chunk_ids)
        sel = [c for c in chunks if c.id in s]
    else:
        sel, total = [], 0
        for c in chunks:
            t = (c.text or "").strip()
            if not t:
                continue
            if total + len(t) > auto_chars and total > 0:
                break
            sel.append(c)
            total += len(t)
    if not sel:
        raise ValueError("선택된 범위가 비었습니다. section 또는 chunk_ids를 확인하세요.")
    joined, ids = [], []
    for c in sel:
        ids.append(c.id)
        sp = c.section_path or []
        header = f"[# {' › '.join(sp)}]\n" if sp else ""
        joined.append(header + (c.text or ""))
    return "\n\n".join(joined), ids

def _fix_sources(candidate: List[str], valid_ids: List[str], fallback: List[str]) -> List[str]:
    valid = set(valid_ids)
    out = [s for s in (candidate or []) if s in valid]
    return out or (fallback if fallback else (valid_ids[:1] if valid_ids else []))

# ---------------------------------------------
# --- 3. 데이터 모델 (Pydantic) ---
# ---------------------------------------------

class Chunk(BaseModel):
    id: Optional[str] = None
    text: str
    section_path: Optional[List[str]] = None
    anchors: Optional[List[str]] = None
    embedding: Optional[List[float]] = None # 챗봇(RAG)용

class PreprocessedDoc(BaseModel):
    doc_id: Optional[str] = None
    chunks: List[Chunk]

class SummaryOut(BaseModel):
    summary: str 
    sources: List[str]

class ReviewOut(BaseModel):
    ox: List[Dict[str, Any]]
    short: List[Dict[str, Any]]
    discussion: List[Dict[str, Any]]

class Output(BaseModel):
    summaries: SummaryOut
    review: ReviewOut
    meta: Dict[str, Any]

# --- 챗봇/채점용 모델 ---
class QuestionData(BaseModel):
    q: str
    concept_ids: List[str]
    relation_label_free: str
    relation_type_norm: List[str]
    rubric: List[Dict[str, Any]]
    facets: Dict[str, Any]

class AnswerIn(BaseModel):
    q_data: QuestionData
    user_answer: str

class ScoreBreakdown(BaseModel):
    key: str
    score_out_of_10: float
    weight: float

class ScoreResult(BaseModel):
    score_breakdown: List[ScoreBreakdown]
    final_score: float
    feedback_tip: str
    llm_assessment: str

# ---------------------------------------------
# --- 4. 프롬프트 템플릿 ---
# ---------------------------------------------

def _prompt_summaries(text: str) -> str:
    return textwrap.dedent(f"""
    [과제]
    아래 텍스트를 근거로 약 500자 이내의 요약을 만드세요.
    - 핵심만 1문단으로 작성하세요.
    [텍스트]
    {text}
    [출력(JSON)]
    {{
      "summary": "요약 내용...",
      "sources": []
    }}
    """).strip()

def _prompt_review(text: str, keywords: List[str], counts: Dict[str, int]) -> str:
    kws = ", ".join(keywords)
    return textwrap.dedent(f"""
    [과제]
    아래 텍스트와 키워드를 근거로 학습용 문제를 생성하세요.
    - 간단퀴즈: OX {counts['ox']}문항, 단답 {counts['short']}문항
    - 서술형: 토론 {counts['discussion']}문항
    [키워드]
    {kws}
    [형식]
    - OX: "q", 정답 "answer"(true/false), 근거 한 줄 "why"
    - 단답: "q", 정답 "answer"(핵심 키워드 중심)
    - 토론: "q", 짧은 힌트 "hint"
    - 각 항목에 최소 1개 이상의 출처 chunk id 포함("sources": ["c1", ...])
    - 텍스트 밖 지식 금지, 간결하고 명료하게
    [출력(JSON)]
    {{
      "review": {{
        "ox":       [{{"q":"...","answer":true,"why":"...","sources":["c1"],"tags":["OX"],"confused":false}}],
        "short":    [{{"q":"...","answer":"...","sources":["c2"],"tags":["단답"],"confused":false}}],
        "discussion": [{{"q":"...","hint":"...","sources":["c3"],"tags":["토론"]}}]
      }}
    }}
    [텍스트]
    {text}
    """).strip()

def _prompt_keywords(text: str) -> str:
    return textwrap.dedent(f"""
    [과제]
    아래 텍스트를 분석하여 가장 중요한 핵심 키워드 5~7개를 추출하세요.
    - 키워드만 나열하세요.
    - JSON 형식으로 출력하세요.
    [텍스트]
    {text}
    [출력(JSON)]
    {{
      "keywords": ["키워드1", "키워드2", "키워드3", "키워드4", "키워드5"]
    }}
    """).strip()

# ---------------------------------------------
# --- 5. 핵심 실행 함수 (요약/퀴즈) ---
# ---------------------------------------------

def generate_summaries(
    doc: PreprocessedDoc,
    section: Optional[str] = None,
    chunk_ids: Optional[List[str]] = None,
    model: str = "gpt-4o-mini", # ⭐️ 모델 'gpt-4o-mini'로 통일
) -> SummaryOut:
    all_ids = _normalize_ids(doc)
    text, used_ids = _select_scope(doc, section_contains=section, chunk_ids=chunk_ids)
    data = _ask_gpt_json(_prompt_summaries(text), model=model, temperature=0.2, max_tokens=1000) # ⭐️ max_tokens 1000으로
    data["summary"] = data.get("summary", "")
    data["sources"] = _fix_sources(data.get("sources", []), all_ids, used_ids) 
    return SummaryOut(**data)


def generate_base_review(
    doc: PreprocessedDoc,
    model: str = "gpt-4o-mini", # ⭐️ 모델 'gpt-4o-mini'로 통일
    seed: Optional[int] = None,
) -> Output:
    """
    [⭐️ 성능 개선 버전]
    - 퀴즈 생성 시 'for' 루프를 제거합니다.
    - 전체 요약 1번, 키워드 1번, 전체 퀴즈 1번 (총 3번)만 API를 호출합니다.
    """
    _normalize_ids(doc)

    # 1. 문서 전체 범위를 설정 (키워드 추출 및 전체 요약/퀴즈용)
    try:
        full_text, all_ids = _select_scope(
            doc, 
            section_contains=None, 
            chunk_ids=None, 
            auto_chars=8000 # ⭐️ 컨텍스트를 8000자로 늘림
        ) 
    except ValueError:
        return Output(summaries=SummaryOut(summary="범위 내 텍스트 없음", sources=[]),
                      review=ReviewOut(ox=[], short=[], discussion=[]), meta={"model": model, "doc_id": doc.doc_id})

    # 2. [API 호출 1] 전체 요약 단 1회 생성
    final_summary_out = generate_summaries(
        doc, 
        section=None, 
        chunk_ids=all_ids,
        model=model
    )

    # 3. [API 호출 2] 키워드 추출 (전체 문서 기반으로 한 번)
    try:
        raw_keywords = _ask_gpt_json(
            _prompt_keywords(full_text),
            model=model, temperature=0.2, max_tokens=200
        )
        keywords = raw_keywords.get("keywords", [])
    except Exception as e:
        print(f"키워드 추출 실패: {e}. 기본 키워드를 사용합니다.")
        keywords = ["핵심 개념", "정의", "관계", "예시", "의의"]

    # 4. [⭐️ API 호출 3] 퀴즈 생성 (전체 문서 기반으로 단 1회)
    review_output = ReviewOut(ox=[], short=[], discussion=[])
    try:
        counts = {"ox": 3, "short": 3, "discussion": 3} 
        
        raw_quiz = _ask_gpt_json(
            _prompt_review(full_text, keywords, counts), 
            model=model, temperature=0.4, max_tokens=2000
        )
        
        rv = raw_quiz.get("review", {}) or {}

        def _fix_item_all(item: Dict[str, Any]) -> Dict[str, Any]:
            item["sources"] = _fix_sources(item.get("sources", []), all_ids, all_ids)
            return item
            
        review_output.ox.extend([_fix_item_all(it) for it in (rv.get("ox") or [])])
        review_output.short.extend([_fix_item_all(it) for it in (rv.get("short") or [])])
        review_output.discussion.extend([_fix_item_all(it) for it in (rv.get("discussion") or [])])

    except Exception as e:
        print(f"Warning: 퀴즈 생성 실패: {e}")

    # 5. 최종 Output 객체 생성
    return Output(
        summaries=final_summary_out, 
        review=review_output, 
        meta={"model": model, "doc_id": doc.doc_id}
    )


# ---------------------------------------------
# --- 6. 맞춤형 퀴즈 (generateCustomReview) ---
# --- (이 코드가 삭제되어 오류가 발생했습니다) ---
# ---------------------------------------------

# === [관계형 서술형] 헬퍼 함수 ===
ASK_JSON = _ask_gpt_json
RELATION_CANON = [
    "원인-결과","전제/조건","수단/방법","목적","상하위","부분-전체",
    "정의/동일시","비교/대조","사례/구체화","지원/근거","반박/제약"
]

def _norm_concept(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"[()\[\]{}:;\"'`·•—–\-]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s

def _sent_split(text: str) -> List[str]:
    parts = re.split(r'(?<=[.?!])\s+|\n{2,}', text or "")
    sentences = []
    current_sentence = ""
    for part in parts:
        if not part.strip(): continue
        if re.search(r'(다\.|\s다|\s요)$', part.strip()):
            if current_sentence:
                sentences.append(current_sentence.strip())
            current_sentence = part
        else:
            current_sentence += " " + part
    if current_sentence:
        sentences.append(current_sentence.strip())
    final_sentences = []
    for s in sentences:
        sub_parts = re.split(r'(?<=[.!?])\s+(?![.?!])', s)
        for sp in sub_parts:
            sp = sp.strip()
            kor_parts = re.split(r'(다\.|요\.)', sp)
            if len(kor_parts) > 1:
                for i in range(0, len(kor_parts)-1, 2):
                    sentence = kor_parts[i] + kor_parts[i+1]
                    if sentence and len(sentence.strip()) >= 3:
                        final_sentences.append(sentence.strip())
                if len(kor_parts) % 2 == 1:
                    if kor_parts[-1] and len(kor_parts[-1].strip()) >= 3:
                        final_sentences.append(kor_parts[-1].strip())
            else:
                if sp and len(sp) >= 3:
                    final_sentences.append(sp)
    return [s for s in final_sentences if s]

def _shingle_hash(s: str, k: int = 3) -> str:
    toks = re.findall(r"\w+|[가-힣]+", (s or "").lower())
    if len(toks) < k:
        toks = toks + ["_pad_"]*(k-len(toks))
    shingles = [" ".join(toks[i:i+k]) for i in range(max(1, len(toks)-k+1))]
    return hashlib.sha1(("||".join(shingles)).encode()).hexdigest()[:12]

def _build_inventory_from_chunks(
    concepts_user: List[str],
    target_chunks: List[Chunk],
    dedup: bool = True,
    window_size: int = 1,
) -> Tuple[List[Dict[str,Any]], List[Dict[str,Any]]]:
    concepts, seen = [], set()
    for i, raw in enumerate(concepts_user or []):
        lab = (raw or "").strip()
        if not lab: continue
        key = _norm_concept(lab)
        if key in seen: continue
        seen.add(key)
        concepts.append({"id": f"u{i+1}", "label": lab, "aliases": [lab, key]})

    sentences_inv, seen_hash, sid = [], set(), 1
    all_sentences = []
    for ch in (target_chunks or []):
        raw_sents = _sent_split(ch.text)
        for i, s_text in enumerate(raw_sents):
            hits = []
            s_low = s_text.lower()
            for c in concepts:
                for alias in c["aliases"]:
                    a = (alias or "").lower().strip()
                    if a and a in s_low:
                        hits.append(c["id"]); break
            all_sentences.append({
                "chunkId": ch.id or "c0",
                "idx": i,
                "text": s_text,
                "concepts": sorted(set(hits)),
            })
    for i, sent_data in enumerate(all_sentences):
        if not sent_data["concepts"]:
            continue 
        start_idx = max(0, i - window_size)
        end_idx = min(len(all_sentences), i + window_size + 1)
        window_texts = []
        source_chunk_ids = set()
        all_concepts_in_window = set()
        for j in range(start_idx, end_idx):
            current_sent = all_sentences[j]
            window_texts.append(current_sent["text"])
            source_chunk_ids.add(current_sent["chunkId"])
            all_concepts_in_window.update(current_sent["concepts"])
        full_text = " ".join(window_texts)
        h = _shingle_hash(full_text, 3)
        if dedup and h in seen_hash:
            continue
        seen_hash.add(h)
        sentences_inv.append({
            "sid": sid,
            "chunkId": list(source_chunk_ids),
            "text": full_text,
            "concepts": sorted(list(all_concepts_in_window)),
        })
        sid += 1
    return concepts, sentences_inv

def _topic_groups(concepts: List[Dict[str,Any]], sentences: List[Dict[str,Any]], K: int = 8, top_m:int = 5) -> List[Dict[str,Any]]:
    cid2idx = {c["id"]:i for i,c in enumerate(concepts)}
    X, sid_order = [], []
    for s in sentences:
        row = [0]*len(concepts)
        for cid in s["concepts"]:
            if cid in cid2idx: row[cid2idx[cid]] += 1
        if sum(row)==0: continue 
        X.append(row); sid_order.append(s["sid"])
    if not X:
        return []
    try:
        from sklearn.decomposition import LatentDirichletAllocation
        X_arr = np.array(X)
        K_eff = max(2, min(K, X_arr.shape[0], X_arr.shape[1]))
        if K_eff < 2:
             raise ImportError("LDA components too small, falling back.")
        lda = LatentDirichletAllocation(n_components=K_eff, random_state=42, learning_method="batch")
        doc_topic = lda.fit_transform(X_arr)
        topic_word = lda.components_
        groups = []
        for k in range(K_eff):
            word_w = topic_word[k]
            idx_sorted = list(reversed(sorted(range(len(word_w)), key=lambda i: word_w[i])))
            top_idx = idx_sorted[:top_m]
            cids = [concepts[i]["id"] for i in top_idx]
            weights = [float(word_w[i]) for i in top_idx]
            sw = sum(weights) or 1.0
            weights = [w/sw for w in weights]
            doc_scores = [doc_topic[d][k] for d in range(len(X_arr))]
            doc_sorted = list(reversed(sorted(range(len(doc_scores)), key=lambda d: doc_scores[d])))
            top_sids = [sid_order[d] for d in doc_sorted[:top_m]]
            if len(cids) < 2 or not top_sids:
                continue
            groups.append({"tid": f"t{k+1}", "concept_ids": cids, "weights": weights, "top_sent_ids": top_sids})
        return groups
    except Exception:
        co = collections.defaultdict(lambda: collections.Counter())
        total_co = collections.Counter()
        for s in sentences:
            for a,b in itertools.combinations(sorted(s["concepts"]), 2):
                co[a][b]+=1; co[b][a]+=1
            for c in s["concepts"]: total_co[c]+=1 
        all_cids = set(cid2idx.keys()); used=set(); out=[]; k=1
        while all_cids - used and k <= K:
            candidates = list(all_cids - used)
            if not candidates: break
            root = max(candidates, key=lambda x: total_co[x])
            nbrs = [cid for cid,_cnt in co[root].most_common(top_m-1)]
            cids = [root] + [c for c in nbrs if c not in used][:top_m-1]
            if len(cids) < 2:
                used.add(root)
                continue
            w = [1.0] + [0.9**i for i in range(len(cids)-1)]
            sw=sum(w); w=[x/sw for x in w]
            sscores=[]
            for s in sentences:
                sscores.append((s["sid"], sum(1 for cid in set(cids) if cid in s["concepts"])))
            s_sorted = sorted(sscores, key=lambda x: x[1], reverse=True)
            top_sids = [sid for sid,score in s_sorted[:top_m] if score>0]
            if not top_sids:
                used.update(cids)
                continue
            out.append({"tid":f"t{k}", "concept_ids":cids, "weights":w, "top_sent_ids":top_sids})
            used.update(cids); k+=1
        return out

def _prompt_hyperedges_from_topic(topic: Dict[str,Any], concepts: List[Dict[str,Any]], sent_map: Dict[int, Dict[str,Any]]) -> str:
    topic_json = {
        "tid": topic["tid"],
        "concepts": [{"id": cid, "label": next(c["label"] for c in concepts if c["id"]==cid)} for cid in topic["concept_ids"]],
        "top_sentences": [{"sid": sid, "text": sent_map[sid]["text"]} for sid in topic["top_sent_ids"] if sid in sent_map]
    }
    rel_list = ", ".join(RELATION_CANON)
    return (f"""
[역할] 하이라이트 문맥만으로 다개념 관계(hyperedge)를 도출하는 분석기.
[자료] 아래 JSON의 개념/문장만 사용하세요. 외부지식 금지.
[요구]
- 2~4개의 개념을 한 맥락으로 묶은 하이퍼엣지를 2~6개 제안.
- 각 하이퍼엣지: 
  - concept_ids(2~4), relation_label_free(맥락 포함 자연어), 
  - relation_type_norm([{rel_list}] 중 1~3), 
  - facets(scope/mechanism/conditions/exceptions/purpose/granularity),
  - evidence: 문장 sid 배열(1~3, 필수)
- JSON만 출력.
[입력(JSON)]
{json.dumps(topic_json, ensure_ascii=False)}
""").strip()

def _build_hyperedges_for_topics(topics, concepts, sentences, model="gpt-4o-mini") -> List[Dict[str,Any]]:
    sent_map = {s["sid"]: s for s in sentences}
    edges = []
    for t in topics:
        if len(t["concept_ids"])<2 or not t["top_sent_ids"]: 
            continue
        prompt = _prompt_hyperedges_from_topic(t, concepts, sent_map)
        try:
            raw = ASK_JSON(prompt, model=model, temperature=0.2, max_tokens=1400)
            cands = raw.get("hyperedges") or raw.get("edges") or []
        except Exception:
            raw = ASK_JSON(prompt, model=model, temperature=0.1, max_tokens=1200)
            cands = raw.get("hyperedges") or raw.get("edges") or []
        for e in cands:
            cids = e.get("concept_ids") or []
            if len(cids) < 2: 
                continue
            ev_sids = e.get("evidence") or e.get("source_sent_ids") or []
            if not ev_sids: 
                continue
            ev = []
            for sid in ev_sids[:3]:
                s = sent_map.get(int(sid))
                if s: ev.append({"chunkId": s["chunkId"], "sid": s["sid"]})
            if not ev: 
                continue
            rel_free = (e.get("relation_label_free") or "").strip()
            rel_norm = [r for r in (e.get("relation_type_norm") or []) if r in RELATION_CANON] or ["지원/근거"]
            facets = e.get("facets") or {}
            w = 0.0
            for cid in set(cids):
                if cid in t["concept_ids"]:
                    idx = t["concept_ids"].index(cid)
                    w += t["weights"][idx]
            w += min(2, len(ev))*0.1
            edges.append({
                "hid": f"h{len(edges)+1}",
                "concept_ids": list(dict.fromkeys(cids)),
                "relation_label_free": rel_free,
                "relation_type_norm": rel_norm,
                "facets": facets,
                "evidence": ev,
                "score": float(w)
            })
    def _key(e): return (tuple(sorted(e["concept_ids"])), "|".join(sorted(e["relation_type_norm"])))
    grouped = collections.defaultdict(list)
    for e in edges: grouped[_key(e)].append(e)
    merged=[]
    for _, arr in grouped.items():
        arr = sorted(arr, key=lambda x: x["score"], reverse=True)
        merged.append(arr[0])
    return sorted(merged, key=lambda x: x["score"], reverse=True)[:30]

def _prompt_questions_from_hyperedges(hes: List[Dict[str,Any]], concepts: List[Dict[str,Any]]) -> str:
    concept_by_id = {c["id"]: c for c in concepts}
    input_json = []
    for h in hes:
        input_json.append({
            "hid": h["hid"],
            "concepts": [{"id": cid, "label": concept_by_id[cid]["label"]} for cid in h["concept_ids"] if cid in concept_by_id],
            "relation_label_free": h["relation_label_free"],
            "relation_type_norm": h["relation_type_norm"],
            "facets": h["facets"],
            "evidence": h["evidence"]
        })
    return ("""
[역할] 관계 중심 '자유 서술형' 문제 출제기.
[지침]
- 문제에는 '정의/조건/과정' 같은 서술 지시를 넣지 마세요.
- **입력된 Facets(scope, mechanism, conditions 등) 정보**를 바탕으로 문제의 구체성을 높이세요.
- 개념 묶음이 자연스럽게 상위 주제/핵심 개념을 설명하도록 물어보세요.
- 외부지식 금지. 입력의 개념/문장 근거만 사용.
- 각 문항에는 모범답안을 제외하고, 간단 루브릭(3~5개, 가중치 합 1.0)만 포함.
- **[핵심 지침]** 루브릭의 가중치는 **기본 개념 이해(정의, 단순 관계)는 낮게(0.1~0.3)**, **Facets 관련 심층적 관계(기전/조건/예외 등)는 높게(0.4 이상)** 부여하세요.
[출력(JSON)]
{\"questions\":[
  {
    \"q\": \"불교에서 말하는 무아와 무상을 바탕으로 연기를 설명하시오.\",
    \"hid\": \"h3\",
    \"concept_ids\": [\"u1\",\"u2\",\"u5\"],
    \"relation_label_free\": \"...\",
    \"relation_type_norm\": [\"전제/조건\",\"정의/동일시\"],
    \"source_sent_ids\": [12,13],
    \"rubric\": [
      {\"key\":\"핵심개념 이해(무아/무상 정의)\",\"weight\":0.2},
      {\"key\":\"연기의 조건적 발생 원리 설명\",\"weight\":0.5},
      {\"key\":\"근거 인용\",\"weight\":0.3}
    ],
    \"facets\": { \"scope\":\"...\", \"mechanism\":\"...\", \"conditions\":[\"...\"], \"exceptions\":[\"...\"], \"purpose\":\"...\", \"granularity\":\"...\" }
  }
]}
[입력(JSON)]
"""
    .strip() + "\n" + json.dumps({"hyperedges": input_json}, ensure_ascii=False))
    
def _generate_relation_questions(hyperedges: List[Dict[str,Any]], concepts: List[Dict[str,Any]], desired_n:int, model="gpt-4o-mini") -> List[Dict[str,Any]]:
    if not hyperedges: return []
    subset = sorted(hyperedges, key=lambda x: x.get('score', 0), reverse=True)[: min(len(hyperedges), max(6, desired_n*3))]
    raw = ASK_JSON(_prompt_questions_from_hyperedges(subset, concepts), model=model, temperature=0.3, max_tokens=1400)
    qs = raw.get("questions", []) or []
    he_map = {h['hid']: h for h in subset}
    def _renorm(weights):
        s = sum(w.get("weight",0.0) for w in weights) or 1.0
        for w in weights: w["weight"] = float(w.get("weight",0.0))/s
        return weights
    out=[]
    for q in qs:
        if not q.get("q"): continue
        cids = q.get("concept_ids") or []
        if len(cids)<2: continue
        src = q.get("source_sent_ids") or []
        if not src: continue
        hid = q.get('hid')
        he_score = he_map.get(hid, {}).get('score', 0.0)
        out.append({
            "type":"discussion",
            "q": q["q"].strip(),
            "concept_ids": cids,
            "relation_label_free": (q.get("relation_label_free") or "").strip(),
            "relation_type_norm": q.get("relation_type_norm") or [],
            "rubric": _renorm(q.get("rubric") or [
                {"key":"핵심개념 이해","weight":0.34},
                {"key":"관계 설명","weight":0.33},
                {"key":"근거 인용","weight":0.33}
            ]),
            "facets": q.get("facets") or {},
            "source_sent_ids": src,
            "score": he_score
        })
    return out[:desired_n] # ⭐️ 버그 수정: 'out'을 반환해야 함 (desired_n으로 자름)

def _assemble_relation_payload(book_id: str, discussion_items: List[Dict[str,Any]], sentences: List[Dict[str,Any]]) -> Dict[str,Any]:
    sid2s = {s["sid"]: s for s in sentences}
    for it in discussion_items:
        src_pairs=[]
        for sid in it.get("source_sent_ids", [])[:3]:
            s = sid2s.get(int(sid))
            if s: 
                primary_chunk_id = s.get("chunkId", ["c0"])[0] 
                src_pairs.append({"chunkId": primary_chunk_id, "sentId": s["sid"]}) 
        it["sources"] = src_pairs
        it["tags"] = ["highlight-based","relation"]
        it.pop("source_sent_ids", None)
    return {"status":"ok","review":{"ox":[],"short":[],"discussion":discussion_items},"meta":{"bookId": book_id, "model":"gpt-4o-mini"}}

def _calculate_topic_discussion_count(N_concept: int) -> int:
    import math
    A = 1.75
    B = 0.5
    MAX_COUNT = 8
    if N_concept < 1:
        return 1
    calculated_n = round(A * math.log(N_concept) + B)
    return max(1, min(MAX_COUNT, calculated_n))

def generate_relation_discussion_from_chunks(
    book_id: str,
    user_concepts: List[str],
    target_chunks: List[Chunk],
    desired_discussion_n:int = 3,
    lda_K:int = 8
) -> Dict[str,Any]:
    concepts, sentences = _build_inventory_from_chunks(user_concepts, target_chunks, dedup=True)
    if len(concepts) < 2: return {"status":"no-concepts"}
    topics = _topic_groups(concepts, sentences, K=lda_K, top_m=5)
    if not topics: return {"status":"no-topics"}
    all_discussion_items = []
    print(f"[DEBUG] Found {len(concepts)} concepts across {len(topics)} topics.")
    for topic in topics:
        topic_concept_count = len(topic["concept_ids"])
        topic_desired_n = _calculate_topic_discussion_count(topic_concept_count)
        single_topic_list = [topic] 
        hyperedges = _build_hyperedges_for_topics(single_topic_list, concepts, sentences, model="gpt-4o-mini")
        if not hyperedges: 
            print(f"[DEBUG] Topic {topic['tid']} (Concepts: {topic_concept_count}) generated no hyperedges.")
            continue
        discussion_items = _generate_relation_questions(
            hyperedges, 
            concepts, 
            desired_n=topic_desired_n,
            model="gpt-4o-mini"
        )
        if discussion_items:
            print(f"[DEBUG] Topic {topic['tid']} successfully generated {len(discussion_items)} questions (Target: {topic_desired_n}).")
            all_discussion_items.extend(discussion_items)
        else:
             print(f"[DEBUG] Topic {topic['tid']} generated no questions.")
    if not all_discussion_items: return {"status":"no-questions"}
    max_limit = desired_discussion_n if desired_discussion_n > 0 else 10
    final_discussions = sorted(all_discussion_items, key=lambda x: x.get('score', 0.0), reverse=True)
    final_discussions = final_discussions[:max_limit]
    return _assemble_relation_payload(book_id, final_discussions, sentences)

def _fallback_relation_discussion_from_chunks(
    book_id: str,
    user_concepts: List[str],
    target_chunks: List[Chunk],
    desired_discussion_n:int = 3
) -> Dict[str, Any]:
    texts = " ".join([(c.text or "") for c in target_chunks])
    toks = re.findall(r"[A-Za-z가-힣]{2,}", texts)
    base_concepts = [w.lower() for w,_ in collections.Counter(toks).most_common(20)]
    if user_concepts:
        uc = [u.lower() for u in user_concepts]
        base_concepts = list(dict.fromkeys(uc + base_concepts))
    def combos(items, k):
        return list(itertools.combinations(items, k))
    pairs = combos(base_concepts[:12], 2)
    trips = combos(base_concepts[:12], 3)
    cand_groups = []
    for a,b in pairs[:desired_discussion_n*2]:
        cand_groups.append([a,b])
    for a,b,c in trips[:desired_discussion_n*2]:
        cand_groups.append([a,b,c])
    def find_sources(group):
        group_set = set(group)
        scored = []
        for ch in target_chunks:
            sents = re.split(r"(?<=[.!?]|다\.|요\.)\s+|(?<=\n)", ch.text or "")
            for s in sents:
                hit = sum(1 for g in group_set if g in s.lower())
                if hit>0:
                    scored.append((hit, ch.id))
        scored = sorted(scored, key=lambda x: x[0], reverse=True)[:2]
        return [sid for _hit, sid in scored] or ([target_chunks[0].id] if target_chunks else [])
    out = []
    for g in cand_groups[:desired_discussion_n]:
        topic = " · ".join(sorted(set(g)))
        q = f"다음 개념들을 바탕으로 핵심 주제를 자연스럽게 설명하시오: {topic}"
        hint = "개념 간 관계(원인–결과·정의·부분–전체 등)와 본문 맥락을 연결해 서술하세요."
        out.append({
            "q": q,
            "hint": hint,
            "sources": find_sources(g),
            "tags": ["highlight-based","relation","fallback"]
        })
    return {"status":"ok","review":{"discussion": out}, "meta":{"bookId":book_id, "model":"fallback-local"}}

def _collect_target_chunks(doc: PreprocessedDoc, section: Optional[str], chunk_ids: Optional[List[str]]) -> List[Chunk]:
    if section:
        return [c for c in doc.chunks if section in " / ".join(c.section_path or [])]
    if chunk_ids:
        s = set(chunk_ids)
        return [c for c in doc.chunks if c.id in s]
    return []

def _extract_user_concepts_from_chunks(chunks: List[Chunk], top_k:int=10, min_len:int=2) -> List[str]:
    texts = " ".join([c.text or "" for c in chunks])
    toks = re.findall(r"[A-Za-z가-힣]{%d,}"%min_len, texts)
    counter = collections.Counter([t.lower() for t in toks])
    cands = [w for w,_ in counter.most_common(top_k)]
    return cands


def generate_custom_review(
    doc: PreprocessedDoc,
    section: Optional[str] = None,
    chunk_ids: Optional[List[str]] = None,
    keywords: Optional[List[str]] = None,
    model: str = "gpt-4o-mini",
    seed: Optional[int] = None,
    counts_override: Optional[Dict[str, int]] = None,
) -> ReviewOut:
    """
    [⭐️ 성능 개선 버전]
    - 하이라이트 텍스트를 모두 합쳐 API를 2~3번만 호출합니다.
    - (generate_base_review와 거의 동일하게 작동합니다)
    """
    all_ids = _normalize_ids(doc)

    # 1) 대상 청크
    if section:
        target_chunks = [c for c in doc.chunks if section in " / ".join(c.section_path or [])]
    elif chunk_ids:
        id_set = set(chunk_ids)
        target_chunks = [c for c in doc.chunks if c.id in id_set]
    else:
        # chunk_ids가 없으면 빈 값 반환
        return ReviewOut(ox=[], short=[], discussion=[])

    if not target_chunks:
        # 대상 청크가 비어있으면 빈 값 반환
        return ReviewOut(ox=[], short=[], discussion=[])

    # 2) 키워드 (하이라이트 텍스트를 모두 합쳐서 1번만 추출)
    
    # ⭐️ [최적화] 모든 하이라이트 텍스트를 하나로 합침
    selected_text = "\n\n".join([c.text for c in target_chunks])
    
    if keywords:
        kws = keywords
    else:
        try:
            # ⭐️ [API 호출 1] 키워드 1회 추출
            raw_keywords = _ask_gpt_json(_prompt_keywords(selected_text), model=model, temperature=0.2, max_tokens=200)
            kws = raw_keywords.get("keywords", [])
        except Exception:
            kws = ["핵심 개념", "정의", "관계", "예시", "의의"]

    # 3) 개수 (counts_override가 없으면 기본값 사용)
    counts_base = counts_override or {"ox":3, "short":3, "discussion":3}
    
    final_review_output = ReviewOut(ox=[], short=[], discussion=[])
    
    # 4) [⭐️ 최적화] OX/단답: 'for' 루프 제거
    # (하이라이트 전체 텍스트로 API 1회 호출)
    try:
        counts_qa = counts_base.copy()
        counts_qa["discussion"] = 0 # (OX/단답만 생성 요청)
        
        if counts_qa["ox"] > 0 or counts_qa["short"] > 0:
            # ⭐️ [API 호출 2] OX/단답 퀴즈 1회 생성
            raw = _ask_gpt_json(_prompt_review(selected_text, kws, counts_qa), model=model, temperature=0.4, max_tokens=2000)
            rv = raw.get("review", {}) or {}
            
            # (모든 퀴즈의 출처는 이 하이라이트 청크 전체로 설정)
            highlight_chunk_ids = [c.id for c in target_chunks if c.id]
            
            def _fix_item(it: Dict[str, Any], t: str) -> Dict[str, Any]:
                it = dict(it)
                it["tags"] = list(dict.fromkeys((it.get("tags") or []) + [t]))
                it["sources"] = _fix_sources(it.get("sources", []), all_ids, highlight_chunk_ids)
                return it
            
            final_review_output.ox.extend([_fix_item(it, "OX") for it in (rv.get("ox") or [])])
            final_review_output.short.extend([_fix_item(it, "단답") for it in (rv.get("short") or [])])
    except Exception as e:
         print(f"Warning: OX/Short 퀴즈 생성 실패: {e}")


    # 5) 서술형: 관계형으로 교체 생성 (이 코드는 이미 최적화되어 있음)
    try:
        desired_n = int(counts_base.get("discussion", 0))
        
        # (counts_base에 discussion이 1 이상일 때만 실행)
        if desired_n > 0:
            user_concepts = list(kws) # 2번에서 생성한 키워드 재사용
            
            # ⭐️ [API 호출 3] 서술형 퀴즈 생성
            rel_payload = generate_relation_discussion_from_chunks(
                book_id=doc.doc_id or "doc",
                user_concepts=user_concepts,
                target_chunks=target_chunks, # (모든 하이라이트 청크 전달)
                desired_discussion_n=desired_n,
                lda_K=8
            )
            status = rel_payload.get("status")
            ok = status == "ok" and rel_payload.get("review", {}).get("discussion")

            if not ok: # (폴백 로직)
                rel_payload = _fallback_relation_discussion_from_chunks(
                    book_id=doc.doc_id or "doc",
                    user_concepts=user_concepts,
                    target_chunks=target_chunks,
                    desired_discussion_n=desired_n
                )
                ok = rel_payload.get("status") == "ok" and rel_payload.get("review", {}).get("discussion")

            if ok:
                final_review_output.discussion = rel_payload["review"]["discussion"]
            else:
                print("[DEBUG] Local fallback also failed to generate discussion questions.")

    except Exception as e:
        print(f"[ERROR] 관계형 서술형 생성 중 치명적 오류 발생: {e}")
        # (최종 폴백 로직)
        try:
            fallback_n = max(1, int(counts_base.get("discussion", 1)))
            rel_payload = _fallback_relation_discussion_from_chunks(
                book_id=doc.doc_id or "doc",
                user_concepts=[],
                target_chunks=target_chunks,
                desired_discussion_n=fallback_n
            )
            if rel_payload.get("status") == "ok":
                final_review_output.discussion = rel_payload["review"]["discussion"]
        except Exception:
            print("[ERROR] 최종 폴백 서술형 문제 생성도 실패했습니다.")
            pass

    return final_review_output

# ---------------------------------------------
# --- 7. 서술형 채점 (score_discussion_answer) ---
# ---------------------------------------------

def _prompt_score_discussion(q_data: Dict[str, Any], user_answer: str) -> str:
    """사용자 답안 채점을 위한 프롬프트 템플릿"""
    rubric_str = '\n'.join([
        f"- {r.get('key', 'Unknown')}" 
        for r in q_data.get('rubric', [])
    ])
    return textwrap.dedent(f"""
    [역할] 서술형 답안의 '루브릭 기반 채점' 및 '피드백' 생성기.
    [채점 지침]
    1. **절대 모범답안을 노출하지 마세요.**
    2. 사용자 답안을 분석하여 **각 루브릭 항목(key)**에 대해 10점 만점으로 점수(score_out_of_10)를 매기세요.
    3. 각 항목 점수를 바탕으로 답안의 전체적인 **수준을 한 문장으로 평가(llm_assessment)**하세요.
    4. 루브릭을 유출하지 않으면서도, 사용자가 **다음에 어떤 내용을 추가/보완**해야 할지 힌트를 주는 **'한 줄 팁(feedback_tip)'**을 생성하세요.
    [문제 정보]
    - 질문: {q_data.get('q')}
    - 필수 포함 개념: {', '.join([f"u{cid}" for cid in q_data.get('concept_ids', [])])}
    - 관계 유형: {', '.join(q_data.get('relation_type_norm', []))}
    - 루브릭 항목 (10점 만점으로 평가하세요):
    {rubric_str}
    [사용자 답안]
    {user_answer}
    [출력(JSON)]
    {{
      "score_breakdown": [
        {{"key": "루브릭 항목 1의 key", "score_out_of_10": 7.5}},
        {{"key": "루브릭 항목 2의 key", "score_out_of_10": 9.0}}
      ],
      "llm_assessment": "답안은 핵심 개념을 정확히 이해하고 있으나, 관계를 설명하는 논리가 다소 부족합니다.",
      "feedback_tip": "제시된 개념들이 어떠한 '기전'을 통해 상호작용하는지에 대한 내용을 보충해보세요."
    }}
    """).strip()

def score_discussion_answer(
    answer_data: AnswerIn,
    model: str = "gpt-4o-mini"
) -> ScoreResult:
    """
    사용자 답안을 문제의 루브릭과 가중치에 기반하여 채점하고 피드백 팁을 생성합니다.
    """
    q_data = answer_data.q_data
    user_answer = answer_data.user_answer
    q_data_dict = q_data.model_dump()
    prompt = _prompt_score_discussion(q_data_dict, user_answer) 
    try:
        raw_data = _ask_gpt_json(
            prompt, 
            model=model, 
            temperature=0.1, 
            max_tokens=1000 
        )
    except Exception as e:
        print(f"[ERROR] 채점 API 호출 중 오류 발생: {e}")
        return ScoreResult(
            score_breakdown=[], final_score=0.0, 
            feedback_tip="채점 서비스 오류. 서버 로그를 확인하세요.", 
            llm_assessment="API_FAIL"
        )
    rubric_map = {r['key']: r['weight'] for r in q_data_dict.get('rubric', [])}
    if not raw_data.get("score_breakdown"):
        return ScoreResult(score_breakdown=[], final_score=0.0, feedback_tip="LLM이 유효한 JSON을 반환하지 않았습니다.", llm_assessment="INVALID_RESPONSE")
    total_score = 0.0
    score_breakdown_out = []
    for rubric_key, weight in rubric_map.items():
        item = next((i for i in raw_data["score_breakdown"] if i.get('key') == rubric_key), None)
        if item:
            score_out_of_10 = item.get("score_out_of_10", 0.0)
        else:
            score_out_of_10 = 0.0 
        weighted_score = (score_out_of_10 / 10.0) * weight
        total_score += weighted_score
        score_breakdown_out.append({
            'key': rubric_key,
            'score_out_of_10': float(score_out_of_10),
            'weight': float(weight)
        })
    final_score = round(total_score * 100, 1)
    return ScoreResult(
        score_breakdown=score_breakdown_out,
        final_score=final_score,
        feedback_tip=raw_data.get("feedback_tip", "제공된 팁이 없습니다."),
        llm_assessment=raw_data.get("llm_assessment", "N/A")
    )