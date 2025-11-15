import firebase_admin
from firebase_admin import firestore, initialize_app, messaging, storage
from firebase_functions import https_fn, options, scheduler_fn, storage_fn

# ⭐️ [복원] 모든 라이브러리를 파일 맨 위에서 import 합니다.
import os
import json
import traceback
from datetime import datetime, timezone, timedelta
import random
import textwrap
from typing import List, Optional, Dict, Any 
import fitz
import numpy as np
from google.cloud import tasks_v2
from google.protobuf import timestamp_pb2
from hashlib import sha256
from utils_similarity import normalize_q, char_ngrams, simhash64, simhash_bands, hamming
import openai
from google.cloud import vision

# ⭐️ [복원] 'quiz_generator'의 모든 것을 파일 맨 위에서 import 합니다.
from quiz_generator import (
    PreprocessedDoc,
    Chunk,
    Output,
    ReviewOut,
    SummaryOut,
    QuestionData,
    AnswerIn,
    ScoreResult,
    get_openai_embeddings,
    pdf_to_preprocessed_doc,
    generate_base_review,
    generate_custom_review,
    score_discussion_answer,
    _get_client,
    _normalize_ids,
    _ask_gpt_json,
    _prompt_keywords,
    _prompt_review,
    _fix_sources,
    generate_relation_discussion_from_chunks,
    _fallback_relation_discussion_from_chunks
)

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
# --- 2. ⭐️ [기능 끔] 파이프라인 (Storage 트리거) ---
# ---------------------------------------------
@storage_fn.on_object_finalized(
    timeout_sec=60,
    memory=256
)
def on_pdf_upload(event: storage_fn.CloudEvent[storage_fn.StorageObjectData]):
    """
    [⭐️ 기능 비활성화]
    이 함수는 이제 아무것도 하지 않습니다. (타임아웃 문제를 피하기 위해)
    모든 작업은 'generateFullDocQuiz'가 직접 처리합니다.
    """
    file_path = event.data.name
    if not file_path or (not file_path.startswith("books/") and not file_path.startswith("artifacts/")):
        print(f"Ignoring file: {file_path}. Pipeline is disabled.")
        return
    print("Pipeline function (on_pdf_upload) is currently disabled.")
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

def _get_quiz_prompt(context: str) -> str:
    # (기존 코드 유지)
    return f"""
    당신은 학습 내용을 바탕으로 객관식 퀴즈를 출제하는 AI입니다.
    ... (프롬프트 내용) ...
    --- 학습 내용 ---
    {context}
    """

def _get_next_review_date(new_review_level: int) -> datetime:
    # (기존 코드 유지)
    now = datetime.now(timezone.utc)
    if new_review_level == 1: return now + timedelta(days=1)
    elif new_review_level == 2: return now + timedelta(days=3)
    elif new_review_level == 3: return now + timedelta(days=7)
    elif new_review_level == 4: return now + timedelta(days=30)
    else: return now + timedelta(days=90)


# ---------------------------------------------
# --- 4. ⭐️ [복원] 퀴즈 생성 함수 (느린 테스트 버전) ---
# ---------------------------------------------

@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
    cors=CORS_OPTIONS,
    timeout_sec=540, # ⭐️ 9분 타임아웃
    memory=options.MemoryOption.GB_1 
)
def generateFullDocQuiz(req: https_fn.CallableRequest) -> https_fn.Response:
    """
    [⭐️ PDF를 직접 읽는 '느린 테스트 버전']
    - Storage에서 PDF를 직접 읽습니다.
    - 'quiz_generator'의 '빠른' generate_base_review 함수를 호출합니다.
    """
    global db, storage_client
    if db is None: db = firestore.client()
    if storage_client is None: storage_client = storage.bucket()

    user_id, book_id = _get_auth_and_book_id(req)
    print(f"'{book_id}'에 대한 퀴즈/요약 생성 시작 (PDF 직접 읽기)")

    # --- 1. 파일 다운로드 ('artifacts' 경로 사용) ---
    try:
        app_id = "default-app-id" 
        file_path = f"artifacts/{app_id}/users/{user_id}/docs/{book_id}.pdf" 
        print(f"파일을 찾습니다: gs://{storage_client.name}/{file_path}")
        blob = storage_client.blob(file_path)
        if not blob.exists():
             raise https_fn.HttpsError(code='not-found', message=f'Cloud Storage에서 파일을 찾을 수 없습니다. 경로: {file_path}')
        pdf_bytes = blob.download_as_bytes()
        print("Checkpoint 1: 파일 다운로드 성공")
    except Exception as e:
        print(f"Checkpoint 1 오류: {e}")
        raise https_fn.HttpsError(code='internal', message=f'파일 다운로드 중 오류: {str(e)}')

    # --- 2. 텍스트 추출 (새 엔진) ---
    try:
        processed_doc: PreprocessedDoc = pdf_to_preprocessed_doc(
            pdf_bytes=pdf_bytes,
            doc_id=book_id
        )
        if not processed_doc.chunks:
             raise ValueError('PDF에서 텍스트를 추출할 수 없습니다.')
        print("Checkpoint 2: 텍스트 추출/처리 성공")
    except Exception as e:
        print(f"Checkpoint 2 오류: {e}")
        raise https_fn.HttpsError(code='internal', message=f'PDF 처리 중 오류: {str(e)}')

    # --- 3. 퀴즈/요약 생성 (빠른 엔진) ---
    try:
        output: Output = generate_base_review(
            processed_doc, 
            model="gpt-4o-mini"
        )
        print("Checkpoint 3: AI 퀴즈/요약 생성 성공")
        return {"result": output.model_dump()}
    except Exception as e:
        print(f"Checkpoint 3 오류: {e}")
        raise https_fn.HttpsError(code='internal', message=f'AI 퀴즈 생성 중 오류: {str(e)}')


@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
    cors=CORS_OPTIONS, 
    timeout_sec=540,
    memory=options.MemoryOption.GB_4 
)
def generateCustomReview(req: https_fn.CallableRequest) -> https_fn.Response:
    """
    [⭐️ PDF를 직접 읽는 '느린 테스트 버전']
    - Storage에서 PDF를 직접 읽습니다.
    - 'quiz_generator'의 '빠른' generate_custom_review 함수를 호출합니다.
    """
    global db, storage_client
    if db is None: db = firestore.client()
    if storage_client is None: storage_client = storage.bucket()

    # 1. 인증 및 ID 가져오기
    user_id, book_id = _get_auth_and_book_id(req)
    counts_override = req.data.get("counts")
    
    print(f"'{book_id}'에 대한 맞춤형 퀴즈 생성 시작 (PDF 직접 읽기)")

    # 2. 파일 다운로드 ('artifacts' 경로 사용)
    try:
        app_id = "default-app-id" 
        file_path = f"artifacts/{app_id}/users/{user_id}/docs/{book_id}.pdf" 
        print(f"파일을 찾습니다: gs://{storage_client.name}/{file_path}")
        blob = storage_client.blob(file_path)
        if not blob.exists():
             raise https_fn.HttpsError(code='not-found', message=f'Cloud Storage에서 파일을 찾을 수 없습니다. 경로: {file_path}')
        pdf_bytes = blob.download_as_bytes()
        print("Checkpoint 1: 파일 다운로드 성공")
    except Exception as e:
        print(f"Checkpoint 1 오류: {e}")
        raise https_fn.HttpsError(code='internal', message=f'파일 다운로드 중 오류: {str(e)}')

    # 3. 텍스트 추출 (새 엔진)
    try:
        processed_doc: PreprocessedDoc = pdf_to_preprocessed_doc(
            pdf_bytes=pdf_bytes,
            doc_id=book_id
        )
        if not processed_doc.chunks:
             raise ValueError('PDF에서 텍스트를 추출할 수 없습니다.')
        print("Checkpoint 2: 텍스트 추출/처리 성공")
    except Exception as e:
        print(f"Checkpoint 2 오류: {e}")
        raise https_fn.HttpsError(code='internal', message=f'PDF 처리 중 오류: {str(e)}')

    # 4. *맞춤형* 퀴즈 생성 엔진 호출
    try:
        all_chunk_ids = [c.id for c in processed_doc.chunks if c.id]
        
        output_review: ReviewOut = generate_custom_review(
            doc=processed_doc,
            chunk_ids=all_chunk_ids, # (main.js가 안 보내므로 전체 청크 사용)
            keywords=req.data.get("keywords"),
            counts_override=counts_override,
            model="gpt-4o-mini"
        )
        
        # ⭐️ 'Output' 객체로 감싸서 반환 (main.js 호환성)
        final_output = Output(
            summaries=SummaryOut(summary="", sources=all_chunk_ids), # 빈 요약
            review=output_review,                                 # 실제 퀴즈
            meta={"model": "gpt-4o-mini", "doc_id": book_id}
        )
        
        print("Checkpoint 3: AI 맞춤형 퀴즈 생성 성공")
        return {"result": final_output.model_dump()}
    
    except Exception as e:
        print(f"Checkpoint 3 오류 (generateCustomReview): {e}")
        raise https_fn.HttpsError(code="internal", message=f"맞춤형 퀴즈 생성 중 오류 발생: {e}")


# ---------------------------------------------
# --- 5. 서술형 채점 함수 ---
# ---------------------------------------------
@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
    cors=CORS_OPTIONS
)
def scoreQuizAnswer(req: https_fn.CallableRequest) -> https_fn.Response:
    try:
        answer_data_dict = req.data.get("answerData")
        if not answer_data_dict:
            raise https_fn.HttpsError(code="invalid-argument", message="answerData가 필요합니다.")
        answer_in_model = AnswerIn(**answer_data_dict)
        score_result: ScoreResult = score_discussion_answer(
            answer_data=answer_in_model,
            model="gpt-4o-mini"
        )
        return {"result": score_result.model_dump()}
    except Exception as e:
        print(f"Error in scoreQuizAnswer: {e}")
        raise https_fn.HttpsError(code="internal", message=f"채점 중 오류 발생: {e}")


# ---------------------------------------------
# --- 6. (유지) 기존 기타 함수들 (OCR, 퀴즈 저장, 알림) ---
# ---------------------------------------------

# 6-1. (유지) 하이라이트 기반 [간단] 퀴즈
@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
    cors=CORS_OPTIONS
)
def generateQuiz(req: https_fn.CallableRequest) -> https_fn.Response:
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


# 6-2. (유지) 이미지 영역 OCR (OpenAI Vision)
@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
    cors=CORS_OPTIONS
)
def runOcrOnSelection(req: https_fn.CallableRequest) -> https_fn.Response:
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


# 6-3. (유지) 퀴즈 저장 (중복 검사)
@https_fn.on_call(cors=CORS_OPTIONS)
def saveQuizItems(req: https_fn.CallableRequest) -> https_fn.Response:
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


# ---------------------------------------------
# 7. (유지) 복습 알림 (지휘자 / 일꾼 분리)
# ---------------------------------------------
PROJECT_ID = "mybook-d143d" 
QUEUE_LOCATION = "asia-northeast3" 
QUEUE_ID = "quiz-generation-queue"
GENERATE_SESSION_URL = f"https://{QUEUE_LOCATION}-{PROJECT_ID}.cloudfunctions.net/generateUserReviewSession" 

@scheduler_fn.on_schedule(schedule="every day 09:00", timezone="Asia/Seoul")
def sendReviewNotifications(event: scheduler_fn.ScheduledEvent) -> None:
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

# ---------------------------------------------
# --- 8. ⭐️ [신규] 챗봇(RAG) 함수 ---
# ---------------------------------------------

def _find_similar_chunks(
    query_vector: List[float], 
    chunks: List["Chunk"], 
    top_k: int = 3
) -> List["Chunk"]:
    """
    [⭐️ 신규 헬퍼] Numpy를 사용해 'In-Function' 벡터 검색을 수행합니다.
    """
    import numpy as np
    from quiz_generator import Chunk # ⭐️ 'Chunk' import
    
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
    cors=CORS_OPTIONS, # ⭐️ CORS 추가
    memory=1024
)
def chatWithBook(req: https_fn.Request) -> https_fn.Response:
    """
    [⭐️ 신규 챗봇 함수 (RAG)]
    """
    from quiz_generator import get_openai_embeddings, _get_client
    
    book_id = req.data.get("bookId")
    query = req.data.get("query")
    
    if not query:
        raise https_fn.HttpsError(code="invalid-argument", message="query가 필요합니다.")

    # 1. Firestore에서 전처리된 데이터 로드 (벡터 포함)
    doc_for_chat = _load_processed_doc_from_firestore(book_id)

    # 2. 사용자 질문(query)을 벡터로 변환
    try:
        query_embedding = get_openai_embeddings([query])
        if not query_embedding or not query_embedding[0]:
            raise Exception("사용자 질문을 임베딩하는 데 실패했습니다.")
        query_vector = query_embedding[0]
    except Exception as e:
        print(f"Error embedding query: {e}")
        raise https_fn.HttpsError(code="internal", message="질문 처리 중 오류 발생")

    # 3. [핵심] In-Function 벡터 검색 수행
    similar_chunks = _find_similar_chunks(
        query_vector, 
        doc_for_chat.chunks,
        top_k=3
    )

    if not similar_chunks:
        context_text = "참고할 만한 컨텍스트를 찾지 못했습니다."
    else:
        context_text = "\n\n---\n\n".join([chunk.text for chunk in similar_chunks])

    # 4. GPT-4o-mini에게 RAG 프롬프트로 질문
    try:
        client = _get_client() # API 클라이언트 가져오기
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