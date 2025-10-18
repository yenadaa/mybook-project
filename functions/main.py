# main.py

import base64
import json
import os
import traceback
from datetime import datetime, timezone
from io import BytesIO

from firebase_admin import firestore, initialize_app, messaging, storage
from firebase_functions import https_fn, options, scheduler_fn

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
    cors=options.CorsOptions(cors_origins=["https://mybook-d143d.web.app"]),timeout_sec=300
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

    user_id = req.auth.uid
    book_id = req.data.get("bookId")
    if not book_id:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT, message="bookId가 필요합니다.")

    print(f"'{book_id}'에 대한 퀴즈 생성 시작")

    # --- 체크포인트 1: Cloud Storage에서 파일 다운로드 ---
    try:
        file_path = f"docs/{user_id}/{book_id}.pdf"
        print(f"파일을 찾습니다: gs://mybook-d143d.firebasestorage.app{file_path}")
        blob = storage_client.blob(file_path)
        if not blob.exists():
            print(f"Checkpoint 1 오류: 파일을 찾을 수 없음 - {file_path}")
            raise https_fn.HttpsError(code='not-found', message='Cloud Storage에서 파일을 찾을 수 없습니다.')
        pdf_bytes = blob.download_as_bytes()
        print("Checkpoint 1: 파일 다운로드 성공")
    except Exception as e:
        print(f"Checkpoint 1 오류: {traceback.format_exc()}") # ✅ [수정] 더 상세한 오류 로그
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
        print(f"Checkpoint 2 오류: {traceback.format_exc()}") # ✅ [수정] 더 상세한 오류 로그
        raise https_fn.HttpsError(code='internal', message=f'PDF 처리 중 오류: {str(e)}')

    # --- 체크포인트 3: AI를 호출하여 퀴즈 생성 ---
    try:
        processed_doc = PreprocessedDoc(doc_id=book_id, chunks=chunks)
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