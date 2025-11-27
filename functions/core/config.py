import os
from firebase_admin import initialize_app, firestore, storage, messaging
from firebase_functions import options

# 1. Firebase 앱 초기화 (한 번만 실행)
initialize_app()

# 2. 전역 옵션 설정
options.set_global_options(
    region="asia-northeast3",
    memory=options.MemoryOption.GB_1, 
    timeout_sec=540,
    secrets=["OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"]
)

# 3. 클라이언트 싱글톤 (Lazy Loading 지원)
_db = None
_storage = None
_messaging = None

def get_db():
    global _db
    if _db is None:
        _db = firestore.client()
    return _db

def get_storage():
    global _storage
    if _storage is None:
        _storage = storage.bucket()
    return _storage

def get_messaging():
    global _messaging
    if _messaging is None:
        _messaging = messaging
    return _messaging

# 상수
ALLOWED_ORIGIN = "https://mybook-d143d.web.app"
PROJECT_ID = "mybook-d143d"
QUEUE_LOCATION = "asia-northeast3"
QUEUE_ID = "quiz-generation-queue"
GENERATE_SESSION_URL = f"https://{QUEUE_LOCATION}-{PROJECT_ID}.cloudfunctions.net/generateUserReviewSession"