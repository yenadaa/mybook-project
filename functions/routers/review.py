from firebase_functions import https_fn, options
from firebase_admin import firestore
from core.config import get_db
from datetime import datetime, timezone, timedelta
import random

# --------------------------------------------------------
# 헬퍼: 책 데이터에서 퀴즈 추출
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
        # 데이터 구조 파싱
        raw_list = []
        if isinstance(p, dict):
            if "items" in p: raw_list = p["items"]
            elif "quiz" in p: raw_list = p["quiz"]
            elif "review" in p: 
                # review 안에 ox, short, mcq 등이 있는 경우
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
    doc_id = req.data.get("docId") # 책(Book) ID
    title = req.data.get("title")
    force_now = req.data.get("forceNow", False)
    
    user_id = req.auth.uid
    if not user_id: return {"success": False}

    quiz_ref = db.collection("quizItems")
    
    # 1. 이미 스케줄링된 퀴즈가 있는지 확인
    existing = quiz_ref.where("bookId", "==", doc_id).where("userId", "==", user_id).limit(1).get()
    
    batch = db.batch()
    # forceNow가 True면 '지금 당장(1분 전)', 아니면 '내일'
    target_date = datetime.now(timezone.utc) - timedelta(minutes=1) if force_now else datetime.now(timezone.utc) + timedelta(days=1)

    # A. 이미 퀴즈가 DB에 있다면 -> 날짜만 당김 (재활용)
    if list(existing):
        docs = quiz_ref.where("bookId", "==", doc_id).where("userId", "==", user_id).stream()
        for d in docs:
            # 복습 차수(reviewLevel)를 하나 올려서 심화 문제인 척 함
            curr_level = d.to_dict().get("reviewLevel", 0)
            batch.update(d.reference, {
                "nextReviewDate": target_date,
                "reviewLevel": curr_level # 레벨은 유지하거나 필요시 증가
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
            
        # 최대 15개까지 저장
        selected_items = real_items[:15]
        
        for idx, item in enumerate(selected_items):
            new_ref = quiz_ref.document()
            
            # 데이터 정제
            q_text = item.get("q") or item.get("question") or "질문 내용 없음"
            ans_text = item.get("answer") or "정답 없음"
            q_type = item.get("type") or "short"
            
            batch.set(new_ref, {
                "userId": user_id,
                "bookId": doc_id,         # 책 ID (Grouping용)
                "originalDocId": doc_id,  # (호환성 유지)
                "docTitle": title,
                "question": q_text,
                "answer": ans_text,
                "type": q_type,
                "options": item.get("options", []), # 객관식 보기
                "reviewLevel": 0,
                "nextReviewDate": target_date,
                "createdAt": firestore.SERVER_TIMESTAMP
            })

    batch.commit()
    return {"success": True}


# --------------------------------------------------------
# 2. 세션 생성 및 ID 반환
# --------------------------------------------------------
@https_fn.on_call(region="asia-northeast3")
def generateReviewSession(req: https_fn.CallableRequest) -> dict:
    db = get_db()
    user_id = req.auth.uid
    if not user_id: return {"success": False, "message": "로그인 필요"}

    # 프론트엔드에서 보낸 요청 데이터 받기
    data = req.data
    target_book_id = data.get("bookId")
    target_book_ids = data.get("bookIds")
    mode = data.get("mode", "general")

    quiz_ref = db.collection('quizItems')
    
    # 1. 기본 쿼리
    query = quiz_ref.where('userId', '==', user_id)

    # 2. 필터 적용 로직
    if target_book_id:
        # 특정 책만 보기 -> bookId 필드로 검색
        query = query.where('bookId', '==', target_book_id)
        
    elif target_book_ids and isinstance(target_book_ids, list):
        if len(target_book_ids) > 0:
            query = query.where('bookId', 'in', target_book_ids[:30])
        else:
            return {"success": False, "message": "복습할 문서 목록이 비어있습니다."}
            
    else:
        # 날짜 지난거(복습 대상)
        now = datetime.now(timezone.utc)
        query = query.where('nextReviewDate', '<=', now)

    # 3. 쿼리 실행
    docs = query.stream()
    
    items = []
    for d in docs:
        item_data = d.to_dict()
        
        # 🚨 [중요 수정] 프론트엔드에서 고유 ID로 쓰기 위해
        # originalDocId 자리에 실제 DB 문서 ID(d.id)를 넣어줍니다.
        # 이렇게 해야 정답 제출 시 ID가 겹치지 않고 정확히 채점됩니다.
        item_data['originalDocId'] = d.id 
        
        # 키 이름 통일
        if "q" not in item_data and "question" in item_data:
            item_data["q"] = item_data["question"]
            
        items.append(item_data)

    # 4. 문제가 없을 때
    if not items:
        if target_book_id:
             items.append({
                "q": "아직 생성된 퀴즈가 없습니다. 문서를 분석하여 퀴즈를 만들어보세요.", 
                "type": "ox", 
                "answer": "true", 
                "originalDocId": "dummy"
            })
        else:
            return {"success": False, "message": "복습할 퀴즈가 없습니다."}

    # 5. 랜덤 섞기
    random.shuffle(items)

    # 6. 세션 저장
    session_ref = db.collection("reviewSessions").document()
    session_ref.set({
        "userId": user_id,
        "createdAt": firestore.SERVER_TIMESTAMP,
        "mode": mode,
        "targetBookId": target_book_id,
        "items": items[:20], 
        "status": "ready"
    })

    return {
        "success": True, 
        "sessionId": session_ref.id, 
        "count": len(items[:20])
    }


# --------------------------------------------------------
# 3. 퀴즈 제출 및 채점 (망각곡선 적용!)
# --------------------------------------------------------
@https_fn.on_call(region="asia-northeast3")
def submitReviewSession(req: https_fn.CallableRequest) -> dict:
    db = get_db()
    
    session_id = req.data.get("sessionId")
    user_answers = req.data.get("answers", {}) 
    
    if not session_id: return {"success": False, "message": "세션 ID 누락"}

    session_ref = db.collection("reviewSessions").document(session_id)
    session_snap = session_ref.get()
    
    if not session_snap.exists:
        return {"success": False, "message": "세션이 존재하지 않습니다."}
        
    session_data = session_snap.to_dict()
    if session_data.get("status") == "completed":
        return {"success": False, "message": "이미 제출된 퀴즈입니다."}

    items = session_data.get("items", [])
    correct_count = 0
    total_count = len(items)
    
    batch = db.batch()
    has_updates = False
    current_time = datetime.now(timezone.utc)

    for item in items:
        # Quiz Item의 DB 문서 ID
        q_doc_id = item.get("originalDocId")
        if not q_doc_id or q_doc_id == "dummy": continue
        
        # 정답 비교
        correct_answer = str(item.get("answer", "")).strip().lower()
        user_answer = str(user_answers.get(q_doc_id, "")).strip().lower()
        
        # 간단 비교 (공백 제거 등)
        is_correct = (correct_answer.replace(" ", "") == user_answer.replace(" ", ""))
        
        # DB 업데이트 준비
        q_ref = db.collection("quizItems").document(q_doc_id)
        
        if is_correct:
            correct_count += 1
            
            # 🟢 [정답] 망각곡선: 레벨업 & 날짜 미루기
            current_lvl = int(item.get("reviewLevel", 0))
            
            # 주기: 1일 -> 3일 -> 7일 -> 14일 -> 30일
            intervals = [1, 3, 7, 14, 30, 60]
            next_lvl = min(current_lvl + 1, len(intervals) - 1)
            days_to_add = intervals[next_lvl]
            
            new_date = current_time + timedelta(days=days_to_add)
            
            batch.update(q_ref, {
                "reviewLevel": next_lvl,
                "nextReviewDate": new_date,
                "lastReviewedAt": current_time,
                "isLastCorrect": True
            })
            has_updates = True
        else:
            # 🔴 [오답] 망각곡선: 초기화 (내일 다시)
            new_date = current_time + timedelta(days=1)
            batch.update(q_ref, {
                "reviewLevel": 0,
                "nextReviewDate": new_date,
                "lastReviewedAt": current_time,
                "isLastCorrect": False
            })
            has_updates = True

    # 세션 완료 처리
    score = int((correct_count / total_count) * 100) if total_count > 0 else 0
    
    batch.update(session_ref, {
        "status": "completed",
        "score": score,
        "correctCount": correct_count,
        "submittedAt": current_time,
        "userAnswers": user_answers
    })

    if has_updates:
        batch.commit()

    return {
        "success": True,
        "correctCount": correct_count,
        "totalCount": total_count,
        "score": score,
        "message": f"채점 완료! {score}점입니다."
    }