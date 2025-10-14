from __future__ import annotations
import os
from typing import List, Dict, Any, Optional, Tuple
from dataclasses import dataclass
import re
from pydantic import BaseModel
from openai import OpenAI
from sklearn.feature_extraction.text import TfidfVectorizer
import json
from json.decoder import JSONDecodeError
import random
import textwrap

# ----------------- PDF 전처리 유틸리티 -----------------
# ----------------- OpenAI 클라이언트 및 유틸리티 -----------------
def _get_client() -> "OpenAI":
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("환경변수 OPENAI_API_KEY가 필요합니다.")
    return OpenAI(api_key=api_key)

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
            return {}  # 빈 딕셔너리를 반환하여 프로그램이 멈추지 않도록 함
    except Exception as e1:
        print(f"API 호출 중 오류 발생: {e1}")
        return {} # API 호출 실패 시에도 빈 딕셔너리를 반환

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

def generate_embeddings(texts: List[str]) -> np.ndarray:
    if SentenceTransformer is None:
        raise RuntimeError("sentence-transformers 라이브러리가 설치되지 않았습니다.")
    model = SentenceTransformer('paraphrase-multilingual-MiniLM-L12-v2')
    embeddings = model.encode(texts, convert_to_numpy=True)
    return embeddings


# ----------------- 데이터 모델 -----------------
class Chunk(BaseModel):
    id: Optional[str] = None
    text: str
    section_path: Optional[List[str]] = None
    anchors: Optional[List[str]] = None

class PreprocessedDoc(BaseModel):
    doc_id: Optional[str] = None
    chunks: List[Chunk]

class SummaryOut(BaseModel):
    summary_300: str
    summary_half: str
    summary_full: str
    sources: List[str]

class ReviewOut(BaseModel):
    ox: List[Dict[str, Any]]
    short: List[Dict[str, Any]]
    discussion: List[Dict[str, Any]]

class Output(BaseModel):
    summaries: SummaryOut
    review: ReviewOut
    meta: Dict[str, Any]

# ----------------- 프롬프트 템플릿 -----------------
def _prompt_summaries(text: str) -> str:
    return textwrap.dedent(f"""
    [과제]
    아래 텍스트를 근거로 약 300자 이내의 요약을 만드세요.
    - 요약A(약 300자 이내): 핵심만 1문단.

    [텍스트]
    {text}

    [출력(JSON)]
    {{
      "summary_300": "..."
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
        "ox":    [{{"q":"...","answer":true,"why":"...","sources":["c1"],"tags":["OX"],"confused":false}}],
        "short": [{{"q":"...","answer":"...","sources":["c2"],"tags":["단답"],"confused":false}}],
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
    - 추출된 키워드는 텍스트의 주요 개념, 인물, 용어 등이어야 합니다.
    - 키워드만 나열하세요.
    - JSON 형식으로 출력하세요.

    [텍스트]
    {text}

    [출력(JSON)]
    {{
      "keywords": ["키워드1", "키워드2", "키워드3", "키워드4", "키워드5"]
    }}
    """).strip()

# ----------------- 실행 함수: 기본 모듈과 맞춤형 모듈 -----------------
def generate_summaries(
    doc: PreprocessedDoc,
    section: Optional[str] = None,
    chunk_ids: Optional[List[str]] = None,
    model: str = "gpt-4.1-mini",
) -> SummaryOut:
    all_ids = _normalize_ids(doc)
    text, used_ids = _select_scope(doc, section_contains=section, chunk_ids=chunk_ids)
    data = _ask_gpt_json(_prompt_summaries(text), model=model, temperature=0.2, max_tokens=1600)
    data["summary_half"] = ""
    data["summary_full"] = ""
    data["sources"] = _fix_sources(data.get("sources", []), all_ids, used_ids)
    return SummaryOut(**data)

def generate_base_review(
    doc: PreprocessedDoc,
    model: str = "gpt-4o-mini",
    seed: Optional[int] = None,
) -> Output:
    _normalize_ids(doc)

    # 1. 문서 전체 텍스트 대신, 일부만 샘플링하여 키워드 추출
    # [수정] AI 처리 용량 초과를 막기 위해 텍스트 샘플링 로직 추가
    sample_text = ""
    char_limit = 3000  # 키워드 추출에 사용할 최대 글자 수 (조절 가능)
    for c in doc.chunks:
        if len(sample_text) + len(c.text) > char_limit:
            break
        sample_text += c.text + " "

    # 텍스트가 아예 없는 경우 대비
    if not sample_text.strip() and doc.chunks:
        sample_text = doc.chunks[0].text

    try:
        raw_keywords = _ask_gpt_json(
            _prompt_keywords(sample_text.strip()), # 샘플 텍스트 사용
            model=model, temperature=0.2, max_tokens=200
        )
        keywords = raw_keywords.get("keywords", [])
        if not keywords: # 키워드 추출 실패 시 기본값 사용
            raise Exception("Keywords not found")
    except Exception as e:
        print(f"키워드 추출 실패: {e}. 기본 키워드를 사용합니다.")
        keywords = ["핵심 개념", "정의", "관계", "예시", "의의"]

    summaries_list = []
    review_output = ReviewOut(ox=[], short=[], discussion=[])

    # 2. 각 청크(페이지)를 순회하며 요약 및 퀴즈 생성 (이 부분은 원래 로직과 동일)
    for chunk in doc.chunks:
        try:
            chunk_summary_out = generate_summaries(doc, chunk_ids=[chunk.id], model=model)
            summaries_list.append(chunk_summary_out.summary_300)

            text, used_ids_chunk = _select_scope(doc, section_contains=None, chunk_ids=[chunk.id])
            counts = {"ox": 1, "short": 1, "discussion": 0}
            raw = _ask_gpt_json(
                _prompt_review(text, keywords, counts),
                model=model, temperature=0.4, max_tokens=1200
            )
            
            rv = raw.get("review", {}) or {}
            
            for item in rv.get("ox", []):
                item["sources"] = _fix_sources(item.get("sources", []), [c.id for c in doc.chunks], used_ids_chunk)
                review_output.ox.append(item)
                
            for item in rv.get("short", []):
                item["sources"] = _fix_sources(item.get("sources", []), [c.id for c in doc.chunks], used_ids_chunk)
                review_output.short.append(item)
        except Exception:
            continue

    combined_summary = "\n\n".join(summaries_list)
    
    final_summary_out = SummaryOut(
        summary_300="", 
        summary_half="", 
        summary_full=combined_summary,
        sources=[]
    )
    
    return Output(summaries=final_summary_out, review=review_output, meta={"model": model, "doc_id": doc.doc_id})
    
def generate_custom_review(
    doc: PreprocessedDoc,
    section: Optional[str] = None,
    chunk_ids: Optional[List[str]] = None,
    keywords: Optional[List[str]] = None,
    model: str = "gpt-4.1-mini",
    seed: Optional[int] = None,
    counts_override: Optional[Dict[str, int]] = None,
) -> ReviewOut:
    all_ids = _normalize_ids(doc)
    text, used_ids = _select_scope(doc, section, chunk_ids)
    if keywords:
        kws = keywords
    else:
        full_text = " ".join([c.text for c in doc.chunks])
        try:
            raw_keywords = _ask_gpt_json(
                _prompt_keywords(full_text),
                model=model, temperature=0.2, max_tokens=200
            )
            kws = raw_keywords.get("keywords", [])
        except Exception as e:
            print(f"키워드 추출 실패: {e}. 기본 키워드를 사용합니다.")
            kws = ["핵심 개념", "정의", "관계", "예시", "의의"]

    rnd = random.Random(seed)
    counts = counts_override or {
        "ox": rnd.randint(3, 5),
        "short": rnd.randint(3, 6),
        "discussion": rnd.randint(2, 3),
    }

    raw = _ask_gpt_json(
        _prompt_review(text, kws, counts),
        model=model, temperature=0.4, max_tokens=1200
    )

    rv = raw.get("review", {}) or {}
    def _fix_item(it: Dict[str, Any], t: str) -> Dict[str, Any]:
        it["sources"] = _fix_sources(it.get("sources", []), all_ids, used_ids[:1])
        tags = it.get("tags") or []
        if t not in tags: tags.append(t)
        it["tags"] = tags
        if t in ("OX", "단답"): it.setdefault("confused", False)
        return it

    ox = [_fix_item(it, "OX") for it in (rv.get("ox") or [])]
    short = [_fix_item(it, "단답") for it in (rv.get("short") or [])]
    discussion = [_fix_item(it, "토론") for it in (rv.get("discussion") or [])]
    
    return ReviewOut(ox=ox, short=short, discussion=discussion)
