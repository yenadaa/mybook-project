from firebase_functions import https_fn, options
from firebase_admin import firestore
from core.config import get_db
from datetime import datetime, timezone, timedelta

# 1. 스케줄 시간 조작 (기존 유지)
@https_fn.on_call(region="asia-northeast3", memory=options.MemoryOption.GB_1)
def createDemoSchedule(req: https_fn.CallableRequest) -> dict:
    db = get_db()
    doc_id = req.data.get("docId")
    title = req.data.get("title")
    user_id = req.auth.uid
    if not user_id: return {"success": False}

    # 퀴즈 없으면 더미 생성, 있으면 시간 당기기
    quiz_ref = db.collection("quizItems")
    existing = quiz_ref.where("originalDocId", "==", doc_id).where("userId", "==", user_id).limit(1).get()
    
    batch = db.batch()
    # 무조건 복습 대상이 되도록 1분 전으로 설정
    target_date = datetime.now(timezone.utc) - timedelta(minutes=1)

    if not list(existing):
        for i in range(1, 4):
            new_ref = quiz_ref.document()
            batch.set(new_ref, {
                "userId": user_id, "originalDocId": doc_id, "docTitle": title,
                "question": f"[{title}] 시연용 퀴즈 {i}", "answer": "정답",
                "reviewLevel": 0, "nextReviewDate": target_date,
                "createdAt": firestore.SERVER_TIMESTAMP
            })
    else:
        docs = quiz_ref.where("originalDocId", "==", doc_id).where("userId", "==", user_id).stream()
        for d in docs:
            batch.update(d.reference, {"nextReviewDate": target_date})

    batch.commit()
    return {"success": True}

# 2. [핵심] 세션 즉시 생성 및 ID 반환 (알림 X, 링크용)
@https_fn.on_call(region="asia-northeast3")
def testTriggerNotifications(req: https_fn.CallableRequest) -> dict:
    db = get_db()
    user_id = req.auth.uid
    if not user_id: return {"success": False, "message": "로그인 필요"}

    # 1. 복습할 문제 긁어오기 (시간 지난 것들)
    now = datetime.now(timezone.utc)
    docs = db.collection('quizItems').where('userId', '==', user_id).where('nextReviewDate', '<=', now).stream()
    
    items = []
    for d in docs:
        data = d.to_dict()
        data['originalDocId'] = d.id
        items.append(data)
    
    # 만약 없으면? 시연 망하니까 가짜라도 하나 넣어서 보냄
    if not items:
        items.append({
            "question": "시연용 비상 퀴즈입니다.", "type": "ox", "answer": "true", "originalDocId": "dummy"
        })

    # 2. 세션 만들기
    session_ref = db.collection("reviewSessions").document()
    session_ref.set({
        "userId": user_id,
        "createdAt": firestore.SERVER_TIMESTAMP,
        "items": items[:10], # 최대 10개
        "status": "ready"
    })

    # 3. ID 바로 리턴! (이걸로 프론트가 이동함)
    return {
        "success": True, 
        "sessionId": session_ref.id, 
        "count": len(items)
    }