# main.py
#
# ⭐️ [최종 지연 로딩 버전]
# - 배포 타임아웃(10초)을 피하기 위해, 모든 '무거운' import를 각 함수 "안"으로 옮깁니다.
# - '파이프라인'과 '빠른 퀴즈' 기능이 모두 포함되어 있습니다.
#

import firebase_admin
from firebase_admin import firestore, initialize_app, messaging, storage
from firebase_functions import https_fn, options, scheduler_fn, storage_fn

# ⭐️ [수정] 가벼운 표준 라이브러리만 남겨둡니다.
import os
import json
import traceback
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Dict, Any 

# ---------------------------------------------
# --- 1. Firebase 앱 및 클라이언트 초기화 ---
# ---------------------------------------------
initialize_app()

db = None
storage_client = None
vision_client = None
openai_client = None
tasks_client = None 

options.set_global_options(
    region="asia-northeast3",
    memory=options.MemoryOption.GB_1, 
    timeout_sec=540,
    secrets=["OPENAI_API_KEY"]
)

CORS_OPTIONS = options.CorsOptions(
    cors_origins=[
        "https://mybook-d143d.web.app",
        "http://localhost:5000",
        "http://127.0.0.1:5000"
    ]
)

# ---------------------------------------------
# --- 2. ⭐️ [수정] 단일 처리 파이프라인 (artifacts 감시) ---
# ---------------------------------------------
@storage_fn.on_object_finalized(
    timeout_sec=540,
    memory=options.MemoryOption.GB_2 
)
def on_pdf_upload(event: storage_fn.CloudEvent[storage_fn.StorageObjectData]):
    """
    [⭐️ 최종 파이프라인]
    """
    # ⭐️ [지연 로딩]
    from quiz_generator import (
        PreprocessedDoc, Chunk, Output, ReviewOut, SummaryOut,
        pdf_to_preprocessed_doc, generate_base_review, 
        generate_custom_review, get_openai_embeddings
    )

    global storage_client, db
    if db is None: db = firestore.client()
    if storage_client is None: storage_client = storage.bucket()

    file_path = event.data.name
    
    # 1. 'artifacts/' 경로 감시
    if not file_path or not file_path.startswith("artifacts/") or not file_path.lower().endswith(".pdf"):
        print(f"Ignoring file (Not in 'artifacts/' or not PDF): {file_path}")
        return

    # 2. 'artifacts/' 경로에서 user_id와 book_id 추출
    try:
        parts = file_path.split("/")
        user_id = parts[3]
        book_id = parts[5].replace(".pdf", "")
    except IndexError:
        print(f"Invalid path structure: {file_path}")
        return

    print(f"--- 🚀 '단일 처리 파이프라인' 시작 (Book ID: {book_id}) ---")
    
    doc_ref = db.collection("books").document(book_id)
    doc_ref.set({
        "status": "processing",
        "owner_uid": user_id,
        "createdAt": firestore.SERVER_TIMESTAMP
    }, merge=True)

    # 3. PDF 다운로드
    try:
        blob = storage_client.blob(file_path)
        pdf_bytes = blob.download_as_bytes()
        print(f"--- 📥 Checkpoint 1: PDF 다운로드 성공 ---")
    except Exception as e:
        print(f"Error downloading PDF: {e}")
        doc_ref.set({"status": f"error_download: {e}"}, merge=True)
        return

    # 4. 텍스트 청크 생성 (1단계)
    try:
        processed_doc: "PreprocessedDoc" = pdf_to_preprocessed_doc(
            pdf_bytes=pdf_bytes,
            doc_id=book_id
        )
        if not processed_doc.chunks:
             raise ValueError('PDF에서 텍스트를 추출할 수 없습니다.')
        print(f"--- ✅ Checkpoint 2: 텍스트 추출/처리 성공 ({len(processed_doc.chunks)}개 청크) ---")
    except Exception as e:
        print(f"Error in pdf_to_preprocessed_doc: {e}")
        doc_ref.set({"status": f"error_processing: {e}"}, merge=True)
        return

    # 5. [요리 1] '전체 요약/퀴즈' 미리 생성
    try:
        base_review_output: "Output" = generate_base_review(
            processed_doc, 
            model="gpt-4o-mini"
        )
        print(f"--- ✅ Checkpoint 3: '전체 요약' 생성 성공 ---")
    except Exception as e:
        print(f"Error in generate_base_review: {e}")
        doc_ref.set({"status": f"error_base_review: {e}"}, merge=True)
        return

    # 6. [요리 2] '하이라이트(루브릭)' 퀴즈 미리 생성
    try:
        all_chunk_ids = [c.id for c in processed_doc.chunks if c.id]
        custom_review_output: "ReviewOut" = generate_custom_review(
            doc=processed_doc,
            chunk_ids=all_chunk_ids,
            keywords=None,
            counts_override={"ox": 0, "short": 0, "discussion": 10},
            model="gpt-4o-mini"
        )
        print(f"--- ✅ Checkpoint 4: '하이라이트(루브릭)' 퀴즈 생성 성공 ---")
    except Exception as e:
        print(f"Error in generate_custom_review: {e}")
        doc_ref.set({"status": f"error_custom_review: {e}"}, merge=True)
        return

    # 7. [챗봇] 챗봇용 벡터 생성
    try:
        print(f"--- 🤖 Checkpoint 5: OpenAI 임베딩 API 호출 시작 ---")
        texts_to_embed = [chunk.text for chunk in processed_doc.chunks]
        embeddings: List[List[float]] = get_openai_embeddings(texts_to_embed)
        
        if not embeddings or len(embeddings) != len(processed_doc.chunks):
            raise Exception("임베딩 결과가 청크 개수와 일치하지 않습니다.")

        for i, chunk in enumerate(processed_doc.chunks):
            chunk.embedding = embeddings[i]
            
        print("--- ✅ Checkpoint 6: OpenAI 임베딩 생성 및 할당 완료 ---")
    except Exception as e:
        print(f"Error during embedding generation: {e}")
        doc_ref.set({"status": f"error_embedding: {e}"}, merge=True)
        return

    # 8. [⭐️ 저장] 모든 '요리'를 Firestore에 저장
    try:
        final_custom_output = Output(
            summaries=SummaryOut(summary="", sources=all_chunk_ids), 
            review=custom_review_output,
            meta={"model": "gpt-4o-mini", "doc_id": book_id}
        )
        
        doc_ref.set({
            "processedData": processed_doc.model_dump(),
            "baseReviewPayload": base_review_output.model_dump(),
            "customReviewPayload": final_custom_output.model_dump(),
            "status": "processed_all_ok",
            "lastProcessed": firestore.SERVER_TIMESTAMP,
            "owner_uid": user_id
        }, merge=True) 
        
        print(f"--- ✅ FINAL: Firestore 'books/{book_id}'에 모든 데이터 저장 완료 ---")
    except Exception as e:
        print(f"Error saving to Firestore: {e}")
        doc_ref.set({"status": f"error_saving: {e}"}, merge=True)
        return

# ---------------------------------------------
# --- 3. 헬퍼 함수 ---
# ---------------------------------------------

def _get_auth_and_book_id(req: https_fn.CallableRequest) -> tuple[str, str]:
    if req.auth is None:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.UNAUTHENTICATED, message="로그인이 필요합니다.")
    user_id = req.auth.uid
    book_id = req.data.get("bookId")
    if not book_id:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT, message="bookId가 필요합니다.")
    return user_id, book_id

def _load_processed_doc_from_firestore(book_id: str) -> "PreprocessedDoc":
    """
    [⭐️ 핵심 헬퍼] Firestore 'books' 컬렉션에서 'processedData'를 읽습니다.
    """
    from quiz_generator import PreprocessedDoc # ⭐️ 지연 로딩

    global db
    if db is None: db = firestore.client()
    if not book_id:
        raise https_fn.HttpsError(code="invalid-argument", message="bookId가 필요합니다.")
    try:
        doc_ref = db.collection("books").document(book_id)
        doc_snapshot = doc_ref.get()
        if not doc_snapshot.exists:
            raise https_fn.HttpsError(code="not-found", message=f"{book_id} 문서를 찾을 수 없습니다.")
        processed_data_dict = doc_snapshot.get("processedData")
        if not processed_data_dict:
             raise https_fn.HttpsError(code="aborted", message="PDF가 아직 처리되지 않았습니다.")
        doc_for_quiz = PreprocessedDoc(**processed_data_dict)
        return doc_for_quiz
    except Exception as e:
        print(f"Error loading processedData: {e}")
        raise https_fn.HttpsError(code="internal", message=f"처리된 데이터 로드 중 오류: {e}")

def _get_quiz_prompt(context: str) -> str:
    # (기존 코드 유지)
    return f"..." # (프롬프트 내용 생략)

def _get_next_review_date(new_review_level: int) -> datetime:
    # (기존 코드 유지)
    now = datetime.now(timezone.utc)
    if new_review_level == 1: return now + timedelta(days=1)
    elif new_review_level == 2: return now + timedelta(days=3)
    elif new_review_level == 3: return now + timedelta(days=7)
    elif new_review_level == 4: return now + timedelta(days=30)
    else: return now + timedelta(days=90)


# ---------------------------------------------
# --- 4. ⭐️ [수정] 퀴즈 생성 함수 (빠른 실전용) ---
# ---------------------------------------------

@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
    cors=CORS_OPTIONS
)
def generateFullDocQuiz(req: https_fn.CallableRequest) -> https_fn.Response:
    """
    [⭐️ 최종 실전 버전]
    - Firestore 'books' 컬렉션에서 'baseReviewPayload'를 1초 만에 읽어옵니다.
    """
    global db
    if db is None: db = firestore.client()
    
    book_id = req.data.get("bookId")
    if not book_id:
        raise https_fn.HttpsError(code="invalid-argument", message="bookId가 필요합니다.")

    try:
        doc_ref = db.collection("books").document(book_id)
        doc_snapshot = doc_ref.get()
        if not doc_snapshot.exists:
            raise https_fn.HttpsError(code="not-found", message=f"{book_id} 문서를 찾을 수 없습니다.")
        
        payload = doc_snapshot.get("baseReviewPayload") 
        if not payload:
             raise https_fn.HttpsError(code="aborted", message="PDF가 아직 처리되지 않았습니다. (요약 데이터 없음)")
        
        return payload
    
    except Exception as e:
        print(f"Error in generateFullDocQuiz (fast): {e}")
        raise https_fn.HttpsError(code="internal", message=f"퀴즈/요약 로드 중 오류 발생: {e}")


@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
    cors=CORS_OPTIONS, 
    memory=options.MemoryOption.GB_1
)
def generateCustomReview(req: https_fn.CallableRequest) -> https_fn.Response:
    """
    [⭐️ 최종 실전 버전]
    - Firestore 'books' 컬렉션에서 'customReviewPayload'를 1초 만에 읽어옵니다.
    """
    global db
    if db is None: db = firestore.client()

    book_id = req.data.get("bookId")
    if not book_id:
        raise https_fn.HttpsError(code="invalid-argument", message="bookId가 필요합니다.")

    try:
        doc_ref = db.collection("books").document(book_id)
        doc_snapshot = doc_ref.get()
        if not doc_snapshot.exists:
            raise https_fn.HttpsError(code="not-found", message=f"{book_id} 문서를 찾을 수 없습니다.")
        
        payload = doc_snapshot.get("customReviewPayload") 
        if not payload:
             raise https_fn.HttpsError(code="aborted", message="PDF가 아직 처리되지 않았습니다. (맞춤형 퀴즈 데이터 없음)")
        
        return payload
    
    except Exception as e:
        print(f"Error in generateCustomReview (fast): {e}")
        raise https_fn.HttpsError(code="internal", message=f"맞춤형 퀴즈 로드 중 오류 발생: {e}")


# ---------------------------------------------
# --- 5. ⭐️ 서술형 채점 함수 (유지) ---
# ---------------------------------------------
@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
    cors=CORS_OPTIONS
)
def scoreQuizAnswer(req: https_fn.CallableRequest) -> https_fn.Response:
    # ⭐️ [지연 로딩]
    from quiz_generator import AnswerIn, ScoreResult, score_discussion_answer

    try:
        answer_data_dict = req.data.get("answerData")
        if not answer_data_dict:
            raise https_fn.HttpsError(code="invalid-argument", message="answerData가 필요합니다.")
        answer_in_model = AnswerIn(**answer_data_dict)
        score_result: "ScoreResult" = score_discussion_answer(
            answer_data=answer_in_model,
            model="gpt-4o-mini"
        )
        return {"result": score_result.model_dump()}
    except Exception as e:
        print(f"Error in scoreQuizAnswer: {e}")
        raise https_fn.HttpsError(code="internal", message=f"채점 중 오류 발생: {e}")


# ---------------------------------------------
# --- 6. ⭐️ 챗봇(RAG) 함수 (유지) ---
# ---------------------------------------------

def _find_similar_chunks(
    query_vector: List[float], 
    chunks: List["Chunk"], 
    top_k: int = 3
) -> List["Chunk"]:
    """
    [⭐️ 신규 헬퍼] Numpy를 사용해 'In-Function' 벡터 검색을 수행합니다.
    """
    import numpy as np # ⭐️ 지연 로딩
    from quiz_generator import Chunk 
    
    if not query_vector or not chunks:
        return []
    query_vec = np.array(query_vector)
    chunk_embeddings = []
    valid_chunks = []
    
    for chunk in chunks:
        if chunk.embedding:
            chunk_embeddings.append(chunk.embedding)
            valid_chunks.append(chunk)
    if not chunk_embeddings:
        print("Warning: Firestore에 유효한 임베딩이 없습니다.")
        return []

    chunk_matrix = np.array(chunk_embeddings)
    dot_products = np.dot(chunk_matrix, query_vec)
    chunk_norms = np.linalg.norm(chunk_matrix, axis=1)
    query_norm = np.linalg.norm(query_vec)
    norm_product = chunk_norms * query_norm
    similarities = dot_products / (norm_product + 1e-9)
    top_k_indices = np.argsort(similarities)[-top_k:][::-1]
    
    return [valid_chunks[i] for i in top_k_indices]


@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
    cors=CORS_OPTIONS,
    memory=1024
)
def chatWithBook(req: https_fn.Request) -> https_fn.Response:
    """
    [⭐️ 신규 챗봇 함수 (RAG)]
    """
    # ⭐️ [지연 로딩]
    from quiz_generator import get_openai_embeddings, _get_client
    
    book_id = req.data.get("bookId")
    query = req.data.get("query")
    if not query:
        raise https_fn.HttpsError(code="invalid-argument", message="query가 필요합니다.")
    
    doc_for_chat = _load_processed_doc_from_firestore(book_id)

    try:
        query_embedding = get_openai_embeddings([query])
        if not query_embedding or not query_embedding[0]:
            raise Exception("사용자 질문을 임베딩하는 데 실패했습니다.")
        query_vector = query_embedding[0]
    except Exception as e:
        print(f"Error embedding query: {e}")
        raise https_fn.HttpsError(code="internal", message="질문 처리 중 오류 발생")

    similar_chunks = _find_similar_chunks(
        query_vector, 
        doc_for_chat.chunks,
        top_k=3
    )
    if not similar_chunks:
        context_text = "참고할 만한 컨텍스트를 찾지 못했습니다."
    else:
        context_text = "\n\n---\n\n".join([chunk.text for chunk in similar_chunks])

    try:
        client = _get_client()
        system_prompt = (
            "당신은 주어진 '참고 컨텍스트'를 기반으로 사용자의 질문에 답변하는 AI 챗봇입니다. "
            "컨텍스트에 내용이 없으면 '책 내용만으로는 알 수 없습니다'라고 답변하세요."
        )
        user_prompt = f"""
        [참고 컨텍스트]
        {context_text}
        ---
        [사용자 질문]
        {query}
        """
        rsp = client.chat.completions.create(
            model="gpt-4o-mini",
            temperature=0.1,
            max_tokens=1000,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        )
        answer = rsp.choices[0].message.content
        return {
            "answer": answer,
            "sources": [chunk.model_dump() for chunk in similar_chunks]
        }
    except Exception as e:
        print(f"Error during final GPT call: {e}")
        raise https_fn.HttpsError(code="internal", message="답변 생성 중 오류 발생")


# ---------------------------------------------
# --- 7. (유지) 기존 기타 함수들 (OCR, 퀴즈 저장, 알림) ---
# ---------------------------------------------

# 7-1. (유지) 하이라이트 기반 [간단] 퀴즈
@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
    cors=CORS_OPTIONS
)
def generateQuiz(req: https_fn.CallableRequest) -> https_fn.Response:
    import openai # ⭐️ 지연 로딩
    global db, openai_client
    if db is None: db = firestore.client()
    if openai_client is None: openai_client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    user_id, book_id = _get_auth_and_book_id(req)
    docs = db.collection('highlights').where('userId', '==', user_id).where('bookId', '==', book_id).stream()
    texts = [doc.to_dict().get('text', '') for doc in docs if doc.to_dict().get('text')]
    if not texts:
        return {"quiz": []}
    context = "\n".join(texts)
    prompt = _get_quiz_prompt(context)
    try:
        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "You are a helpful assistant that generates quizzes in JSON format."},
                {"role": "user", "content": prompt}
            ],
            response_format={"type": "json_object"}
        )
        quiz_data = response.choices[0].message.content
        return json.loads(quiz_data)
    except Exception as e:
        print(f"GPT API 호출 오류: {e}")
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INTERNAL, message="퀴즈 생성 중 오류가 발생했습니다.")


# 7-2. (유지) 이미지 영역 OCR (OpenAI Vision)
@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
    cors=CORS_OPTIONS
)
def runOcrOnSelection(req: https_fn.CallableRequest) -> https_fn.Response:
    import openai # ⭐️ 지연 로딩
    global openai_client
    if openai_client is None:
        try:
            openai_client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        except Exception as e:
            print(f"OpenAI 클라이언트 초기화 오류: {e}")
            raise https_fn.HttpsError(code='internal', message='OpenAI 클라이언트 초기화 실패')
    if req.auth is None:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.UNAUTHENTICATED, message="로그인이 필요합니다.")
    base64_image = req.data.get("imageData")
    if not base64_image:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT, message="이미지 데이터가 필요합니다.")
    try:
        image_url = f"data:image/png;base64,{base64_image}"
        prompt_text = "당신은 이미지 속의 표, 차트, 그래프를 분석하여 퀴즈를 만들 수 있도록 핵심 내용을 '줄글(prose)'로 요약하는 AI입니다. ... 5. 만약 단순 텍스트라면, 그 텍스트만 반환합니다."
        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": [{"type": "text", "text": prompt_text}, {"type": "image_url", "image_url": {"url": image_url}}] }],
            max_tokens=500
        )
        detected_text = response.choices[0].message.content
        print(f"OpenAI Vision API 결과 (줄글 요약): {detected_text}")
        return {"text": detected_text}
    except Exception as e:
        print(f"OpenAI Vision API 오류: {traceback.format_exc()}")
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INTERNAL, message=f"AI 비전 처리 중 서버 오류 발생: {str(e)}")


# 7-3. (유지) 퀴즈 저장 (중복 검사)
@https_fn.on_call(cors=CORS_OPTIONS)
def saveQuizItems(req: https_fn.CallableRequest) -> https_fn.Response:
    # ⭐️ [지연 로딩]
    from hashlib import sha256
    from utils_similarity import normalize_q, char_ngrams, simhash64, simhash_bands, hamming

    global db
    if db is None: db = firestore.client()
    if req.auth is None: raise https_fn.HttpsError(code="unauthenticated", message="로그인이 필요합니다.")
    uid = req.auth.uid
    book_id = req.data.get("bookId")
    scope = (req.data.get("scope") or "full").strip()
    items = req.data.get("items") or []
    if not book_id or not isinstance(items, list):
        raise https_fn.HttpsError(code="invalid-argument", message="bookId와 items가 필요합니다.")
    col = db.collection("quizItems")
    saved, skipped = [], []
    for raw in items:
        q = (raw.get("q") or raw.get("question") or "").strip()
        if not q:
            skipped.append({"q": "", "reason": "NO_QUESTION"})
            continue
        q_norm = normalize_q(q)
        tokens = char_ngrams(q_norm, n=3)
        sig64 = simhash64(tokens)
        bands = simhash_bands(sig64)
        candidates = {}
        for b in bands:
            qry = (
                col.where("userId", "==", uid)
                   .where("bookId", "==", book_id)
                   .where("scope", "==", scope)
                   .where("bands", "array_contains", b)
                   .limit(50)
            )
            for doc in qry.stream():
                if doc.id not in candidates:
                    candidates[doc.id] = doc.to_dict()
        is_dup = False
        dup_id = None
        for cid, c in candidates.items():
            try: c_sig = int(c.get("sim64", "0"))
            except Exception: continue
            if hamming(sig64, c_sig) <= 6:
                is_dup = True
                dup_id = cid
                break
        if is_dup:
            skipped.append({"q": q, "reason": "DUPLICATE", "existingId": dup_id})
            continue
        qhash = sha256(q_norm.encode("utf-8")).hexdigest()[:10]
        doc_id = f"{uid}_{book_id}_{scope}_{qhash}"
        ref = col.document(doc_id)
        existed = ref.get().exists
        payload = {
            "userId": uid, "bookId": book_id, "scope": scope,
            "type": raw.get("type") or "unknown",
            "q": q, "q_norm": q_norm,
            "answer": raw.get("answer"),
            "sources": raw.get("sources") or [],
            "tags": raw.get("tags") or [], 
            "sim64": str(sig64), "bands": bands,
            "updatedAt": firestore.SERVER_TIMESTAMP,
            "reviewLevel": 0, 
            "nextReviewDate": firestore.SERVER_TIMESTAMP 
        }
        if not existed:
            payload["createdAt"] = firestore.SERVER_TIMESTAMP
        ref.set(payload, merge=True)
        saved.append(doc_id)
    return {"saved": saved, "skipped": skipped}


# 7-4. (유지) 복습 알림 (지휘자 / 일꾼 분리)
PROJECT_ID = "mybook-d143d" 
QUEUE_LOCATION = "asia-northeast3" 
QUEUE_ID = "quiz-generation-queue"
GENERATE_SESSION_URL = f"https://{QUEUE_LOCATION}-{PROJECT_ID}.cloudfunctions.net/generateUserReviewSession" 

@scheduler_fn.on_schedule(schedule="every day 09:00", timezone="Asia/Seoul")
def sendReviewNotifications(event: scheduler_fn.ScheduledEvent) -> None:
    from google.cloud import tasks_v2 # ⭐️ 지연 로딩
    global db, tasks_client
    if db is None: db = firestore.client()
    if tasks_client is None: tasks_client = tasks_v2.CloudTasksClient()
    print("매일 복습 알림 '지휘자' 함수 실행 시작.")
    now = datetime.now(timezone.utc)
    users_to_notify = set()
    wrong_quiz_query = (
        db.collection('quizItems')
          .where('nextReviewDate', '<=', now)
          .where('reviewLevel', '<', 4) 
    )
    for doc in wrong_quiz_query.stream():
        users_to_notify.add(doc.to_dict().get('userId'))
    if not users_to_notify:
        print("알림을 보낼 사용자가 없습니다.")
        return
    print(f"총 {len(users_to_notify)} 명의 사용자에 대한 복습 작업 생성 시작...")
    queue_path = tasks_client.queue_path(PROJECT_ID, QUEUE_LOCATION, QUEUE_ID)
    SERVICE_ACCOUNT_EMAIL = f"firebase-adminsdk-fbsvc@{PROJECT_ID}.iam.gserviceaccount.com"
    for user_id in users_to_notify:
        if not user_id: continue
        try:
            payload = {"userId": user_id}
            task = {
                "http_request": {
                    "http_method": tasks_v2.HttpMethod.POST,
                    "url": GENERATE_SESSION_URL, 
                    "headers": {"Content-Type": "application/json"},
                    "body": json.dumps(payload).encode(),
                    "oidc_token": {
                        "service_account_email": SERVICE_ACCOUNT_EMAIL
                    },
                },
                "dispatch_deadline": timedelta(minutes=15)
            }
            tasks_client.create_task(parent=queue_path, task=task)
            print(f"'{user_id}' 사용자를 위한 복습 작업을 큐에 추가했습니다.")
        except Exception as e:
            print(f"'{user_id}' 사용자 작업 생성 중 오류: {e}")
    print("모든 복습 작업 할당 완료.")

@https_fn.on_request(
    region="asia-northeast3",
    memory=options.MemoryOption.GB_2,
    timeout_sec=1800,
    secrets=["OPENAI_API_KEY"],
    invoker="private" 
)
def generateUserReviewSession(req: https_fn.Request) -> https_fn.Response:
    import openai # ⭐️ 지연 로딩
    global db, openai_client, storage_client
    if db is None: db = firestore.client()
    if openai_client is None: openai_client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    if storage_client is None: storage_client = storage.bucket()
    user_id = None
    try:
        payload = req.get_json(silent=True)
        user_id = payload.get("userId")
        if not user_id:
            print("오류: userId가 없습니다.")
            return https_fn.Response("Bad Request", status=400)
        print(f"'{user_id}' 사용자의 복습 퀴즈 세션 생성을 시작합니다.")
        now = datetime.now(timezone.utc)
        wrong_quiz_query = db.collection('quizItems').where('userId', '==', user_id).where('reviewLevel', '<', 4)
        wrong_items_docs = list(wrong_quiz_query.stream())
        if not wrong_items_docs:
            print(f"'{user_id}' 사용자는 복습할 항목이 없습니다.")
            return https_fn.Response("No items to review", status=200)
        final_quiz_items = [doc.to_dict() for doc in wrong_items_docs] 
        session_ref = db.collection("reviewSessions").document()
        session_ref.set({
            "userId": user_id,
            "createdAt": firestore.SERVER_TIMESTAMP,
            "items": final_quiz_items
        })
        new_session_id = session_ref.id
        print(f"'{user_id}' 사용자의 퀴즈 세션 '{new_session_id}' 저장 완료.")
        try:
            user_doc = db.collection('users').document(user_id).get()
            fcm_token = None
            if user_doc.exists:
                fcm_token = user_doc.to_dict().get('fcmToken')
            else:
                print(f"'{user_id}' 사용자는 'users' 문서가 없습니다.")
            if fcm_token:
                quiz_url = f"/quiz-page.html?session={new_session_id}"
                message = messaging.Message(
                    data={ 
                        "urlToOpen": quiz_url,
                        "title": "MyBook 복습 시간입니다! 📚", 
                        "body": f"오늘 복습할 {len(final_quiz_items)}개의 퀴즈가 준비되었어요."
                    },
                    token=fcm_token
                )
                messaging.send(message)
                print(f"'{user_id}' 사용자에게 알림 전송 완료.")
            else:
                print(f"'{user_id}' 사용자는 FCM 토큰이 없어 알림을 보내지 않습니다.")
        except Exception as notify_e:
            print(f"'{user_id}' 사용자에게 알림 전송 중 오류 발생: {notify_e}")
        batch = db.batch()
        for doc in wrong_items_docs:
                current_level = doc.to_dict().get("reviewLevel", 0)
                new_level = current_level + 1
                next_review_date = _get_next_review_date(new_level)
                batch.update(doc.reference, {
                    "nextReviewDate": next_review_date, 
                    "reviewLevel": firestore.Increment(1)
                })
        batch.commit()
        print(f"'{user_id}' 사용자의 복습 날짜 (망각 곡선) 업데이트 완료.")
        return https_fn.Response("Session created", status=200)
    except Exception as e:
        print(f"'{user_id or 'Unknown user'}' 사용자 처리 중 치명적 오류: {traceback.format_exc()}")
        try:
             db.collection("reviewSessions").add({
                 "userId": user_id, "status": "error", "errorMessage": str(e),
                 "createdAt": firestore.SERVER_TIMESTAMP
             })
        except Exception as db_e:
            print(f"Firestore 오류 상태 저장 실패: {db_e}")
        return https_fn.Response(f"Internal Error: {e}", status=500)

# 7-5. (유지) 테스트 알림
@https_fn.on_call(
    cors=CORS_OPTIONS
)
def testSendNotification(req: https_fn.CallableRequest) -> https_fn.Response:
    global db
    if db is None: db = firestore.client()
    if req.auth is None:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.UNAUTHENTICATED, message="로그인이 필요합니다.")
    user_id = req.auth.uid
    target_url = "/" 
    try:
        user_doc = db.collection('users').document(user_id).get()
        if not user_doc.exists or not user_doc.to_dict().get('fcmToken'):
            return {"status": "error", "message": "FCM 토큰을 찾을 수 없습니다."}
        token = user_doc.to_dict()['fcmToken']
        message = messaging.Message(
            data={ 
                "urlToOpen": target_url,
                "title": "테스트 알림 🔔",
                "body": "이 메시지가 보인다면 푸시 알림 기능이 정상적으로 동작하는 것입니다!"
            },
            token=token
        )
        messaging.send(message)
        return {"status": "success"}
    except Exception as e:
        print(f"테스트 알림 전송 실패: {e}")
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INTERNAL, message="알림 전송 중 오류 발생")