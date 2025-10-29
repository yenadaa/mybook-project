# main.py

import base64
import json
import os
import traceback
from datetime import datetime, timezone
from io import BytesIO

from firebase_admin import firestore, initialize_app, messaging, storage
from firebase_functions import https_fn, options, scheduler_fn
from hashlib import sha256

from utils_similarity import normalize_q, char_ngrams, simhash64, simhash_bands, hamming

import re

# --- 초기화 ---
# ✅ [수정] 스토리지 버킷을 명시적으로 지정하여 파일 접근 오류를 해결합니다.
initialize_app()


# 지연 초기화를 위한 전역 클라이언트 변수
db = None
storage_client = None
vision_client = None
openai_client = None

# --- 전역 설정 ---
options.set_global_options(
    region="asia-northeast3",
    memory=options.MemoryOption.GB_1,
    timeout_sec=540,
    secrets=["OPENAI_API_KEY"]
)

# --- 헬퍼 함수: 인증 및 입력 검증 ---
def _get_auth_and_book_id(req: https_fn.CallableRequest) -> tuple[str, str]:
    """인증 및 bookId를 검증하고 user_id와 book_id를 반환합니다."""
    if req.auth is None:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.UNAUTHENTICATED, message="로그인이 필요합니다.")
    user_id = req.auth.uid
    book_id = req.data.get("bookId")
    if not book_id:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT, message="bookId가 필요합니다.")
    return user_id, book_id



# --- 헬퍼 함수: 프롬프트 생성 ---
def _get_quiz_prompt(context: str) -> str:
    """퀴즈 생성을 위한 GPT 프롬프트를 반환합니다."""
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

@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
    cors=options.CorsOptions(cors_origins=["https://mybook-d143d.web.app"])
)
def generateQuiz(req: https_fn.CallableRequest) -> https_fn.Response:
    """사용자의 하이라이트 내용을 기반으로 간단한 퀴즈를 생성합니다."""
    # ✅ [수정] openai 라이브러리를 함수 내부에서 지연 로딩합니다.
    import openai

    global db, openai_client
    if db is None:
        db = firestore.client()
    if openai_client is None:
        openai_client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

    if req.auth is None:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.UNAUTHENTICATED, message="로그인이 필요합니다.")

    user_id = req.auth.uid
    book_id = req.data.get("bookId")
    if not book_id:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT, message="bookId가 필요합니다.")

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


@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
    cors=options.CorsOptions(cors_origins=["https://mybook-d143d.web.app"]),timeout_sec=540
)
def generateFullDocQuiz(req: https_fn.CallableRequest) -> https_fn.Response:
    """PDF에서 텍스트를 추출하고 퀴즈를 생성합니다."""
    # ✅ [수정] 무거운 라이브러리들을 함수 내부에서 지연 로딩하여 초기화 시간 초과를 방지합니다.
    import fitz  # PyMuPDF
    from quiz_generator import PreprocessedDoc, Chunk, generate_base_review

    global db, storage_client
    if db is None:
        db = firestore.client()
    if storage_client is None:
        storage_client = storage.bucket() # initialize_app에서 버킷이름을 설정했으므로 인자 없어도 OK

    if req.auth is None:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.UNAUTHENTICATED, message="로그인이 필요합니다.")

    user_id, book_id = _get_auth_and_book_id(req)
    if not book_id:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT, message="bookId가 필요합니다.")

    print(f"'{book_id}'에 대한 퀴즈 생성 시작")

    # --- 체크포인트 1: Cloud Storage에서 파일 다운로드 ---
    try:
        app_id = "default-app-id"
        file_path = f"artifacts/{app_id}/users/{user_id}/docs/{book_id}.pdf"
        print(f"파일을 찾습니다: gs://{storage_client.name}/{file_path}")
        blob = storage_client.blob(file_path)
        if not blob.exists():
            print(f"Checkpoint 1 오류: 파일을 찾을 수 없음 - {file_path}")
            raise https_fn.HttpsError(code='not-found', message='Cloud Storage에서 파일을 찾을 수 없습니다.')
        pdf_bytes = blob.download_as_bytes()
        print("Checkpoint 1: 파일 다운로드 성공")
    except Exception as e:
        print(f"Checkpoint 1 오류: {traceback.format_exc()}") # 
        raise https_fn.HttpsError(code='internal', message=f'파일 다운로드 중 오류: {str(e)}')

    # --- 체크포인트 2: PyMuPDF로 텍스트 추출 ---
    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        chunks = []
        for i, page in enumerate(doc):
            page_text = page.get_text() or ""
            if page_text.strip():
                chunks.append(Chunk(id=f"c{i}", text=page_text, section_path=[f"p{i+1}"]))
        doc.close()

        total_chars = sum(len(c.text) for c in chunks)
        print(f"✅ 텍스트 추출 결과: {len(chunks)}개 페이지, 총 {total_chars}자")

        if not chunks:
            raise ValueError('PDF에서 텍스트를 추출할 수 없습니다 (이미지 기반 PDF일 수 있습니다).')
        
        print("Checkpoint 2: 텍스트 추출 성공")
    except Exception as e:
        if not chunks:
            raise ValueError('PDF에서 텍스트를 추출할 수 없습니다 (이미지 기반 PDF일 수 있습니다).')
        print("Checkpoint 2: 텍스트 추출 성공")
    except Exception as e:
        print(f"Checkpoint 2 오류: {traceback.format_exc()}") # [수정] 더 상세한 오류 로그
        raise https_fn.HttpsError(code='internal', message=f'PDF 처리 중 오류: {str(e)}')

    # --- 체크포인트 3: AI를 호출하여 퀴즈 생성 ---
    try:
        processed_doc = PreprocessedDoc(doc_id=book_id, chunks=chunks)
        # OpenAI 클라이언트 초기화 (여기에 위치해야 generateQuiz와 무관하게 작동)
        import openai
        global openai_client
        if openai_client is None:
            openai_client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))        
        output = generate_base_review(processed_doc, seed=42, model="gpt-4o-mini")
        print("Checkpoint 3: AI 퀴즈 생성 성공")
        return json.loads(output.json())
    except Exception as e:
        print(f"Checkpoint 3 오류: {traceback.format_exc()}") # ✅ [수정] 더 상세한 오류 로그
        raise https_fn.HttpsError(code='internal', message=f'AI 퀴즈 생성 중 오류: {str(e)}')


@https_fn.on_call(
    cors=options.CorsOptions(cors_origins=["https://mybook-d143d.web.app"])
)
def runOcrOnSelection(req: https_fn.CallableRequest) -> https_fn.Response:
    """사용자가 선택한 이미지 영역에 대해 OCR을 수행합니다."""
    # ✅ [수정] vision 라이브러리를 함수 내부에서 지연 로딩합니다.
    from google.cloud import vision

    global vision_client
    if vision_client is None:
        vision_client = vision.ImageAnnotatorClient()

    if req.auth is None:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.UNAUTHENTICATED, message="로그인이 필요합니다.")

    base64_image = req.data.get("imageData")
    if not base64_image:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT, message="이미지 데이터가 필요합니다.")

    try:
        image_bytes = base64.b64decode(base64_image)
        image = vision.Image(content=image_bytes)
        response = vision_client.text_detection(image=image)
        detected_text = ""
        if response.text_annotations:
            detected_text = response.text_annotations[0].description
        return {"text": detected_text}
    except Exception as e:
        print(f"OCR 오류: {traceback.format_exc()}")
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INTERNAL, message=f"OCR 처리 중 서버 오류 발생: {str(e)}")
    
@https_fn.on_call(cors=options.CorsOptions(cors_origins=["https://mybook-d143d.web.app"]))
def saveQuizItems(req: https_fn.CallableRequest) -> https_fn.Response:
    """
    입력:
    { bookId, scope: "highlight"|"full",
      items: [{type, q|question, answer?, sources?, tags?}] }
    동작:
    - 질문 정규화 -> 3gram -> SimHash(64) -> 밴드키 생성
    - 같은 (userId, bookId, scope)에서 bands ARRAY_CONTAINS 로 후보 수집(limit 50)
    - 해밍거리 <= 6 이면 근사중복
    - 문서ID: {uid}_{bookId}_{scope}_{sha256(q_norm)[:10]}
    출력:
    { saved: [id...], skipped: [{q, reason, existingId?}] }
    """
    global db
    if db is None:
        db = firestore.client()

    if req.auth is None:
        raise https_fn.HttpsError(code="unauthenticated", message="로그인이 필요합니다.")

    uid = req.auth.uid
    book_id = req.data.get("bookId")
    scope = (req.data.get("scope") or "full").strip()  # "highlight" | "full"
    items = req.data.get("items") or []
    if not book_id or not isinstance(items, list):
        raise https_fn.HttpsError(code="invalid-argument", message="bookId와 items가 필요합니다.")

    col = db.collection("quizItems")
    saved, skipped = [], []

    # [수정] 모든 로직이 이 루프 안에 있어야 합니다.
    for raw in items:
        # 1) 질문 텍스트 뽑기
        q = (raw.get("q") or raw.get("question") or "").strip()
        if not q:
            skipped.append({"q": "", "reason": "NO_QUESTION"})
            continue

        # 2) 정규화 + simhash/bands
        q_norm = normalize_q(q)
        tokens = char_ngrams(q_norm, n=3)
        sig64 = simhash64(tokens)
        bands = simhash_bands(sig64)

        # 3) 후보 수집(각 band 별로 질의 후 합집합)
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

        #  4단계
        is_dup = False
        dup_id = None
        for cid, c in candidates.items():
            try:
                c_sig = int(c.get("sim64", "0")) 
            except Exception:
                continue
            if hamming(sig64, c_sig) <= 6:
                is_dup = True
                dup_id = cid
                break
                
        if is_dup:
            skipped.append({"q": q, "reason": "DUPLICATE", "existingId": dup_id})
            continue

        #  [수정] 5단계 - 올바른 들여쓰기
        qhash = sha256(q_norm.encode("utf-8")).hexdigest()[:10]
        doc_id = f"{uid}_{book_id}_{scope}_{qhash}"
        ref = col.document(doc_id)
        existed = ref.get().exists

        payload = {
            "userId": uid,
            "bookId": book_id,
            "scope": scope,
            "type": raw.get("type") or "unknown",
            "q": q,
            "q_norm": q_norm,
            "answer": raw.get("answer"),
            "sources": raw.get("sources") or [],
            "tags": raw.get("tags") or [], 
            "sim64": str(sig64), # (str 저장 - 올바름)
            "bands": bands,
            "updatedAt": firestore.SERVER_TIMESTAMP,
        }
        if not existed:
            payload["createdAt"] = firestore.SERVER_TIMESTAMP

        ref.set(payload, merge=True)
        saved.append(doc_id)

    #[수정] return 문은 루프가 끝난 후 맨 마지막에 한 번
    return {"saved": saved, "skipped": skipped}



"""

@scheduler_fn.on_schedule(schedule="every day 09:00", timezone="Asia/Seoul")
def sendReviewNotifications(event: scheduler_fn.ScheduledEvent) -> None:
    global db
    # ✨ [수정] 지연 초기화 패턴 적용
    if db is None:
        db = firestore.client()
        
    print("매일 복습 알림 함수 실행 시작.")
    # ... (이하 로직은 동일)
    now = datetime.now(timezone.utc)
    users_to_notify = {}

    try:
        docs = db.collection('highlights').where('nextReviewDate', '<=', now).stream()
        for doc in docs:
            item = doc.to_dict()
            user_id = item.get('userId')
            if user_id:
                users_to_notify[user_id] = users_to_notify.get(user_id, 0) + 1
        
        if not users_to_notify:
            print("알림을 보낼 사용자가 없습니다.")
            return

        for user_id, count in users_to_notify.items():
            try:
                user_doc = db.collection('users').document(user_id).get()
                if not user_doc.exists: continue
                
                token = user_doc.to_dict().get('fcmToken')
                if not token: continue

                message = messaging.Message(
                    notification=messaging.Notification(
                        title="MyBook 복습 시간입니다! 📚",
                        body=f"오늘 복습할 {count}개의 밑줄이 기다리고 있어요.",
                    ),
                    token=token,
                )
                messaging.send(message)
                print(f"{user_id}에게 복습 알림 전송 완료 ({count}개 항목)")
            except Exception as e:
                print(f"{user_id}에게 알림 전송 중 오류 발생: {e}")
    except Exception as e:
        print(f"복습 알림 함수 실행 중 전체 오류 발생: {e}")
    print("매일 복습 알림 함수 실행 종료.")

@https_fn.on_call(
    cors=options.CorsOptions(cors_origins=["https://mybook-d143d.web.app"]))
def testSendNotification(req: https_fn.CallableRequest) -> https_fn.Response:
    global db
    # ✨ [수정] 지연 초기화 패턴 적용
    if db is None:
        db = firestore.client()

    if req.auth is None:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.UNAUTHENTICATED, message="로그인이 필요합니다.")

    user_id = req.auth.uid
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
        )
        messaging.send(message)
        return {"status": "success"}
    except Exception as e:
        print(f"테스트 알림 전송 실패: {e}")
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INTERNAL, message="알림 전송 중 오류 발생")
"""