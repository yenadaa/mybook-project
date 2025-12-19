from firebase_functions import https_fn, options
from firebase_admin import firestore
from core.config import get_db
from datetime import datetime, timezone, timedelta
import random

# --------------------------------------------------------
# 헬퍼: 책 데이터에서 퀴즈 추출 (구조가 제각각이라 통일 필요)
# --------------------------------------------------------
def _extract_questions_from_book(book_data):
    items = []
    # 1. 하이라이트 퀴즈 (customReviewPayload) 우선 검색
    payloads = [
        book_data.get("customReviewPayload"),
        book_data.get("baseReviewPayload")
    ]
    
    for p in payloads:
        if not p: continue
        # 데이터 구조 파싱 (items, quiz, review 키 등 다양함)
        raw_list = []
        if isinstance(p, dict):
            if "items" in p: raw_list = p["items"]
            elif "quiz" in p: raw_list = p["quiz"]
            elif "review" in p: 
                # review 안에 ox, short 등이 있는 경우
                for k in ["ox", "short", "mcq", "discussion"]:
                    if k in p["review"]: raw_list.extend(p["review"][k])
        
        if raw_list:
            items.extend(raw_list)
    
    return items

# --------------------------------------------------------
# 1. 스케줄 생성 (진짜 문제 기반 + 난이도 부여)
# --------------------------------------------------------
@https_fn.on_call(region="asia-northeast3", memory=options.MemoryOption.GB_1)
def createDemoSchedule(req: https_fn.CallableRequest) -> dict:
    db = get_db()
    doc_id = req.data.get("docId")
    title = req.data.get("title")
    force_now = req.data.get("forceNow", False)
    
    user_id = req.auth.uid
    if not user_id: return {"success": False}

    quiz_ref = db.collection("quizItems")
    
    # 1. 이미 스케줄링된 퀴즈가 있는지 확인
    existing = quiz_ref.where("originalDocId", "==", doc_id).where("userId", "==", user_id).limit(1).get()
    
    batch = db.batch()
    # forceNow가 True면 '지금 당장(1분 전)', 아니면 '내일'
    target_date = datetime.now(timezone.utc) - timedelta(minutes=1) if force_now else datetime.now(timezone.utc) + timedelta(days=1)

    # A. 이미 퀴즈가 DB에 있다면 -> 날짜만 당김 (재활용)
    if list(existing):
        docs = quiz_ref.where("originalDocId", "==", doc_id).where("userId", "==", user_id).stream()
        for d in docs:
            # 복습 차수(reviewLevel)를 하나 올려서 심화 문제인 척 함
            curr_level = d.to_dict().get("reviewLevel", 0)
            batch.update(d.reference, {
                "nextReviewDate": target_date,
                "reviewLevel": curr_level + 1  # 레벨 업!
            })

    # B. DB에 퀴즈가 없다면 -> 책 데이터에서 '진짜 퀴즈' 복사해옴
    else:
        # 책 정보 가져오기
        book_snap = db.collection("books").document(doc_id).get()
        real_items = []
        if book_snap.exists:
            real_items = _extract_questions_from_book(book_snap.to_dict())
        
        # 진짜 문제도 없으면? 어쩔 수 없이 더미 (방어 코드)
        if not real_items:
            real_items = [
                {"q": f"[{title}] 이 문서의 핵심 주제는?", "type": "short", "answer": "직접 요약해보세요."},
                {"q": f"[{title}] 내용 중 가장 중요한 키워드는?", "type": "short", "answer": "직접 찾아보세요."}
            ]
            
        # 최대 5개만 추출해서 저장
        selected_items = real_items[:5]
        
        for idx, item in enumerate(selected_items):
            new_ref = quiz_ref.document()
            
            # [핵심] 난이도/유형 시뮬레이션
            # 1~2번은 '핵심', 3번부터는 '심화/응용'으로 태깅
            difficulty = "normal"
            if idx >= 2: difficulty = "hard" 
            
            # 데이터 정제 (q, question 키 통일)
            q_text = item.get("q") or item.get("question") or "질문 내용 없음"
            ans_text = item.get("answer") or "정답 없음"
            q_type = item.get("type") or "short"
            
            batch.set(new_ref, {
                "userId": user_id,
                "originalDocId": doc_id,
                "docTitle": title,
                "question": q_text,
                "answer": ans_text,
                "type": q_type,
                "options": item.get("options", []), # 객관식 보기
                "reviewLevel": 1 if difficulty == "hard" else 0, # 레벨 설정
                "difficulty": difficulty, # 프론트 표시용
                "nextReviewDate": target_date,
                "createdAt": firestore.SERVER_TIMESTAMP
            })

    batch.commit()
    return {"success": True}


# --------------------------------------------------------
# 2. 세션 생성 및 ID 반환
# --------------------------------------------------------
@https_fn.on_call(region="asia-northeast3")
def testTriggerNotifications(req: https_fn.CallableRequest) -> dict:
    db = get_db()
    user_id = req.auth.uid
    if not user_id: return {"success": False, "message": "로그인 필요"}

    # 복습 대상 가져오기
    now = datetime.now(timezone.utc)
    docs = db.collection('quizItems').where('userId', '==', user_id).where('nextReviewDate', '<=', now).stream()
    
    items = []
    for d in docs:
        data = d.to_dict()
        data['originalDocId'] = d.id # 퀴즈 아이템의 ID
        
        # 프론트엔드가 q/question 둘 다 처리하도록 키 정리
        if "q" not in data and "question" in data:
            data["q"] = data["question"]
            
        items.append(data)
    
    if not items:
        # 비상용 더미
        items.append({
            "q": "복습할 문제가 아직 생성되지 않았습니다.", 
            "type": "ox", 
            "answer": "true", 
            "originalDocId": "dummy"
        })

    # 세션 생성
    session_ref = db.collection("reviewSessions").document()
    session_ref.set({
        "userId": user_id,
        "createdAt": firestore.SERVER_TIMESTAMP,
        "items": items[:10],
        "status": "ready"
    })

    return {
        "success": True, 
        "sessionId": session_ref.id, 
        "count": len(items)
    }