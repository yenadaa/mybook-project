# quiz_generator.py (팀원 기능 병합 완료)

from __future__ import annotations
import os
from typing import List, Dict, Any, Optional, Tuple
from pydantic import BaseModel
import random
import textwrap

# ⭐️ [추가] 관계형 서술형 모듈에 필요한 라이브러리
import re
import json # _ask_gpt_json 외에도 직접 사용
import hashlib
import itertools
import collections
import math

# ----------------- OpenAI 클라이언트 및 유틸리티 -----------------
def _get_client() -> "OpenAI":
    # ✅ [유지] OpenAI 라이브러리를 이 함수가 호출될 때만 로드합니다.
    from openai import OpenAI
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
    # ✅ [유지] json 관련 라이브러리도 필요할 때만 로드합니다.
    from json.decoder import JSONDecodeError

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
            print(f"JSON 디코딩 오류 발생: {e}. 유효하지 않은 JSON 응답입니다: {text}")
            return {}
    except Exception as e1:
        print(f"API 호출 중 오류 발생: {e1}")
        return {}

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

def generate_embeddings(texts: List[str]):
    # ✅ [유지] 무거운 ML 라이브러리들을 함수 내부에서 로드합니다.
    try:
        from sentence_transformers import SentenceTransformer
        import numpy as np
    except ImportError:
        raise RuntimeError("sentence-transformers 또는 numpy 라이브러리가 설치되지 않았습니다.")
    
    model = SentenceTransformer('paraphrase-multilingual-MiniLM-L12-v2')
    embeddings = model.encode(texts, convert_to_numpy=True)
    return embeddings


# ----------------- 데이터 모델 (main.py와 호환되는 '내 파일' 버전 유지) -----------------
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

# ----------------- 프롬프트 템플릿 (main.py와 호환되는 '내 파일' 버전 유지) -----------------
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
        "ox":       [ {{"q":"...","answer":true,"why":"...","sources":["c1"],"tags":["OX"],"confused":false}} ],
        "short":    [ {{"q":"...","answer":"...","sources":["c2"],"tags":["단답"],"confused":false}} ],
        "discussion": [ {{"q":"...","hint":"...","sources":["c3"],"tags":["토론"]}} ]
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


# === ⭐️ [추가] '팀원 파일'의 관계형 서술형 생성 모듈 (전체) ===

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
    # [수정] 후방 탐색 오류를 피하기 위해 간단한 문장 분리 패턴 사용
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
    dedup: bool = True
) -> Tuple[List[Dict[str,Any]], List[Dict[str,Any]]]:
    """
    반환:
      concepts = [{"id":"u1","label":"...","aliases":[...]}...]
      sentences = [{"sid":1,"chunkId":"c1","text":"...","concepts":["u1","u3"]}...]
    """
    concepts, seen = [], set()
    for i, raw in enumerate(concepts_user or []):
        lab = (raw or "").strip()
        if not lab: continue
        key = _norm_concept(lab)
        if key in seen: continue
        seen.add(key)
        concepts.append({"id": f"u{i+1}", "label": lab, "aliases": [lab, key]})

    sentences, seen_hash, sid = [], set(), 1
    for ch in (target_chunks or []):
        chunk_id = ch.id or "c0"
        text = ch.text or ""
        for s in _sent_split(text):
            h = _shingle_hash(s, 3)
            if dedup and h in seen_hash:
                continue
            seen_hash.add(h)
            hits = []
            s_low = s.lower()
            for c in concepts:
                for alias in c["aliases"]:
                    a = (alias or "").lower().strip()
                    if a and a in s_low:
                        hits.append(c["id"]); break
            sentences.append({"sid": sid, "chunkId": chunk_id, "text": s, "concepts": sorted(set(hits))})
            sid += 1
    return concepts, sentences

def _topic_groups(concepts: List[Dict[str,Any]], sentences: List[Dict[str,Any]], K: int = 8, top_m:int = 5) -> List[Dict[str,Any]]:
    """
    LDA -> 토픽 그룹. sklearn 없으면 co-occurrence 폴백.
    """
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
        # ✅ [추가] 무거운 라이브러리 여기서 로드
        from sklearn.decomposition import LatentDirichletAllocation
        import numpy as np
        
        X_arr = np.array(X)
        K_eff = max(2, min(K, min(len(X_arr), len(concepts))))
        lda = LatentDirichletAllocation(n_components=K_eff, random_state=42, learning_method="batch")
        doc_topic = lda.fit_transform(X_arr)    # D x K
        topic_word = lda.components_            # K x V
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
            groups.append({"tid": f"t{k+1}", "concept_ids": cids, "weights": weights, "top_sent_ids": top_sids})
        return groups
    except Exception:
        # 폴백: co-occurrence 기반
        co = collections.defaultdict(lambda: collections.Counter())
        for s in sentences:
            for a,b in itertools.combinations(sorted(s["concepts"]), 2):
                co[a][b]+=1; co[b][a]+=1
        all_cids = set(cid2idx.keys()); used=set(); out=[]; k=1
        while all_cids - used:
            root = max(list(all_cids - used), key=lambda x: sum(co[x].values()))
            nbrs = [cid for cid,_cnt in co[root].most_common(top_m-1)]
            cids = [root] + [c for c in nbrs if c not in used][:top_m-1]
            w = [1.0] + [0.9**i for i in range(len(cids)-1)]
            sw=sum(w); w=[x/sw for x in w]
            sscores=[]
            for s in sentences:
                sscores.append((s["sid"], sum(1 for cid in set(cids) if cid in s["concepts"])))
            s_sorted = sorted(sscores, key=lambda x: x[1], reverse=True)
            top_sids = [sid for sid,score in s_sorted[:top_m] if score>0]
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
            raw = _ask_gpt_json(prompt, model=model, temperature=0.2, max_tokens=1400)
            cands = raw.get("hyperedges") or raw.get("edges") or []
        except Exception:
            raw = _ask_gpt_json(prompt, model=model, temperature=0.1, max_tokens=1200)
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
    # 중복 통합
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
- 개념 묶음이 자연스럽게 상위 주제/핵심 개념을 설명하도록 물어보세요.
- 외부지식 금지. 입력의 개념/문장 근거만 사용.
- 각 문항에는 모범답안을 제외하고, 간단 루브릭(3~5개, 가중치 합 1.0)만 포함.
[출력(JSON)]
{"questions":[
  {
    "q": "불교에서 말하는 무아와 무상을 바탕으로 연기를 설명하시오.",
    "hid": "h3",
    "concept_ids": ["u1","u2","u5"],
    "relation_label_free": "...",
    "relation_type_norm": ["전제/조건","정의/동일시"],
    "source_sent_ids": [12,13],
    "rubric": [
      {"key":"핵심개념 이해","weight":0.3},
      {"key":"관계 설명","weight":0.4},
      {"key":"근거 인용","weight":0.3}
    ],
    "facets": { "scope":"...", "mechanism":"...", "conditions":["..."], "exceptions":["..."], "purpose":"...", "granularity":"..." }
  }
]}
[입력(JSON)]
""".strip() + "\n" + json.dumps({"hyperedges": input_json}, ensure_ascii=False))

def _generate_relation_questions(hyperedges: List[Dict[str,Any]], concepts: List[Dict[str,Any]], desired_n:int, model="gpt-4o-mini") -> List[Dict[str,Any]]:
    if not hyperedges: return []
    subset = hyperedges[: min(len(hyperedges), max(6, desired_n*3))]
    raw = _ask_gpt_json(_prompt_questions_from_hyperedges(subset, concepts), model=model, temperature=0.3, max_tokens=1400)
    qs = raw.get("questions", []) or []
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
        out.append({
            "type":"discussion",
            "q": q["q"].strip(),
            "concept_ids": cids,
            "relation_label_free": (q.get("relation_label_free") or "").strip(),
            "relation_type_norm": q.get("relation_type_norm") or [],
            "rubric": _renorm(q.get("rubric") or [{"key":"핵심개념 이해","weight":0.34},{"key":"관계 설명","weight":0.33},{"key":"근거 인용","weight":0.33}]),
            "facets": q.get("facets") or {},
            "source_sent_ids": src
        })
    return out[:desired_n]

def _assemble_relation_payload(book_id: str, discussion_items: List[Dict[str,Any]], sentences: List[Dict[str,Any]]) -> Dict[str,Any]:
    sid2s = {s["sid"]: s for s in sentences}
    for it in discussion_items:
        src_pairs=[]
        for sid in it.get("source_sent_ids", [])[:3]:
            s = sid2s.get(int(sid))
            if s: src_pairs.append({"chunkId": s["chunkId"], "sentId": s["sid"]})
        it["sources"] = src_pairs
        it["tags"] = ["highlight-based","relation"]
        it.pop("source_sent_ids", None)
    return {"status":"ok","review":{"ox":[],"short":[],"discussion":discussion_items},"meta":{"bookId": book_id, "model":"gpt-4o-mini"}}

def _calculate_topic_discussion_count(N_concept: int) -> int:
    """
    토픽 내 개념 개수에 비례하여 문제 개수를 로그 함수 기반으로 동적 결정합니다.
    (N_concept=5일 때 3개, 최대 상한 8개)
    """
    A = 1.75  # 기울기
    B = 0.5   # 최소 시작점
    MAX_COUNT = 8 # 최대 상한선
    
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
        
        # 1. 토픽별 목표 문제 개수 계산 (신규 로직)
        topic_desired_n = _calculate_topic_discussion_count(topic_concept_count)
        
        # 2. 토픽 전용 하이퍼엣지 생성
        single_topic_list = [topic] 
        hyperedges = _build_hyperedges_for_topics(single_topic_list, concepts, sentences, model="gpt-4o-mini")
        
        if not hyperedges: 
            print(f"[DEBUG] Topic {topic['tid']} (Concepts: {topic_concept_count}) generated no hyperedges.")
            continue
            
        # 3. 토픽별 문제 생성
        discussion_items = _generate_relation_questions(
            hyperedges, 
            concepts, 
            desired_n=topic_desired_n, # 토픽별 동적 개수 적용
            model="gpt-4o-mini"
        )
        
        if discussion_items:
            print(f"[DEBUG] Topic {topic['tid']} successfully generated {len(discussion_items)} questions (Target: {topic_desired_n}).")
            all_discussion_items.extend(discussion_items)
        else:
            print(f"[DEBUG] Topic {topic['tid']} generated no questions.")

    if not all_discussion_items: return {"status":"no-questions"}
    
    # 4. 전체 문제 수가 너무 많으면 상위 N개로 자름 (상한선)
    max_limit = desired_discussion_n if desired_discussion_n > 0 else 10
    
    final_discussions = sorted(all_discussion_items, key=lambda x: x.get('score', 1.0), reverse=True)
    final_discussions = final_discussions[:max_limit]

    return _assemble_relation_payload(book_id, final_discussions, sentences)

def _fallback_relation_discussion_from_chunks(
    book_id: str,
    user_concepts: List[str],
    target_chunks: List[Chunk],
    desired_discussion_n:int = 3
) -> Dict[str, Any]:
    # 1) 개념 후보 만들기
    texts = " ".join([(c.text or "") for c in target_chunks])
    toks = re.findall(r"[A-Za-z가-힣]{2,}", texts)
    base_concepts = [w.lower() for w,_ in collections.Counter(toks).most_common(20)]
    if user_concepts:
        uc = [u.lower() for u in user_concepts]
        base_concepts = list(dict.fromkeys(uc + base_concepts))

    # 2) 2~3개 개념 묶기
    def combos(items, k):
        return list(itertools.combinations(items, k))

    pairs = combos(base_concepts[:12], 2)
    trips = combos(base_concepts[:12], 3)
    cand_groups = []
    for a,b in pairs[:desired_discussion_n*2]:
        cand_groups.append([a,b])
    for a,b,c in trips[:desired_discussion_n*2]:
        cand_groups.append([a,b,c])

    # 3) 문장 근거 간단 추출
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

    # 4) 문제 작성
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
    # 매우 간단한 폴백
    texts = " ".join([c.text or "" for c in chunks])
    toks = re.findall(r"[A-Za-z가-힣]{%d,}"%min_len, texts)
    counter = collections.Counter([t.lower() for t in toks])
    cands = [w for w,_ in counter.most_common(top_k)]
    return cands

# === (끝) '팀원 파일'의 관계형 서술형 생성 모듈 ===


# ----------------- 실행 함수: 기본 모듈과 맞춤형 모듈 -----------------
def generate_summaries(
    doc: PreprocessedDoc,
    section: Optional[str] = None,
    chunk_ids: Optional[List[str]] = None,
    model: str = "gpt-4.1-mini",
) -> SummaryOut:
    # ✅ [유지] '내 파일'의 요약 함수 (main.py가 이 버전을 사용)
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
    # ✅ [유지] '내 파일'의 전체 문서 퀴즈 함수 (main.py가 이 버전을 사용)
    print(f"generate_base_review 함수 시작: {len(doc.chunks)}개 페이지 데이터 받음")

    _normalize_ids(doc)

    sample_text = ""
    char_limit = 3000
    for c in doc.chunks:
        if len(sample_text) + len(c.text) > char_limit:
            break
        sample_text += c.text + " "

    if not sample_text.strip() and doc.chunks:
        sample_text = doc.chunks[0].text

    try:
        raw_keywords = _ask_gpt_json(
            _prompt_keywords(sample_text.strip()),
            model=model, temperature=0.2, max_tokens=200
        )
        keywords = raw_keywords.get("keywords", [])
        if not keywords:
            raise Exception("Keywords not found")
    except Exception as e:
        print(f"키워드 추출 실패: {e}. 기본 키워드를 사용합니다.")
        keywords = ["핵심 개념", "정의", "관계", "예시", "의의"]

    summaries_list = []
    review_output = ReviewOut(ox=[], short=[], discussion=[])

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
    

# ⭐️ [교체] '팀원 파일'의 generate_custom_review 함수 (고급 서술형 포함)
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
    선택된 청크 각각에 대해 OX/단답은 기존 로직으로,
    서술형은 '개념-관계형(지시어 없는 문구)'으로 교체 생성합니다.
    """
    all_ids = _normalize_ids(doc)

    # 1) 대상 청크
    if section:
        target_chunks = [c for c in doc.chunks if section in " / ".join(c.section_path or [])]
    elif chunk_ids:
        id_set = set(chunk_ids)
        target_chunks = [c for c in doc.chunks if c.id in id_set]
    else:
        print("[DEBUG] generate_custom_review: 대상 청크(chunk_ids)가 없어 빈 결과 반환")
        return ReviewOut(ox=[], short=[], discussion=[])
    
    print(f"[DEBUG] generate_custom_review: 총 {len(target_chunks)}개의 청크(하이라이트) 처리 시작")

    # 2) 키워드(기존) — OX/단답 프롬프트용
    if keywords:
        kws = keywords
    else:
        selected_text = "\n\n".join([c.text for c in target_chunks])
        try:
            print(f"[DEBUG] generate_custom_review: AI 호출 (키워드 추출) 시작... (텍스트 크기: {len(selected_text)})")
            raw_keywords = _ask_gpt_json(_prompt_keywords(selected_text), model=model, temperature=0.2, max_tokens=200)
            kws = raw_keywords.get("keywords", [])
            print("[DEBUG] generate_custom_review: AI 호출 (키워드 추출) 성공")
        except Exception:
            print("[DEBUG] 키워드 추출 실패. 기본 키워드를 사용합니다.")
            kws = ["핵심 개념", "정의", "관계", "예시", "의의"]

    # 3) 개수
    counts_base = counts_override or {"ox":3, "short":3, "discussion":3}
    
    # OX/단답 프롬프트에 discussion=0을 전달하여 불필요한 기본 서술형 문제 생성을 방지함.
    counts_qa = counts_base.copy()
    counts_qa["discussion"] = 0 

    # 4) OX/단답: 기존 로직 (청크별로 _prompt_review 호출)
    final_review_output = ReviewOut(ox=[], short=[], discussion=[])
    for chunk in target_chunks:
        try:
            text = chunk.text or ""
            if not text.strip(): 
                continue
            
            print(f"-> 청크 {chunk.id}에 대해 OX/단답 문제 생성 중...")
            raw = _ask_gpt_json(_prompt_review(text, kws, counts_qa), model=model, temperature=0.4, max_tokens=2000)
            rv = raw.get("review", {}) or {}
            
            def _fix_item(it: Dict[str, Any], t: str) -> Dict[str, Any]:
                it = dict(it)
                it["tags"] = list(dict.fromkeys((it.get("tags") or []) + [t]))
                it["sources"] = [chunk.id] # 소스를 현재 청크 ID로 강제
                return it
            
            final_review_output.ox.extend([_fix_item(it, "OX") for it in (rv.get("ox") or [])])
            final_review_output.short.extend([_fix_item(it, "단답") for it in (rv.get("short") or [])])
        except Exception:
            continue

    # 5) 서술형: 관계형으로 교체 생성
    try:
        user_concepts = list(kws) # 위에서 추출한 키워드를 사용
        
        # desired_n: 사용자가 0보다 큰 값을 주면 그 값을 상한선으로 사용
        # 0 또는 None이면, generate_relation_discussion_from_chunks 내부에서 동적 계산
        desired_n = int(counts_base.get("discussion", 0)) # 기본값을 0으로 설정
        
        print(f"[DEBUG] 관계형 서술형 문제 생성 시작 (Target N: {desired_n}, 0이면 동적 계산)")
        
        # 5-1) 1차: 관계형 생성기 (GPT 기반)
        rel_payload = generate_relation_discussion_from_chunks(
            book_id=doc.doc_id or "doc",
            user_concepts=user_concepts,
            target_chunks=target_chunks,
            desired_discussion_n=desired_n,
            lda_K=8
        )
        status = rel_payload.get("status")
        ok = status == "ok" and rel_payload.get("review", {}).get("discussion")

        if not ok:
            print(f"[DEBUG] Main relation generation failed with status: {status}. Attempting local fallback.")

        # 5-2) 실패/빈 결과면 폴백(로컬) 사용
        if not ok:
            rel_payload = _fallback_relation_discussion_from_chunks(
                book_id=doc.doc_id or "doc",
                user_concepts=user_concepts,
                target_chunks=target_chunks,
                desired_discussion_n=desired_n if desired_n > 0 else 3 # 폴백은 동적계산이 없으므로 기본 3개
            )
            ok = rel_payload.get("status") == "ok" and rel_payload.get("review", {}).get("discussion")

        if ok:
            final_review_output.discussion = rel_payload["review"]["discussion"]
            print(f"[DEBUG] 관계형 서술형 문제 {len(final_review_output.discussion)}개 생성 완료")
        else:
            print("[DEBUG] Local fallback also failed to generate discussion questions.")

    except Exception as e:
        print(f"[ERROR] 관계형 서술형 생성 중 치명적 오류 발생: {e}")
        # 최종 폴백: 완전 에러 시에도 최소 1문항 보장
        try:
            rel_payload = _fallback_relation_discussion_from_chunks(
                book_id=doc.doc_id or "doc",
                user_concepts=[],
                target_chunks=target_chunks,
                desired_discussion_n=max(1, int(counts_base.get("discussion", 1)))
            )
            if rel_payload.get("status") == "ok":
                final_review_output.discussion = rel_payload["review"]["discussion"]
        except Exception:
            print("[ERROR] 최종 폴백 서술형 문제 생성도 실패했습니다.")
            pass

    print(f"--- generate_custom_review 함수 정상 종료 (OX: {len(final_review_output.ox)}, Short: {len(final_review_output.short)}, Disc: {len(final_review_output.discussion)}) ---")
    return final_review_output