# quiz_generator.py
from __future__ import annotations
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass
import re
import uuid
import fitz  # PyMuPDF
from langchain_text_splitters import RecursiveCharacterTextSplitter
from pydantic import BaseModel, Field
from openai import OpenAI, AsyncOpenAI # ⭐️ AsyncOpenAI 추가
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
import asyncio # ⭐️ 비동기 라이브러리 추가

# ---------------------------------------------
# --- 1. 기본 설정 및 클라이언트 ---
# ---------------------------------------------

class PdfReadError(Exception): pass

# 동기 클라이언트 (기존 퀴즈 생성 등에서 사용)
def _get_client() -> "OpenAI":
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key: raise RuntimeError("환경변수 OPENAI_API_KEY가 필요합니다.")
    return OpenAI(api_key=api_key)

# ⭐️ [NEW] 비동기 클라이언트 (병렬 처리용)
def _get_async_client() -> "AsyncOpenAI":
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key: raise RuntimeError("환경변수 OPENAI_API_KEY가 필요합니다.")
    return AsyncOpenAI(api_key=api_key)

def _encode_image_base64(pix_map) -> str:
    return base64.b64encode(pix_map.tobytes()).decode("utf-8")

# ---------------------------------------------
# --- 2. 데이터 모델 (Pydantic) ---
# ---------------------------------------------
# (기존과 동일하므로 생략 없이 그대로 둡니다)
class Chunk(BaseModel):
    id: Optional[str] = None
    text: str
    section_path: Optional[List[str]] = None
    anchors: Optional[List[str]] = None
    embedding: Optional[List[float]] = None
    metadata: Optional[Dict[str, Any]] = None
    page_content: str
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
# --- 3. [Async] OpenAI Vision & Helper Functions ---
# ---------------------------------------------

# ⭐️ async def로 변경 및 await 사용
async def _ask_gpt_json_vision_async(base64_image: str, prompt: str, model: str = "gpt-4o") -> Dict[str, Any]:
    client = _get_async_client()
    try:
        response = await client.chat.completions.create(
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

# ⭐️ async def로 변경
async def _check_is_math_page_with_mini_async(text: str) -> bool:
    if len(text.strip()) < 30: return False
    client = _get_async_client()
    try:
        response = await client.chat.completions.create(
            model="gpt-4o-mini", 
            messages=[
                {"role": "system", "content": "Check if text contains math formulas/symbols."},
                {"role": "user", "content": f"Analyze this text. Output JSON: {{\"is_math\": true}} or {{\"is_math\": false}}\n\nText:\n{text[:800]}"}
            ],
            response_format={"type": "json_object"},
            temperature=0, max_tokens=50
        )
        result = json.loads(response.choices[0].message.content)
        return result.get("is_math", False)
    except:
        return True

# ⭐️ async def로 변경 (메타데이터 추출도 병렬로!)
async def enrich_chunk_metadata_async(text: str) -> Dict[str, Any]:
    client = _get_async_client()
    try:
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "Extract 5 keywords and the main topic/chapter from the text."},
                {"role": "user", "content": f"Text: {text[:1500]}\n\nOutput JSON: {{'keywords': [...], 'chapter': '...'}}"} 
            ],
            response_format={"type": "json_object"},
            temperature=0.2, max_tokens=150
        )
        return json.loads(response.choices[0].message.content)
    except:
        return {"keywords": [], "chapter": ""}

# 동기 함수 (기존 유지 - 퀴즈 생성용)
def _ask_gpt_json(prompt: str, model: str, temperature: float, max_tokens: int) -> Any:
    client = _get_client()
    try:
        rsp = client.chat.completions.create(
            model=model, temperature=temperature, max_tokens=max_tokens,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": "You are a helpful assistant. Output JSON."},
                {"role": "user", "content": prompt},
            ],
        )
        return json.loads(rsp.choices[0].message.content)
    except Exception as e:
        print(f"API Error: {e}")
        return {}

# ---------------------------------------------
# --- 4. [Async] PDF Processing Pipeline ---
# ---------------------------------------------

# ⭐️ 단일 페이지 처리 함수 (비동기 작업 단위)
async def process_single_page(page_num, raw_text, pix_map, doc_id, semaphore):
    """한 페이지를 분석하여 청크 리스트를 반환합니다."""
    # Semaphore: 동시에 실행되는 작업 수 제한 (OpenAI Rate Limit 방지)
    async with semaphore:
        try:
            # 1. 수식 여부 확인 (비동기)
            use_vision = await _check_is_math_page_with_mini_async(raw_text)
            final_text, source_type = raw_text, "pdf-text"

            # 2. Vision 변환 (비동기)
            if use_vision:
                print(f"   📸 [P.{page_num+1}] Math detected, using Vision...")
                base64_img = _encode_image_base64(pix_map)
                res = await _ask_gpt_json_vision_async(base64_img, "Extract text/math to LaTeX.", "gpt-4o")
                final_text = res.get("content", "")
                source_type = "gpt-4o-vision"

            if not final_text.strip(): return []

            # 3. 청크 분할 및 메타데이터 추출 (비동기)
            text_splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=100)
            split_texts = text_splitter.split_text(final_text)
            
            page_chunks = []
            
            # 청크별 메타데이터 추출 작업을 동시에 실행
            enrich_tasks = []
            for text_chunk in split_texts:
                if len(text_chunk) > 100:
                    enrich_tasks.append(enrich_chunk_metadata_async(text_chunk))
                else:
                    enrich_tasks.append(asyncio.sleep(0, result={"keywords": [], "chapter": ""})) # Dummy awaitable
            
            # 모든 청크 메타데이터 분석 완료 대기
            enriched_results = await asyncio.gather(*enrich_tasks)

            for i, text_chunk in enumerate(split_texts):
                enriched = enriched_results[i]
                page_chunks.append(Chunk(
                    id=str(uuid.uuid4()),
                    text=text_chunk,
                    page_content=text_chunk,
                    metadata={"page": page_num + 1, "source": source_type, "bookId": doc_id},
                    keywords=enriched.get("keywords", []),
                    chapter=enriched.get("chapter", "")
                ))
            
            return page_chunks

        except Exception as e:
            print(f"Error on page {page_num}: {e}")
            return []

# ⭐️ 메인 처리 함수 (진입점)
def pdf_to_preprocessed_doc(pdf_bytes: bytes, doc_id: Optional[str] = None) -> PreprocessedDoc:
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise PdfReadError(f"PDF Open Error: {e}")

    print(f"--- 🚀 Smart Hybrid Processing (Parallel) Started: {len(doc)} pages ---")

    # 1. PDF 페이지 데이터 미리 추출 (PyMuPDF는 동기 라이브러리라 미리 빼두는 게 좋음)
    # 메모리 절약을 위해 필요한 것만 추출
    pages_data = []
    for page_num, page in enumerate(doc):
        raw_text = page.get_text("text")
        # 이미지 변환용 행렬 (해상도)
        mat = fitz.Matrix(2, 2)
        pix = page.get_pixmap(matrix=mat)
        pages_data.append((page_num, raw_text, pix))

    # 2. 비동기 실행을 위한 래퍼
    async def run_parallel_processing():
        # 동시 실행 제한 (5개 페이지씩)
        semaphore = asyncio.Semaphore(5) 
        tasks = []
        for p_num, p_text, p_pix in pages_data:
            task = process_single_page(p_num, p_text, p_pix, doc_id, semaphore)
            tasks.append(task)
        
        # 모든 페이지 동시 실행 및 결과 대기
        results = await asyncio.gather(*tasks)
        
        # 결과(이중 리스트) 평탄화 (Flatten)
        flat_chunks = [chunk for page_result in results for chunk in page_result]
        return flat_chunks

    # 3. 동기 환경(Cloud Function)에서 비동기 루프 실행
    final_chunks = asyncio.run(run_parallel_processing())

    return PreprocessedDoc(doc_id=doc_id, chunks=final_chunks)

# ---------------------------------------------
# --- 5. Prompts & Utils (기존과 동일) ---
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
    - OX: "q", "answer"(true/false), "why", "sources"
    - 단답: "q", "answer", "sources"
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
# --- 8. Relation Logic (Helpers) ---
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
        return []

def _build_hyperedges_for_topics(topics, concepts, sentences, model) -> List[Dict]:
    sent_map = {s["sid"]: s for s in sentences}
    edges = []
    for t in topics:
        if len(t["concept_ids"]) < 2: continue
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
    
    sid2s = {s["sid"]: s for s in sentences}
    for q in questions:
        q["sources"] = []
        for sid in q.get("source_sent_ids", [])[:2]:
            if sid in sid2s: q["sources"].append(sid2s[sid]["chunkId"][0])
        q.pop("source_sent_ids", None)
    
    return {"status": "ok", "review": {"discussion": questions}}

def _fallback_relation_discussion_from_chunks(book_id, user_concepts, target_chunks, desired_discussion_n=3) -> Dict:
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
    
    target_chunks = []
    if search_query:
        target_chunks = search_chunks_with_bm25(doc, search_query, top_k=4)       
    elif chunk_ids:
        id_set = set(chunk_ids)
        target_chunks = [c for c in doc.chunks if c.id in id_set]   
    elif section:
        target_chunks = [c for c in doc.chunks if section in " / ".join(c.section_path or [])]
    
    if not target_chunks: return ReviewOut(ox=[], short=[], discussion=[])

    selected_text = "\n\n".join([c.text for c in target_chunks])
    if keywords: kws = keywords
    else:
        try: kws = _ask_gpt_json(_prompt_keywords(selected_text), model, 0.2, 200).get("keywords", [])
        except: kws = []

    counts = counts_override or {"ox":3, "short":3, "discussion":3}
    final_out = ReviewOut(ox=[], short=[], discussion=[])

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

    if counts.get("discussion", 0) > 0:
        try:
            res = generate_relation_discussion_from_chunks(doc.doc_id, kws, target_chunks, counts["discussion"])
            if res.get("status") == "ok":
                final_out.discussion = res["review"]["discussion"]
            else:
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
    [문제] {q_data.get('q')}
    [루브릭] {rubric_str}
    [답안] {user_answer}
    [출력(JSON)] 
    {{ 
      "score_breakdown": [{{"key": "...", "score_out_of_10": 8.0}}], 
      "llm_assessment": "평가...", 
      "feedback_tip": "조언..." 
    }}
    """).strip()

def score_discussion_answer(answer_data: AnswerIn, model: str = "gpt-4o-mini") -> ScoreResult:
    q_data = answer_data.q_data
    prompt = _prompt_score_discussion(q_data.model_dump(), answer_data.user_answer)
    try:
        raw = _ask_gpt_json(prompt, model, 0.1, 1000)
        total = 0.0
        breakdown = []
        rmap = {r['key']: r['weight'] for r in q_data.rubric}
        
        for item in raw.get("score_breakdown", []):
            s = item.get("score_out_of_10", 0)
            
            # 여기서 'w'라는 변수로 만들었습니다.
            w = rmap.get(item.get("key"), 0) 
            
            total += (s / 10.0) * w
            breakdown.append(ScoreBreakdown(key=item.get("key"), score_out_of_10=s, weight=w))
            
        return ScoreResult(
            score_breakdown=breakdown,
            final_score=round(total * 100, 1),
            feedback_tip=raw.get("feedback_tip", ""),
            llm_assessment=raw.get("llm_assessment", "")
        )
    except:
        return ScoreResult(score_breakdown=[], final_score=0, feedback_tip="Error", llm_assessment="Error")