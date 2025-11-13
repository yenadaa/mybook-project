# main.py

import base64
import json
import os
import traceback
from datetime import datetime, timezone, timedelta
from io import BytesIO

# ⭐️ [추가] textwrap, random (quiz_generator가 내부적으로 사용)
import textwrap
import random

from firebase_admin import firestore, initialize_app, messaging, storage
from firebase_functions import https_fn, options, scheduler_fn
from hashlib import sha256

# 유틸리티 및 AI 생성기 import
from utils_similarity import normalize_q, char_ngrams, simhash64, simhash_bands, hamming
import fitz  # PyMuPDF

# ⭐️ [수정] quiz_generator.py에서 필요한 함수들을 정확히 import 합니다.
from quiz_generator import (
    PreprocessedDoc, 
    Chunk, 
    generate_base_review,    
    generate_custom_review, 
    Output,                  
    SummaryOut,            
    ReviewOut              
)
import openai
from google.cloud import vision

# ❗ [추가] Cloud Tasks (백그라운드 작업용)
from google.cloud import tasks_v2
from google.protobuf import timestamp_pb2

# --- 초기화 ---
initialize_app()

# 지연 초기화를 위한 전역 클라이언트 변수
db = None
storage_client = None
vision_client = None
openai_client = None
tasks_client = None 

# --- 전역 설정 ---
options.set_global_options(
    region="asia-northeast3",
    memory=options.MemoryOption.GB_1, # 1세대 함수 기본값
    timeout_sec=540, # 9분 (최대)
    secrets=["OPENAI_API_KEY"]
)

# ---------------------------------------------
# 헬퍼 함수 (인증, 프롬프트)
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
    return f"""
    당신은 학습 내용을 바탕으로 객관식 퀴즈를 출제하는 AI입니다.
    아래 주어진 내용을 바탕으로, 가장 중요하다고 생각되는 내용에 대해 객관식 문제 3개를 만들어주세요.
    요청사항:
    - 퀴즈는 반드시 한국어로 작성해주세요.
    - 각 문제는 질문(question), 4개의 보기(options), 정답(answer)을 포함해야 합니다.
    - 결과는 반드시 JSON 형식으로 반환해주세요. 예: {{"quiz": [{{"question": "...", "options": ["...", "...", "...", "..."], "answer": "..."}}]}}
    --- 학습 내용 ---
    {context}
    """
def _get_next_review_date(new_review_level: int) -> datetime:
    """새로운 reviewLevel에 따라 다음 복습 날짜를 계산합니다."""
    now = datetime.now(timezone.utc)
    
    # new_review_level == 1 (첫 복습 완료) -> 1일 뒤
    if new_review_level == 1:
        return now + timedelta(days=1)
    # new_review_level == 2 (1일차 복습 완료) -> 3일 뒤
    elif new_review_level == 2:
        return now + timedelta(days=3)
    # new_review_level == 3 (3일차 복습 완료) -> 7일 뒤
    elif new_review_level == 3:
        return now + timedelta(days=7)
    # new_review_level == 4 (7일차 복습 완료) -> 30일 뒤 (또는 완료)
    elif new_review_level == 4:
        return now + timedelta(days=30)
    # 그 외 (레벨 5 이상)
    else:
        # 4단계 완료로 간주, 넉넉하게 90일 뒤
        return now + timedelta(days=90)


# ---------------------------------------------
# 1. 하이라이트 기반 퀴즈 (즉시 실행)
# ---------------------------------------------
@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
    cors=options.CorsOptions(cors_origins=["https://mybook-d143d.web.app"])
)
def generateQuiz(req: https_fn.CallableRequest) -> https_fn.Response:
    # (이 함수는 기존 코드와 동일 - 잘 작동합니다)
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

# ---------------------------------------------
# 2. ⭐️ [수정된 전체 코드] 하이라이트 기반 복합 퀴즈
# ---------------------------------------------
@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
    cors=options.CorsOptions(cors_origins=["https://mybook-d143d.web.app"]),
    timeout_sec=540,
    memory=options.MemoryOption.GB_4 # 👈 4GB 메모리 설정
)
def generateCustomReview(req: https_fn.CallableRequest) -> https_fn.Response:
    """
    [수정] 사용자의 하이라이트 (Chunk)를 모아서,
    quiz_generator.py의 'generate_custom_review' 함수를 호출합니다.
    """
    global db, openai_client
    if db is None: db = firestore.client()
    if openai_client is None: openai_client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

    user_id, book_id = _get_auth_and_book_id(req)
    model = "gpt-4o-mini"
    print(f"'{book_id}'에 대한 'generateCustomReview' (올바른 버전) 생성 시작")

    # --- 체크포인트 1: 하이라이트 텍스트 -> Chunk 리스트로 변환 ---
    try:
        docs = db.collection('highlights').where('userId', '==', user_id).where('bookId', '==', book_id).stream()
        
        chunks = []
        highlight_ids = [] # 👈 [수정] ID만 필요합니다.

        for doc in docs:
            doc_data = doc.to_dict()
            text = doc_data.get('text')
            if not text:
                continue
            
            page_num = doc_data.get('pageNumber', 0)
            chunk_id = doc.id # 하이라이트 문서 ID
            
            chunks.append(
                Chunk(
                    id=chunk_id, 
                    text=text,
                    section_path=[f"p{page_num}"]
                )
            )
            highlight_ids.append(chunk_id)

        if not chunks:
            print("하이라이트가 없어 퀴즈를 생성할 수 없습니다.")
            return {"summaries": {}, "review": {}} 

        print(f"Checkpoint 1: 하이라이트 {len(chunks)}개 로드 성공")

    except Exception as e:
        print(f"Checkpoint 1 (Highlight Fetch) 오류: {traceback.format_exc()}")
        raise https_fn.HttpsError(code='internal', message=f'하이라이트 로드 중 오류: {str(e)}')

    # --- 👇👇 [누락된 부분] 이 코드가 통째로 빠져있었습니다! 👇👇 ---
    # --- 체크포인트 2: AI 퀴즈 생성 (generate_custom_review 호출) ---
    try:
        # 1. PreprocessedDoc 객체 생성 (모든 하이라이트 청크를 포함)
        processed_doc = PreprocessedDoc(doc_id=book_id, chunks=chunks)
        
        # 2. [핵심] generate_base_review가 아니라 generate_custom_review를 호출
        #    chunk_ids 인자에 하이라이트 ID 리스트를 전달합니다.
        review_output = generate_custom_review(
            doc=processed_doc, 
            chunk_ids=highlight_ids, # 👈 이 하이라이트들만 대상으로!
            model=model,
            seed=42,
            # ⭐️ 하이라이트 '각각'에 대해 만들 퀴즈 개수 설정
            counts_override={"ox": 1, "short": 1, "discussion": 1} 
        )
        
        # 3. main.js가 기대하는 {summaries, review} 형태로 맞춥니다.
        #    (generate_custom_review는 요약은 안 만드므로, 요약은 비워둡니다)
        final_output = Output(
            summaries=SummaryOut(summary_300="", summary_half="", summary_full="하이라이트 기반 퀴즈는 요약을 제공하지 않습니다.", sources=highlight_ids),
            review=review_output, # 👈 AI가 생성한 복합 퀴즈 결과
            meta={"model": model, "doc_id": book_id}
        )

        print("Checkpoint 2: AI 복합 퀴즈 ('generate_custom_review') 생성 성공")
        # 4. main.js가 기대하는 JSON 형식으로 반환
        return json.loads(final_output.json()) 
        
    except Exception as e:
        print(f"Checkpoint 2 (AI Generation) 오류: {traceback.format_exc()}")
        raise https_fn.HttpsError(code='internal', message=f'AI 퀴즈 생성 중 오류: {str(e)}')
    # --- 👆👆 [누락된 부분] 여기까지 👆👆 ---


# ---------------------------------------------
# 3. [번호 수정] 전체 문서 기반 퀴즈 (시간 초과 위험!)
# ---------------------------------------------
@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
    cors=options.CorsOptions(cors_origins=["https://mybook-d143d.web.app"]),
    timeout_sec=540 # 9분
)
def generateFullDocQuiz(req: https_fn.CallableRequest) -> https_fn.Response:
    # (이 함수는 기존 코드와 동일 - 파일 경로 수정됨)
    # (참고: 이 함수는 여전히 9분 시간 초과 위험이 있습니다!)
    global db, storage_client, openai_client
    if db is None: db = firestore.client()
    if storage_client is None: storage_client = storage.bucket()
    if openai_client is None: openai_client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

    user_id, book_id = _get_auth_and_book_id(req)
    print(f"'{book_id}'에 대한 퀴즈 생성 시작")

    # --- 체크포인트 1: 파일 다운로드 (경로 수정됨) ---
    try:
        app_id = "default-app-id"
        file_path = f"artifacts/{app_id}/users/{user_id}/docs/{book_id}.pdf" # ✅ 올바른 경로
        print(f"파일을 찾습니다: gs://{storage_client.name}/{file_path}")
        blob = storage_client.blob(file_path)
        if not blob.exists():
            print(f"Checkpoint 1 오류: 파일을 찾을 수 없음 - {file_path}")
            raise https_fn.HttpsError(code='not-found', message='Cloud Storage에서 파일을 찾을 수 없습니다.')
        pdf_bytes = blob.download_as_bytes()
        print("Checkpoint 1: 파일 다운로드 성공")
    except Exception as e:
        print(f"Checkpoint 1 오류: {traceback.format_exc()}")
        raise https_fn.HttpsError(code='internal', message=f'파일 다운로드 중 오류: {str(e)}')

    # --- 체크포인트 2: 텍스트 추출 ---
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        chunks = [Chunk(id=f"c{i}", text=page.get_text() or "", section_path=[f"p{i+1}"]) for i, page in enumerate(doc) if page.get_text().strip()]
        doc.close()
        total_chars = sum(len(c.text) for c in chunks)
        print(f"✅ 텍스트 추출 결과: {len(chunks)}개 페이지, 총 {total_chars}자")
        if not chunks:
            raise ValueError('PDF에서 텍스트를 추출할 수 없습니다 (이미지 기반 PDF일 수 있습니다).')
        print("Checkpoint 2: 텍스트 추출 성공")
    except Exception as e:
        print(f"Checkpoint 2 오류: {traceback.format_exc()}")
        raise https_fn.HttpsError(code='internal', message=f'PDF 처리 중 오류: {str(e)}')

    # --- 체크포인트 3: AI 퀴즈 생성 ---
    try:
        processed_doc = PreprocessedDoc(doc_id=book_id, chunks=chunks)
        output = generate_base_review(processed_doc, seed=42, model="gpt-4o-mini")
        print("Checkpoint 3: AI 퀴즈 생성 성공")
        return json.loads(output.json())
    except Exception as e:
        print(f"Checkpoint 3 오류: {traceback.format_exc()}")
        raise https_fn.HttpsError(code='internal', message=f'AI 퀴즈 생성 중 오류: {str(e)}')

# ---------------------------------------------
# 4. [번호 수정] 이미지 영역 OCR (OpenAI Vision)
# ---------------------------------------------
@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
    cors=options.CorsOptions(cors_origins=["https://mybook-d143d.web.app"])
)
def runOcrOnSelection(req: https_fn.CallableRequest) -> https_fn.Response:
    # (이 함수는 이전에 수정한 OpenAI Vision 버전 - 잘 작동합니다)
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
        prompt_text = """
        당신은 이미지 속의 표, 차트, 그래프를 분석하여 퀴즈를 만들 수 있도록 
        핵심 내용을 '줄글(prose)'로 요약하는 AI입니다.
        ... (이하 프롬프트 동일) ...
        5. 만약 단순 텍스트라면, 그 텍스트만 반환합니다.
        """
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

# ---------------------------------------------
# 5. [번호 수정] 퀴즈 저장 (중복 검사)
# ---------------------------------------------
@https_fn.on_call(cors=options.CorsOptions(cors_origins=["https://mybook-d143d.web.app"]))
def saveQuizItems(req: https_fn.CallableRequest) -> https_fn.Response:
    # (이 함수는 기존 코드와 동일 - 잘 작동합니다)
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
            # ❗ [중요] 퀴즈를 풀 때마다 이 필드를 업데이트해야 함
            "reviewLevel": 0, # 0 = 학습 전, 1 = 1일차, 2 = 3일차, 3 = 7일차, 4 = 완료
            "nextReviewDate": firestore.SERVER_TIMESTAMP # 👈 저장 즉시 복습 가능
        }
        if not existed:
            payload["createdAt"] = firestore.SERVER_TIMESTAMP

        ref.set(payload, merge=True)
        saved.append(doc_id)

    return {"saved": saved, "skipped": skipped}

# ---------------------------------------------
# 6. [번호 수정] 복습 알림 (지휘자 / 일꾼 분리)
# ---------------------------------------------

# --- Cloud Tasks 큐 정보 ---
PROJECT_ID = "mybook-d143d" 
QUEUE_LOCATION = "asia-northeast3" 
QUEUE_ID = "quiz-generation-queue"
GENERATE_SESSION_URL = "https://asia-northeast3-mybook-d143d.cloudfunctions.net/generateUserReviewSession" 


# ⚙️ 함수 A: "지휘자" (매일 9시 실행)
@scheduler_fn.on_schedule(schedule="every day 09:00", timezone="Asia/Seoul")
def sendReviewNotifications(event: scheduler_fn.ScheduledEvent) -> None:
    global db, tasks_client
    if db is None: db = firestore.client()
    if tasks_client is None: tasks_client = tasks_v2.CloudTasksClient()

    print("매일 복습 알림 '지휘자' 함수 실행 시작.")
    now = datetime.now(timezone.utc)
    
    # 1. 복습할 항목이 있는 사용자 ID 수집 (중복 제거)
    users_to_notify = set()
    
    '''# 쿼리 1: 하이라이트 (doc_firebase.js에서 저장한 것)
    highlights_query = db.collection('highlights').where('nextReviewDate', '<=', now)
    for doc in highlights_query.stream():
        users_to_notify.add(doc.to_dict().get('userId'))
'''
    # 쿼리 1: 틀린 퀴즈 (saveQuizItems에서 저장한 것)
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

    # 3. 사용자별로 "일꾼"에게 작업 할당
    for user_id in users_to_notify:
        if not user_id: continue
        
        try:
            payload = {"userId": user_id}
            task = {
                "http_request": {
                    "http_method": tasks_v2.HttpMethod.POST,
                    "url": GENERATE_SESSION_URL, # 👈 [중요] 일꾼 함수 URL
                    "headers": {"Content-Type": "application/json"},
                    "body": json.dumps(payload).encode(),
                    "oidc_token": {
                        "service_account_email": "firebase-adminsdk-fbsvc@mybook-d143d.iam.gserviceaccount.com" 
                    },
                },
                # (선택) 9분 타임아웃 방지를 위해 약간의 시간차를 두고 실행
                "dispatch_deadline": timedelta(minutes=15)
            }
            tasks_client.create_task(parent=queue_path, task=task)
            print(f"'{user_id}' 사용자를 위한 복습 작업을 큐에 추가했습니다.")

        except Exception as e:
            print(f"'{user_id}' 사용자 작업 생성 중 오류: {e}")
            
    print("모든 복습 작업 할당 완료.")


# ⚙️ 함수 B: "일꾼" (작업 받아서 1명분 퀴즈 세션 생성)
@https_fn.on_request(
    region="asia-northeast3",
    memory=options.MemoryOption.GB_2,
    timeout_sec=1800, # 30분
    secrets=["OPENAI_API_KEY"],
    invoker="private" # 👈 [중요] 지휘자(A) 또는 인증된 호출만 허용
)
def generateUserReviewSession(req: https_fn.Request) -> https_fn.Response:
    global db, openai_client, storage_client
    if db is None: db = firestore.client()
    if openai_client is None: openai_client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    if storage_client is None: storage_client = storage.bucket()

    user_id = None
    try:
        # 1. 작업 요청에서 userId 가져오기
        payload = req.get_json(silent=True)
        user_id = payload.get("userId")
        if not user_id:
            print("오류: userId가 없습니다.")
            return https_fn.Response("Bad Request", status=400)

        print(f"'{user_id}' 사용자의 복습 퀴즈 세션 생성을 시작합니다.")
        now = datetime.now(timezone.utc) #

        # 3. 틀렸던 퀴즈 찾기 (복습 레벨 1~3, 즉 완료(4)가 아닌 것)
        wrong_quiz_query = db.collection('quizItems').where('userId', '==', user_id).where('reviewLevel', '<', 4).where('reviewLevel', '<', 4)
        wrong_items_docs = list(wrong_quiz_query.stream())

        # 4. 복습할 것이 없으면 종료
        if not wrong_items_docs and not wrong_items_docs:
            print(f"'{user_id}' 사용자는 복습할 항목이 없습니다.")
            return https_fn.Response("No items to review", status=200)

        # 6. 퀴즈 세트 합치기
        final_quiz_items = [doc.to_dict() for doc in wrong_items_docs] 

        # 7. Firestore 'reviewSessions'에 퀴즈 세트 저장
        session_ref = db.collection("reviewSessions").document()
        session_ref.set({
            "userId": user_id,
            "createdAt": firestore.SERVER_TIMESTAMP,
            "items": final_quiz_items
        })
        new_session_id = session_ref.id
        print(f"'{user_id}' 사용자의 퀴즈 세션 '{new_session_id}' 저장 완료.")

        # --- 👇 [수정] 8. 알림 보내기---
        try:
            user_doc = db.collection('users').document(user_id).get()
            fcm_token = None
            
            if user_doc.exists: # [핵심] 사용자가 'users' 문서가 있는지 확인
                fcm_token = user_doc.to_dict().get('fcmToken')
            else:
                print(f"'{user_id}' 사용자는 'users' 문서가 없습니다. (알림 권한을 허용한 적 없음)")

            if fcm_token: # 👈 토큰이 있을 때만 전송
                quiz_url = f"/quiz-page.html?session={new_session_id}"
                message = messaging.Message(
                    data={ 
                        "urlToOpen": quiz_url,
                        # sw.js의 onBackgroundMessage가 사용할 제목/본문
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
            # ❗ 알림 전송에 실패해도, 퀴즈 생성/저장은 성공했으므로 
            #    오류만 로깅하고 함수를 중단시키지 않습니다.
            print(f"'{user_id}' 사용자에게 알림 전송 중 오류 발생: {notify_e}")
        # --- 알림 로직 끝 ---

        # 9. [중요] 복습한 항목들 날짜 업데이트 (망각곡선)
        batch = db.batch()
        next_review_time = datetime.now(timezone.utc) + timedelta(days=1)
        for doc in wrong_items_docs:
                current_level = doc.to_dict().get("reviewLevel", 0)
                new_level = current_level + 1
                next_review_date = _get_next_review_date(new_level) # 👈 망각 곡선 적용
                
                batch.update(doc.reference, {
                    "nextReviewDate": next_review_date, 
                    "reviewLevel": firestore.Increment(1)
                })
            
        batch.commit()
        print(f"'{user_id}' 사용자의 복습 날짜 (망각 곡선) 업데이트 완료.")

        # 10. Cloud Tasks에 성공 응답
        return https_fn.Response("Session created", status=200)

    except Exception as e:
        # (이것은 1~7, 9단계에서 발생한 치명적 오류)
        print(f"'{user_id or 'Unknown user'}' 사용자 처리 중 치명적 오류: {traceback.format_exc()}")
        try:
             # 오류 발생 시 Firestore에 기록
             db.collection("reviewSessions").add({
                 "userId": user_id, "status": "error", "errorMessage": str(e),
                 "createdAt": firestore.SERVER_TIMESTAMP
             })
        except Exception as db_e:
            print(f"Firestore 오류 상태 저장 실패: {db_e}")
        return https_fn.Response(f"Internal Error: {e}", status=500)

# ---------------------------------------------
# 7. [번호 수정] 테스트 알림 (수정됨)
# ---------------------------------------------
'''
@https_fn.on_call(
    cors=options.CorsOptions(cors_origins=["https://mybook-d143d.web.app"]))
def testSendNotification(req: https_fn.CallableRequest) -> https_fn.Response:
    global db
    if db is None: db = firestore.client()
    if req.auth is None:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.UNAUTHENTICATED, message="로그인이 필요합니다.")
    user_id = req.auth.uid
    
    # ⭐️ [테스트용 수정] data 페이로드 추가 (홈페이지로 이동)
    target_url = "/" # 기본값은 홈
    
    try:
        user_doc = db.collection('users').document(user_id).get()
        if not user_doc.exists or not user_doc.to_dict().get('fcmToken'):
            return {"status": "error", "message": "FCM 토큰을 찾을 수 없습니다."}
        
        token = user_doc.to_dict()['fcmToken']
        message = messaging.Message(
            notification=messaging.Notification(
                title="테스트 알림 🔔",
                body="이 메시지가 보인다면 푸시 알림 기능이 정상적으로 동작하는 것입니다!",
            ),
            token=token,
            data={ "urlToOpen": target_url } # 👈 [수정] urlToOpen 사용
        )
        messaging.send(message)
        return {"status": "success"}
    except Exception as e:
        print(f"테스트 알림 전송 실패: {e}")
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INTERNAL, message="알림 전송 중 오류 발생")
        '''