# functions/main.py

# 1. 최소한의 필수 모듈만 전역으로 가져옵니다.
import firebase_admin
from firebase_admin import firestore, initialize_app
from firebase_functions import https_fn, options

# 2. 다른 라우터들은 그대로 둡니다.
from routers.pipeline import on_pdf_upload
from routers.chat import ragChat
from routers.quiz import (
    generateFullDocQuiz, generateCustomReview, scoreQuizAnswer,
    gradeBlankPaper, scoreDiscussionAnswer
)
from routers.review import (
    createDemoSchedule, generateReviewSession, submitReviewSession
)
from routers.tools import (
    generateQuiz, runOcrOnSelection, saveQuizItems
)
from routers.whiteboard import (
    saveWhiteboard, loadWhiteboard
)

# 3. 전역 초기화 (안전장치 포함)
if not firebase_admin._apps:
    initialize_app()

# ----------------------------------------------------------------
# 4. [핵심] getUserStats (모든 의존성을 함수 내부로 격리)
# ----------------------------------------------------------------
@https_fn.on_call(region="asia-northeast3")
def getUserStats(req: https_fn.CallableRequest) -> dict:
    # 👇 [중요] 함수 안에서 import하고 초기화합니다. (충돌 원천 봉쇄)
    import firebase_admin
    from firebase_admin import firestore

    try:
        # 로그인 체크
        if not req.auth or not req.auth.uid:
            return {"level": 1, "progress": 0, "totalSolved": 0}

        user_id = req.auth.uid
        
        # DB 연결
        db = firestore.client()
        
        # 쿼리 실행
        coll = db.collection("quizItems")
        query = coll.where("userId", "==", user_id).where("reviewLevel", ">", 0)
        
        # 개수 세기 (가장 안전한 방법)
        docs = query.stream()
        solved_count = sum(1 for _ in docs)
        
        # 레벨 계산
        level = (solved_count // 10) + 1
        remainder = solved_count % 10
        progress = int((remainder / 10) * 100)

        print(f"✅ User: {user_id}, Solved: {solved_count}")

        return {
            "level": level,
            "progress": progress,
            "totalSolved": solved_count
        }

    except Exception as e:
        # 에러 로그를 명확히 남김
        print(f"🔥 getUserStats CRASH: {str(e)}")
        # 에러가 나도 '빈 값'을 줘서 프론트엔드가 멈추지 않게 함
        return {"level": 1, "progress": 0, "totalSolved": 0, "error": str(e)}