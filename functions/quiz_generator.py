# quiz_generator.py
from __future__ import annotations
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass
import re
import uuid
import fitz  # PyMuPDF
from langchain_text_splitters import RecursiveCharacterTextSplitter
from pydantic import BaseModel, Field
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
from rank_bm25 import BM25Okapi
import base64

# ---------------------------------------------
# --- 1. 기본 설정 및 클라이언트 ---
# ---------------------------------------------

class PdfReadError(Exception): pass

def _get_client() -> "OpenAI":
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("환경변수 OPENAI_API_KEY가 필요합니다.")
    return OpenAI(api_key=api_key)

def _encode_image_base64(pix_map) -> str:
    return base64.b64encode(pix_map.tobytes()).decode("utf-8")

# ---------------------------------------------
# --- 2. 데이터 모델 (Pydantic) ---
# ---------------------------------------------

class Chunk(BaseModel):
    id: Optional[str] = None
    text: str
    section_path: Optional[List[str]] = None
    anchors: Optional[List[str]] = None
    embedding: Optional[List[float]] = None
    metadata: Optional[Dict[str, Any]] = None
    page_content: str
    # ⭐️ [Advanced RAG] 검색 정확도를 위한 시멘틱 메타데이터
    keywords: List[str] = Field(default_factory=list) 
    chapter: str = ""

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
# --- 3. OpenAI Vision & Helper Functions ---
# ---------------------------------------------

def _ask_gpt_json_vision(base64_image: str, prompt: str, model: str = "gpt-4o") -> Dict[str, Any]:
    client = _get_client()
    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{base64_image}"}},
                    ],
                }
            ],
            max_tokens=2000, 
        )
        return {"content": response.choices[0].message.content}
    except Exception as e:
        print(f"GPT Vision Error: {e}")
        return {"content": ""}

def _check_is_math_page_with_mini(text: str) -> bool:
    if len(text.strip()) < 30: return False
    client = _get_client()
    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini", 
            messages=[
                {"role": "system", "content": "당신은 수학 수식 탐지기입니다. 텍스트에 수학적 표기(공식, 방정식, 시그마, 적분 기호 등)가 포함되어 있는지 엄격하게 확인하세요."},
                {"role": "user", "content": f"다음 텍스트를 분석하세요. 수식이 포함되어 있나요?\n\n[텍스트]\n{text[:800]}\n\n[출력(JSON)] {{'is_math': true}} 또는 {{'is_math': false}}"}
            ],
            response_format={"type": "json_object"},
            temperature=0, max_tokens=50
        )
        result = json.loads(response.choices[0].message.content)
        return result.get("is_math", False)
    except:
        return True

def enrich_chunk_metadata(text: str) -> Dict[str, Any]:
    """[Advanced RAG] 청크 생성 시 키워드/주제 추출"""
    client = _get_client()
    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "당신은 텍스트 분석가입니다. 주어진 텍스트에서 1) 핵심 키워드 5개(한국어 우선), 2) 이 내용의 주제(Chapter 제목)를 추출하세요."},
                {"role": "user", "content": f"[텍스트]\n{text[:1500]}\n\n[출력(JSON)] {{'keywords': ['키워드1', ...], 'chapter': '주제'}}"} 
            ],
            response_format={"type": "json_object"},
            temperature=0.2, max_tokens=150
        )
        return json.loads(response.choices[0].message.content)
    except:
        return {"keywords": [], "chapter": ""}

def _ask_gpt_json(prompt: str, model: str, temperature: float, max_tokens: int) -> Any:
    client = _get_client()
    try:
        rsp = client.chat.completions.create(
            model=model, temperature=temperature, max_tokens=max_tokens,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": "당신은 교재 기반 학습 도우미입니다. 반드시 JSON 형식으로만 응답하세요."},
                {"role": "user", "content": prompt},
            ],
        )
        return json.loads(rsp.choices[0].message.content)
    except Exception as e:
        print(f"API Error: {e}")
        return {}

# ---------------------------------------------
# --- 4. PDF Processing (Main) ---
# ---------------------------------------------

def pdf_to_preprocessed_doc(pdf_bytes: bytes, doc_id: Optional[str] = None) -> PreprocessedDoc:
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise PdfReadError(f"PDF Open Error: {e}")

    chunks: List[Chunk] = []
    text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=100)
    print(f"--- 🚦 Processing PDF ({len(doc)} pages) ---")

    for page_num, page in enumerate(doc):
        try:
            raw_text = page.get_text("text")
            use_vision = _check_is_math_page_with_mini(raw_text)
            final_text, source_type = raw_text, "pdf-text"

            if use_vision:
                print(f"   📸 [P.{page_num+1}] 수식 감지! Vision 변환 중...")
                mat = fitz.Matrix(2, 2)
                pix = page.get_pixmap(matrix=mat)
                base64_img = _encode_image_base64(pix)
                res = _ask_gpt_json_vision(
                    base64_img, 
                    "이미지의 텍스트를 추출하세요. 수식은 LaTeX 포맷($...$)으로, 표는 마크다운으로 변환하세요. 설명 없이 결과만 출력하세요.", 
                    "gpt-4o"
                )
                final_text = res.get("content", "")
                source_type = "gpt-4o-vision"
            if not final_text.strip(): continue

            for text_chunk in text_splitter.split_text(final_text):
                enriched = enrich_chunk_metadata(text_chunk) if len(text_chunk) > 100 else {}
                chunks.append(Chunk(
                    id=str(uuid.uuid4()),
                    text=text_chunk,
                    page_content=text_chunk,
                    metadata={"page": page_num + 1, "source": source_type, "bookId": doc_id},
                    keywords=enriched.get("keywords", []),
                    chapter=enriched.get("chapter", "")
                ))
        except Exception as e:
            print(f"Page {page_num} Error: {e}")
            continue

    return PreprocessedDoc(doc_id=doc_id, chunks=chunks)

# ---------------------------------------------
# --- 5. Prompts & Utils ---
# ---------------------------------------------

def _normalize_ids(doc: PreprocessedDoc) -> List[str]:
    for i, ch in enumerate(doc.chunks):
        if not ch.id: ch.id = f"c{i}"
    return [c.id for c in doc.chunks]

def _select_scope(doc: PreprocessedDoc, section_contains: Optional[str], chunk_ids: Optional[List[str]], auto_chars: int = 4000) -> Tuple[str, List[str]]:
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
            if not t: continue
            if total + len(t) > auto_chars and total > 0: break
            sel.append(c)
            total += len(t)
    if not sel: return "", []
    joined = [c.text for c in sel]
    ids = [c.id for c in sel]
    return "\n\n".join(joined), ids

def _fix_sources(candidate: List[str], valid_ids: List[str], fallback: List[str]) -> List[str]:
    valid = set(valid_ids)
    out = [s for s in (candidate or []) if s in valid]
    return out or (fallback if fallback else (valid_ids[:1] if valid_ids else []))

def _prompt_summaries(text: str) -> str:
    return f"[과제] 아래 텍스트를 바탕으로 핵심 내용을 요약하세요.\n[텍스트] {text}\n[출력(JSON)] {{ 'summary': '요약 내용...', 'sources': [] }}"

def _prompt_keywords(text: str) -> str:
    return f"[과제] 텍스트에서 가장 중요한 핵심 키워드 5~7개를 추출하세요.\n[텍스트] {text}\n[출력(JSON)] {{ 'keywords': ['키워드1', '키워드2', ...] }}"

def _prompt_review(text: str, kws: List[str], counts: Dict[str, int]) -> str:
    kw_str = ", ".join(kws)
    return textwrap.dedent(f"""
    [과제] 제공된 텍스트와 키워드를 바탕으로 학습용 문제를 출제하세요.
    - 문항 수: OX 퀴즈 {counts['ox']}개, 단답형 {counts['short']}개
    - 언어: 한국어
    [키워드] {kw_str}
    [형식]
    - OX: "q"(질문), "answer"(true/false), "why"(해설), "sources"(근거 문장 ID)
    - 단답: "q"(질문), "answer"(단답형 정답), "sources"
    [출력(JSON)]
    {{ "review": {{ "ox": [], "short": [] }} }}
    [텍스트]
    {text}
    """).strip()

# ---------------------------------------------
# --- 6. Base Summary & Quiz Generation ---
# ---------------------------------------------

def generate_summaries(doc: PreprocessedDoc, section: Optional[str] = None, chunk_ids: Optional[List[str]] = None, model: str = "gpt-4o-mini") -> SummaryOut:
    all_ids = _normalize_ids(doc)
    text, used_ids = _select_scope(doc, section, chunk_ids)
    if not text: return SummaryOut(summary="", sources=[])
    data = _ask_gpt_json(_prompt_summaries(text), model, 0.2, 1000)
    return SummaryOut(summary=data.get("summary", ""), sources=_fix_sources(data.get("sources", []), all_ids, used_ids))

def generate_base_review(doc: PreprocessedDoc, model: str = "gpt-4o-mini", seed: Optional[int] = None) -> Output:
    _normalize_ids(doc)
    full_text, all_ids = _select_scope(doc, None, None, auto_chars=8000)
    if not full_text:
        return Output(summaries=SummaryOut(summary="", sources=[]), review=ReviewOut(ox=[], short=[], discussion=[]), meta={})

    summary_out = generate_summaries(doc, chunk_ids=all_ids, model=model)
    
    try:
        kws = _ask_gpt_json(_prompt_keywords(full_text), model, 0.2, 200).get("keywords", [])
    except: kws = []

    review_out = ReviewOut(ox=[], short=[], discussion=[])
    try:
        counts = {"ox": 3, "short": 3, "discussion": 0}
        raw = _ask_gpt_json(_prompt_review(full_text, kws, counts), model, 0.4, 2000).get("review", {})
        def fix(i): 
            i["sources"] = _fix_sources(i.get("sources", []), all_ids, all_ids)
            return i
        review_out.ox = [fix(x) for x in raw.get("ox", [])]
        review_out.short = [fix(x) for x in raw.get("short", [])]
    except Exception as e:
        print(f"Base Quiz Error: {e}")

    return Output(summaries=summary_out, review=review_out, meta={"model": model, "doc_id": doc.doc_id})

# ---------------------------------------------
# --- 7. [Advanced] BM25 Search ---
# ---------------------------------------------

def search_chunks_with_bm25(doc: PreprocessedDoc, query: str, top_k: int = 3) -> List[Chunk]:
    if not doc.chunks: return []
    # [Document Expansion] 본문 + 키워드 + 챕터
    tokenized_corpus = []
    for chunk in doc.chunks:
        keywords_str = " ".join(chunk.keywords) if chunk.keywords else ""
        chapter_str = chunk.chapter if chunk.chapter else ""
        expanded = f"{chunk.text} {keywords_str} {keywords_str} {chapter_str}"
        tokenized_corpus.append(expanded.split())

    bm25 = BM25Okapi(tokenized_corpus)
    top_chunks = bm25.get_top_n(query.split(), doc.chunks, n=top_k)
    print(f"--- 🔍 Advanced BM25: Found {len(top_chunks)} chunks for '{query}' ---")
    return top_chunks

# ---------------------------------------------
# --- 8. [MISSING PART RESTORED] Relation Logic ---
# ---------------------------------------------

RELATION_CANON = ["원인-결과","전제/조건","수단/방법","목적","상하위","부분-전체","정의/동일시","비교/대조","사례/구체화","지원/근거","반박/제약"]

def _norm_concept(s: str) -> str:
    s = re.sub(r"[()\[\]{}:;\"'`·•—–\-]", " ", s.strip().lower())
    return re.sub(r"\s+", " ", s).strip()

def _sent_split(text: str) -> List[str]:
    parts = re.split(r'(?<=[.?!])\s+|\n{2,}', text or "")
    return [p.strip() for p in parts if len(p.strip()) > 5]

def _build_inventory_from_chunks(concepts_user: List[str], target_chunks: List[Chunk], dedup: bool = True) -> Tuple[List[Dict], List[Dict]]:
    concepts, seen = [], set()
    for i, raw in enumerate(concepts_user or []):
        key = _norm_concept(raw)
        if key and key not in seen:
            seen.add(key)
            concepts.append({"id": f"u{i+1}", "label": raw, "aliases": [raw, key]})
    
    sentences, sid = [], 1
    for ch in target_chunks:
        for s_text in _sent_split(ch.text):
            hits = [c["id"] for c in concepts if any(a in s_text.lower() for a in c["aliases"])]
            if hits:
                sentences.append({"sid": sid, "chunkId": [ch.id], "text": s_text, "concepts": sorted(set(hits))})
                sid += 1
    return concepts, sentences

def _topic_groups(concepts, sentences, K=5, top_m=5):
    # Simplified LDA for brevity, assuming sklearn is installed
    try:
        from sklearn.decomposition import LatentDirichletAllocation
        cid2idx = {c["id"]: i for i, c in enumerate(concepts)}
        X = []
        valid_sids = []
        for s in sentences:
            row = [0] * len(concepts)
            for c in s["concepts"]: row[cid2idx[c]] += 1
            if sum(row) > 0:
                X.append(row)
                valid_sids.append(s["sid"])
        
        if not X: return []
        lda = LatentDirichletAllocation(n_components=min(K, len(X)), random_state=42)
        lda.fit(X)
        
        groups = []
        for k, topic in enumerate(lda.components_):
            top_idx = topic.argsort()[:-top_m-1:-1]
            cids = [concepts[i]["id"] for i in top_idx]
            groups.append({"tid": f"t{k}", "concept_ids": cids, "top_sent_ids": valid_sids[:5], "weights": [1.0]*len(cids)})
        return groups
    except:
        return [] # Fallback if sklearn fails

def _build_hyperedges_for_topics(topics, concepts, sentences, model) -> List[Dict]:
    sent_map = {s["sid"]: s for s in sentences}
    edges = []
    for t in topics:
        if len(t["concept_ids"]) < 2: continue
        # Simplified prompt generation
        concepts_info = [{"id": c, "label": next(x["label"] for x in concepts if x["id"]==c)} for c in t["concept_ids"]]
        prompt = f"""주어진 문맥(Context)을 바탕으로 개념(Concepts)들 간의 관계를 파악하세요.
        [개념] {json.dumps(concepts_info, ensure_ascii=False)}
        [문맥] {[sent_map[sid]['text'] for sid in t['top_sent_ids'] if sid in sent_map]}
        [출력(JSON)] {{ "hyperedges": [ {{ "concept_ids": ["u1", "u2"], "relation_type_norm": ["원인-결과", "대조"], "evidence": [sid...] }} ] }}"""
        
        try:
            raw = _ask_gpt_json(prompt, model, 0.2, 1000)
            for e in raw.get("hyperedges", []):
                edges.append({
                    "hid": f"h{len(edges)}", "concept_ids": e.get("concept_ids"), 
                    "relation_type_norm": e.get("relation_type_norm"), 
                    "evidence": [{"sid": sid} for sid in e.get("evidence", [])]
                })
        except: pass
    return edges

def _generate_relation_questions(hyperedges, concepts, desired_n, model) -> List[Dict]:
    if not hyperedges: return []
    prompt = f"""분석된 개념 간의 관계를 바탕으로 심층적인 서술형/토론 문제를 {desired_n}개 생성하세요.
    [관계 데이터] {json.dumps(hyperedges[:5], ensure_ascii=False)}
    [출력(JSON)] {{ "questions": [ {{ "q": "질문 내용...", "concept_ids": [...], "source_sent_ids": [...] }} ] }}"""
    
    try:
        raw = _ask_gpt_json(prompt, model, 0.3, 1500)
        out = []
        for q in raw.get("questions", []):
            out.append({
                "type": "discussion", "q": q["q"], "concept_ids": q.get("concept_ids", []),
                "rubric": [{"key": "핵심 개념 이해", "weight": 0.5}, {"key": "논리적 설명", "weight": 0.5}],
                "source_sent_ids": q.get("source_sent_ids", [])
            })
        return out[:desired_n]
    except: return []

def generate_relation_discussion_from_chunks(book_id, user_concepts, target_chunks, desired_discussion_n=3, lda_K=8) -> Dict:
    concepts, sentences = _build_inventory_from_chunks(user_concepts, target_chunks)
    if len(concepts) < 2: return {"status": "fail"}
    
    topics = _topic_groups(concepts, sentences, K=lda_K)
    hyperedges = _build_hyperedges_for_topics(topics, concepts, sentences, "gpt-4o-mini")
    questions = _generate_relation_questions(hyperedges, concepts, desired_discussion_n, "gpt-4o-mini")
    
    # Assemble sources
    sid2s = {s["sid"]: s for s in sentences}
    for q in questions:
        q["sources"] = []
        for sid in q.get("source_sent_ids", [])[:2]:
            if sid in sid2s: q["sources"].append(sid2s[sid]["chunkId"][0])
        q.pop("source_sent_ids", None)
    
    return {"status": "ok", "review": {"discussion": questions}}

def _fallback_relation_discussion_from_chunks(book_id, user_concepts, target_chunks, desired_discussion_n=3) -> Dict:
    # Simple fallback without complex logic
    q_list = []
    for i in range(desired_discussion_n):
        q_list.append({
            "q": "선택된 텍스트에서 식별된 핵심 개념들과 그 관계에 대해 설명하시오.",
            "hint": "원인과 결과, 혹은 주요 특징을 중심으로 서술하세요.",
            "sources": [target_chunks[0].id] if target_chunks else [],
            "tags": ["fallback"]
        })
    return {"status": "ok", "review": {"discussion": q_list}}

# ---------------------------------------------
# --- 9. Custom Review Generation ---
# ---------------------------------------------

def generate_custom_review(
    doc: PreprocessedDoc,
    section: Optional[str] = None,
    chunk_ids: Optional[List[str]] = None,
    search_query: Optional[str] = None,
    keywords: Optional[List[str]] = None,
    model: str = "gpt-4o-mini",
    counts_override: Optional[Dict[str, int]] = None,
) -> ReviewOut:
    all_ids = _normalize_ids(doc)
    
    # 1. Select Targets
    target_chunks = []
    if search_query:
        target_chunks = search_chunks_with_bm25(doc, search_query, top_k=4)       
    elif chunk_ids:
        id_set = set(chunk_ids)
        target_chunks = [c for c in doc.chunks if c.id in id_set]   
    elif section:
        target_chunks = [c for c in doc.chunks if section in " / ".join(c.section_path or [])]
    
    if not target_chunks: return ReviewOut(ox=[], short=[], discussion=[])

    # 2. Keywords
    selected_text = "\n\n".join([c.text for c in target_chunks])
    if keywords: kws = keywords
    else:
        try: kws = _ask_gpt_json(_prompt_keywords(selected_text), model, 0.2, 200).get("keywords", [])
        except: kws = []

    counts = counts_override or {"ox":3, "short":3, "discussion":3}
    final_out = ReviewOut(ox=[], short=[], discussion=[])

    # 3. OX/Short Generation
    if counts.get("ox",0) > 0 or counts.get("short",0) > 0:
        try:
            c_qa = counts.copy(); c_qa["discussion"] = 0
            raw = _ask_gpt_json(_prompt_review(selected_text, kws, c_qa), model, 0.4, 2000).get("review", {})
            hl_ids = [c.id for c in target_chunks]
            def fix(it, t):
                it["tags"] = list(set((it.get("tags") or []) + [t]))
                it["sources"] = _fix_sources(it.get("sources", []), all_ids, hl_ids)
                return it
            final_out.ox = [fix(x, "OX") for x in raw.get("ox", [])]
            final_out.short = [fix(x, "단답") for x in raw.get("short", [])]
        except Exception as e: print(f"OX/Short Error: {e}")

    # 4. Discussion Generation
    if counts.get("discussion", 0) > 0:
        try:
            res = generate_relation_discussion_from_chunks(
                book_id=doc.doc_id or "doc",
                user_concepts=kws,
                target_chunks=target_chunks,
                desired_discussion_n=counts["discussion"]
            )
            if res.get("status") == "ok":
                final_out.discussion = res["review"]["discussion"]
            else:
                # Fallback
                fb = _fallback_relation_discussion_from_chunks(doc.doc_id, kws, target_chunks, counts["discussion"])
                final_out.discussion = fb["review"]["discussion"]
        except Exception as e:
            print(f"Discussion Error: {e}")

    return final_out

# ---------------------------------------------
# --- 10. Scoring ---
# ---------------------------------------------

def _prompt_score_discussion(q_data: Dict[str, Any], user_answer: str) -> str:
    rubric_str = '\n'.join([f"- {r.get('key')}" for r in q_data.get('rubric', [])])
    return textwrap.dedent(f"""
    [역할] 서술형 답안 채점관.
    [지시] 루브릭에 따라 점수를 매기고 피드백을 제공하세요.
    [문제] {q_data.get('q')}
    [루브릭]
    {rubric_str}
    [사용자 답안] {user_answer}
    [출력(JSON)] 
    {{ 
      "score_breakdown": [{{"key": "루브릭항목", "score_out_of_10": 8.0}}], 
      "llm_assessment": "전반적인 평가 한 문장...", 
      "feedback_tip": "보완할 점 한 문장 팁..." 
    }}
    """).strip()

def score_discussion_answer(answer_data: AnswerIn, model: str = "gpt-4o-mini") -> ScoreResult:
    """

    사용자 답안을 문제의 루브릭과 가중치에 기반하여 채점하고 피드백 팁을 생성합니다.

    """
    q_data = answer_data.q_data
    prompt = _prompt_score_discussion(q_data.model_dump(), answer_data.user_answer)
    try:
        raw = _ask_gpt_json(prompt, model, 0.1, 1000)
        total = 0.0
        breakdown = []
        rmap = {r['key']: r['weight'] for r in q_data.rubric}
        for item in raw.get("score_breakdown", []):
            s = item.get("score_out_of_10", 0)
            w = rmap.get(item.get("key"), 0)
            total += (s / 10.0) * w
            breakdown.append(ScoreBreakdown(key=item.get("key"), score_out_of_10=s, weight=w))
        return ScoreResult(score_breakdown=breakdown, final_score=round(total * 100, 1), feedback_tip=raw.get("feedback_tip", ""), llm_assessment=raw.get("llm_assessment", ""))
    except:
        return ScoreResult(score_breakdown=[], final_score=0, feedback_tip="Error", llm_assessment="Error")