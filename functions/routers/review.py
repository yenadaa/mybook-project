from firebase_functions import https_fn, scheduler_fn, options
from firebase_admin import firestore, messaging, storage  # 👈 storage 추가됨
from core.config import get_db, PROJECT_ID, QUEUE_LOCATION, QUEUE_ID, GENERATE_SESSION_URL
from datetime import datetime, timezone, timedelta
import json
import traceback
import os  # 👈 os 추가됨

# --------------------------------------------------------
# 헬퍼 함수
# --------------------------------------------------------

def _get_next_review_date(level: int) -> datetime:
    """망각 곡선 날짜 계산 헬퍼"""
    now = datetime.now(timezone.utc)
    if level == 0: delta = 1   # 틀렸거나 처음
    elif level == 1: delta = 2
    elif level == 2: delta = 4
    elif level == 3: delta = 7
    elif level == 4: delta = 14
    else: delta = 30
    return now + timedelta(days=delta)

def _distribute_review_tasks_logic():
    """스케줄러와 테스트 함수가 공통으로 사용하는 알림 분배 로직"""
    from google.cloud import tasks_v2
    
    db = get_db()
    # tasks_client는 여기서 초기화
    tasks_client = tasks_v2.CloudTasksClient()

    print("📢 [Logic] 복습 대상자 검색 및 작업 할당 시작...")
    
    now = datetime.now(timezone.utc)
    users_to_notify = set()

    # 1. 날짜가 된 문제들 찾기
    wrong_quiz_query = (
        db.collection('quizItems')
          .where('nextReviewDate', '<=', now)
    )
    
    # 2. 레벨 필터링 (메모리 상에서 수행)
    for doc in wrong_quiz_query.stream():
        data = doc.to_dict()
        if data.get('reviewLevel', 0) < 4:
            users_to_notify.add(data.get('userId'))

    if not users_to_notify:
        return "알림을 보낼 사용자가 없습니다."

    print(f"총 {len(users_to_notify)} 명의 사용자에 대한 복습 작업 생성 시작...")
    
    queue_path = tasks_client.queue_path(PROJECT_ID, QUEUE_LOCATION, QUEUE_ID)
    SERVICE_ACCOUNT_EMAIL = f"firebase-adminsdk-fbsvc@{PROJECT_ID}.iam.gserviceaccount.com"
    
    count = 0
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
                    "oidc_token": {"service_account_email": SERVICE_ACCOUNT_EMAIL},
                },
                "dispatch_deadline": timedelta(minutes=15)
            }
            tasks_client.create_task(parent=queue_path, task=task)
            print(f"'{user_id}' 사용자를 위한 복습 작업을 큐에 추가했습니다.")
            count += 1
        except Exception as e:
            print(f"Error user {user_id}: {e}")
            
    return f"총 {count}명에게 작업을 할당했습니다."


# --------------------------------------------------------
# 메인 함수들
# --------------------------------------------------------

@scheduler_fn.on_schedule(schedule="every day 09:00", timezone="Asia/Seoul")
def sendReviewNotifications(event: scheduler_fn.ScheduledEvent) -> None:
    print("⏰ [Scheduler] 정기 실행 시작")
    result = _distribute_review_tasks_logic()
    print(result)

@https_fn.on_call(
    region="asia-northeast3",
    cors=options.CorsOptions(cors_origins="*", cors_methods=["POST"])
)
def testTriggerNotifications(req: https_fn.CallableRequest) -> https_fn.Response:
    print("👆 [Test] 프론트엔드 요청으로 강제 실행")
    result = _distribute_review_tasks_logic()
    return {"message": result}

@https_fn.on_request(
    region="asia-northeast3",
    memory=options.MemoryOption.GB_2,
    timeout_sec=1800,
    secrets=["OPENAI_API_KEY"],
    invoker="private" 
)
def generateUserReviewSession(req: https_fn.Request) -> https_fn.Response:
    import openai 
    
    # 여기서 db, storage 등 초기화
    db = get_db()
    # ⭐️ storage 사용을 위해선 bucket이 필요함
    storage_client = storage.bucket() 
    openai_client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY")) # 👈 os 사용됨
    
    user_id = None
    try:
        req_json = req.get_json(silent=True)
        if req_json and "userId" in req_json:
            user_id = req_json.get("userId")
        
        if not user_id:
            return https_fn.Response("Bad Request: Missing userId", status=400)
        
        # 1. 복습 대상 가져오기
        now = datetime.now(timezone.utc)
        docs_stream = (db.collection('quizItems')
                         .where('userId', '==', user_id)
                         .where('nextReviewDate', '<=', now)
                         .stream())

        wrong_items_docs = list(docs_stream)
        if not wrong_items_docs:
            return https_fn.Response("No items to review", status=200)

        final_items_data = []
        for doc in wrong_items_docs:
            data = doc.to_dict()
            if data.get('reviewLevel', 0) >= 4:
                continue
            data['originalDocId'] = doc.id 
            final_items_data.append(data)
            
        if not final_items_data:
            return https_fn.Response("No items (filtered)", status=200)

        # 2. 세션 저장
        session_ref = db.collection("reviewSessions").document()
        session_id = session_ref.id
        session_ref.set({
            "userId": user_id,
            "createdAt": firestore.SERVER_TIMESTAMP,
            "items": final_items_data,
            "status": "ready"
        })

        quiz_url = f"https://{PROJECT_ID}.web.app/quiz-page.html?session={session_id}"
        print(f"🚀 [TEST LINK] 세션 생성 완료! 아래 링크로 접속하세요:")
        print(f"👉 {quiz_url}")

        # 3. 알림 전송
        try:
            user_doc = db.collection('users').document(user_id).get()
            fcm_token = user_doc.to_dict().get('fcmToken') if user_doc.exists else None
            
            if fcm_token:
                quiz_url = f"/quiz-page.html?session={session_id}"
                message = messaging.Message(
                    notification=messaging.Notification(
                        title="MyBook 복습 시간! 📚",
                        body=f"오늘 복습할 {len(final_items_data)}개의 퀴즈가 도착했습니다."
                    ),
                    data={ 
                        "urlToOpen": quiz_url,
                        "title": "MyBook 복습 시간! 📚", 
                        "body": f"오늘 복습할 {len(final_items_data)}개의 퀴즈가 도착했습니다."
                    },
                    token=fcm_token
                )
                messaging.send(message)
                print(f"'{user_id}' 알림 전송 완료.")
        
        except Exception as notify_e:
            print(f"알림 전송 실패: {notify_e}")

        return https_fn.Response("Session created", status=200)

    except Exception as e:
        print(f"Critical Error: {traceback.format_exc()}")
        return https_fn.Response(f"Internal Error: {e}", status=500)

@https_fn.on_call()
def submitReviewSession(req: https_fn.CallableRequest) -> https_fn.Response:
    db = get_db()

    session_id = req.data.get("sessionId")
    user_answers = req.data.get("answers")
    
    if not session_id or not user_answers:
        raise https_fn.HttpsError("invalid-argument", "필수 데이터 누락")

    try:
        session_ref = db.collection("reviewSessions").document(session_id)
        session_doc = session_ref.get()
        
        if not session_doc.exists:
            raise https_fn.HttpsError("not-found", "세션을 찾을 수 없음")
            
        session_data = session_doc.to_dict()
        if session_data.get("status") == "completed":
            return {"message": "이미 제출됨", "score": 0}

        quiz_items = session_data.get("items", [])
        batch = db.batch()
        correct_count = 0
        total_count = 0

        for item in quiz_items:
            original_id = item.get("originalDocId")
            if not original_id: continue
            
            item_ref = db.collection("quizItems").document(original_id)
            
            # 채점 로직 (간단 비교)
            correct_answer = str(item.get("answer", "")).strip().lower()
            user_answer = str(user_answers.get(original_id, "")).strip().lower()
            is_correct = (correct_answer == user_answer)
            
            current_level = item.get("reviewLevel", 0)
            
            if is_correct:
                correct_count += 1
                new_level = min(current_level + 1, 5)
            else:
                new_level = 0 
            
            next_date = _get_next_review_date(new_level)
            
            batch.update(item_ref, {
                "reviewLevel": new_level,
                "nextReviewDate": next_date,
                "lastReviewedAt": firestore.SERVER_TIMESTAMP
            })
            total_count += 1

        batch.update(session_ref, {
            "status": "completed",
            "submittedAt": firestore.SERVER_TIMESTAMP,
            "score": f"{correct_count}/{total_count}"
        })

        batch.commit()
        
        return {
            "success": True,
            "correctCount": correct_count,
            "totalCount": total_count,
            "message": "채점 및 망각곡선 업데이트 완료"
        }

    except Exception as e:
        print(f"채점 오류: {e}")
        raise https_fn.HttpsError("internal", f"채점 실패: {e}")
    
# --------------------------------------------------------
# [NEW] 시연용 강제 스케줄 생성 함수
# --------------------------------------------------------
@https_fn.on_call(
    region="asia-northeast3",
    secrets=["OPENAI_API_KEY"], 
    memory=options.MemoryOption.GB_1,
    # 🔥 [수정] 키워드 인자(cors_origins=)를 빼고 값만 순서대로 전달하여 버전 충돌 방지
    cors=options.CorsOptions("*", ["POST"]) 
)
def createDemoSchedule(req: https_fn.CallableRequest) -> dict:
    """
    프론트에서 '망각곡선 스케줄 생성' 버튼을 누르면 호출.
    해당 문서에 대한 퀴즈 아이템을 만들고, 
    테스트를 위해 'nextReviewDate'를 현재 시간보다 1분 전으로 설정해버림 (즉시 알림 대상).
    """
    db = get_db()
    
    doc_id = req.data.get("docId")
    title = req.data.get("title")
    force_now = req.data.get("forceNow", False) 

    if not doc_id:
        raise https_fn.HttpsError("invalid-argument", "docId is required")

    user_id = req.auth.uid
    if not user_id:
        raise https_fn.HttpsError("unauthenticated", "User must be logged in")

    quiz_ref = db.collection("quizItems")
    existing_docs = quiz_ref.where("originalDocId", "==", doc_id).where("userId", "==", user_id).limit(1).get()

    if not list(existing_docs):
        print(f"[{doc_id}] 퀴즈가 없어서 더미 퀴즈 3개를 생성합니다.")
        batch = db.batch()
        
        for i in range(1, 4):
            new_ref = quiz_ref.document()
            if force_now:
                target_date = datetime.now(timezone.utc) - timedelta(minutes=1)
            else:
                target_date = datetime.now(timezone.utc) + timedelta(days=1)

            dummy_data = {
                "userId": user_id,
                "originalDocId": doc_id,
                "docTitle": title,
                "question": f"[{title}]의 {i}번째 핵심 질문은 무엇인가요? (테스트)",
                "answer": f"이것은 {i}번째 정답입니다.",
                "reviewLevel": 0,
                "nextReviewDate": target_date,
                "createdAt": firestore.SERVER_TIMESTAMP
            }
            batch.set(new_ref, dummy_data)
        
        batch.commit()
        msg = "더미 퀴즈 3개 생성 및 스케줄 등록 완료."
    
    else:
        if force_now:
            docs = quiz_ref.where("originalDocId", "==", doc_id).where("userId", "==", user_id).stream()
            batch = db.batch()
            for doc in docs:
                past_time = datetime.now(timezone.utc) - timedelta(minutes=1)
                batch.update(doc.reference, {"nextReviewDate": past_time})
            batch.commit()
            msg = "기존 퀴즈들의 복습 시간을 '지금'으로 당겼습니다."
        else:
            msg = "이미 스케줄이 존재합니다."

    return {
        "success": True, 
        "message": msg,
        "mode": "Immediate Test" if force_now else "Standard Schedule"
    }