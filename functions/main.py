import base64
import json
import os
import re
from firebase_functions import https_fn, options,scheduler_fn
from firebase_admin import initialize_app, firestore, storage,messaging
from datetime import datetime, timezone
from google.cloud import vision
import openai
import certifi
import requests



# --- 초기화 ---
initialize_app()
#gpt
options.set_global_options(
    region="asia-northeast3",
    memory=options.MemoryOption.MB_512,
    timeout_sec=300,
    secrets=["OPENAI_API_KEY"]
)

db = None
vision_client = None
storage_client = None

# --- OCR 펜 함수 ---
@https_fn.on_call()
def runOcrOnSelection(req: https_fn.CallableRequest) -> https_fn.Response:
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
        detected_text = response.text_annotations[0].description if response.text_annotations else ""
        return {"text": detected_text}
    except Exception as e:
        print(f"OCR 처리 중 오류 발생: {e}")
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INTERNAL, message="OCR 처리 중 서버에서 오류가 발생했습니다.")


# --- PDF 전체 분석 함수 ---
@https_fn.on_call()
def runOcrOnDemand(req: https_fn.CallableRequest) -> https_fn.Response:
    global db, vision_client, storage_client

    if db is None:
        db = firestore.client()
    if vision_client is None:
        vision_client = vision.ImageAnnotatorClient()
    if storage_client is None:
        storage_client = storage.bucket()

    if req.auth is None:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.UNAUTHENTICATED, message="로그인이 필요합니다.")

    file_path = req.data.get("filePath")
    if not file_path:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT, message="파일 경로가 필요합니다.")

    user_id = req.auth.uid
    file_name = os.path.basename(file_path)

    try:
        bucket_name = os.environ.get('GCP_PROJECT') + ".appspot.com"
        gcs_source_uri = f"gs://{bucket_name}/{file_path}"
        gcs_destination_uri = f"gs://{bucket_name}/{file_path}_ocr_results/"

        gcs_source = vision.GcsSource(uri=gcs_source_uri)
        feature = vision.Feature(type_=vision.Feature.Type.DOCUMENT_TEXT_DETECTION)
        input_config = vision.InputConfig(gcs_source=gcs_source, mime_type='application/pdf')
        
        gcs_destination = vision.GcsDestination(uri=gcs_destination_uri)
        output_config = vision.OutputConfig(gcs_destination=gcs_destination, batch_size=100)

        async_request = vision.AsyncAnnotateFileRequest(
            features=[feature], input_config=input_config, output_config=output_config
        )
        operation = vision_client.async_batch_annotate_files(requests=[async_request])
        print(f"OCR 작업 대기 중: {operation.operation.name}")
        operation.result(timeout=420)
        print("OCR 작업 완료.")

        destination_prefix = f"{file_path}_ocr_results/"
        blobs = storage_client.list_blobs(prefix=destination_prefix)

        for blob in blobs:
            if not blob.name.endswith('.json'):
                continue
            
            json_string = blob.download_as_string()
            response = json.loads(json_string)
            
            for page_response in response['responses']:
                page_annotation = page_response['fullTextAnnotation']
                page_number_match = re.search(r'output-(\d+)-to-', blob.name)
                page_number = int(page_number_match.group(1)) if page_number_match else 0

                ocr_data = {
                    'userId': user_id,
                    'bookId': file_name,
                    'sourceFile': file_path,
                    'pageNumber': page_number + 1,
                    'text': page_annotation['text'],
                }
                db.collection('ocr_results').add(ocr_data)
        
        # Clean up the results folder
        for blob in storage_client.list_blobs(prefix=destination_prefix):
            blob.delete()

        return {"status": "success", "message": "OCR 분석 및 결과 저장이 완료되었습니다."}

    except Exception as e:
        print(f"전체 OCR 처리 중 오류 발생: {e}")
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INTERNAL, message="전체 OCR 처리 중 오류가 발생했습니다.")
    
@https_fn.on_call(secrets=["OPENAI_API_KEY"])
def generateQuiz(req: https_fn.CallableRequest) -> https_fn.Response:
    global db
    if db is None:
        db = firestore.client()

    if req.auth is None:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.UNAUTHENTICATED, message="로그인이 필요합니다.")

    user_id = req.auth.uid
    book_id = req.data.get("bookId")

    highlights_ref = db.collection('highlights')
    query = highlights_ref.where('userId', '==', user_id).where('bookId', '==', book_id)
    docs = query.stream()
    
    # ✨ [수정] 'ocrText'가 아닌 'text' 필드를 올바르게 참조합니다.
    texts = [doc.to_dict().get('text', '') for doc in docs if doc.to_dict().get('text')]
    if not texts:
        return {"quiz": []} # 내용이 없을 때 빈 배열 반환
    context = "\n".join(texts)

    # ✨ [수정] 프롬프트에 한국어로 작성하라는 명확한 지시를 추가합니다.
    prompt = f"""
    당신은 학습 내용을 바탕으로 객관식 퀴즈를 출제하는 AI입니다.
    아래 주어진 내용을 바탕으로, 가장 중요하다고 생각되는 내용에 대해 객관식 문제 3개를 만들어주세요.
    요청사항:
    - 퀴즈는 반드시 한국어로 작성해주세요.
    - 각 문제는 질문(question), 4개의 보기(options), 정답(answer)을 포함해야 합니다.
    - 결과는 반드시 JSON 형식으로 반환해주세요. 예: {{"quiz": [{{"question": "...", "options": ["...", "...", "...", "..."], "answer": "..."}}]}}
    --- 학습 내용 ---
    {context}
    """

    try:
        api_key_raw = os.environ.get("OPENAI_API_KEY")
        if not api_key_raw:
            raise Exception("OPENAI_API_KEY is not set.")
        
        api_key = api_key_raw.strip()
        api_url = "https://api.openai.com/v1/chat/completions"
        
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "model": "gpt-4-turbo",
            "messages": [{"role": "system", "content": prompt}],
            "response_format": {"type": "json_object"}
        }

        response = requests.post(api_url, headers=headers, json=payload)
        response.raise_for_status()

        result_json = response.json()
        quiz_data = result_json['choices'][0]['message']['content']

        return json.loads(quiz_data)

    except Exception as e:
        print(f"GPT API 호출 오류: {e}")
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INTERNAL, message="퀴즈 생성 중 오류가 발생했습니다.")

@scheduler_fn.on_schedule(schedule="every day 09:00", timezone="Asia/Seoul")
def sendReviewNotifications(event: scheduler_fn.ScheduledEvent) -> None:
    global db
    if db is None:
        db = firestore.client()

    print("매일 복습 알림 함수 실행 시작.")
    now = datetime.now(timezone.utc)

    try:
        query = db.collection('highlights').where('nextReviewDate', '<=', now)
        docs = query.stream()

        users_to_notify = {}
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

@https_fn.on_call()
def testSendNotification(req: https_fn.CallableRequest) -> https_fn.Response:
    global db
    if db is None:
        db = firestore.client()

    if req.auth is None:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.UNAUTHENTICATED, message="로그인이 필요합니다.")

    user_id = req.auth.uid
    try:
        user_doc = db.collection('users').document(user_id).get()
        if not user_doc.exists:
            return {"status": "error", "message": "사용자 문서를 찾을 수 없습니다."}
        
        token = user_doc.to_dict().get('fcmToken')
        if not token:
            return {"status": "error", "message": "FCM 토큰이 없습니다."}

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