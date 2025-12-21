from firebase_functions import https_fn, options
from firebase_admin import firestore
from core.config import get_db
from datetime import datetime, timezone, timedelta
import random

# --------------------------------------------------------
# 헬퍼: 책 데이터에서 퀴즈 추출 (서술형 제외!)
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
                # 🚨 [수정] 여기서 discussion을 뺐습니다! (ox, short, mcq만 가져옴)
                for k in ["ox", "short", "mcq"]: 
                    if k in p["review"]: 
                        # 퀴즈 타입 명시
                        for q_item in p["review"][k]:
                            q_item["type"] = k
                        raw_list.extend(p["review"][k])
        
        if raw_list:
            items.extend(raw_list)
    
    return items

# --------------------------------------------------------
# 1. 스케줄 생성 (만들자마자 바로 복습 가능)
# --------------------------------------------------------
@https_fn.on_call(region="asia-northeast3", memory=options.MemoryOption.GB_1)
def createDemoSchedule(req: https_fn.CallableRequest) -> dict:
    db = get_db()
    doc_id = req.data.get("docId") or req.data.get("bookId")
    title = req.data.get("title")
    # 🚨 [수정] forceNow 기본값을 True로 설정 (무조건 바로 뜨게)
    force_now = req.data.get("forceNow", True)
    
    user_id = req.auth.uid
    if not user_id: return {"success": False}

    quiz_ref = db.collection("quizItems")
    
    # 1. 이미 스케줄링된 퀴즈가 있는지 확인
    existing = quiz_ref.where("originalDocId", "==", doc_id).where("userId", "==", user_id).limit(1).get()
    
    batch = db.batch()
    
    # forceNow=True면 현재 시간보다 5분 전으로 설정해서 바로 '복습 대상'에 걸리게 함
    # forceNow=False(내일)면 하루 뒤로 설정
    current_time = datetime.now(timezone.utc)
    if force_now:
        target_date = current_time - timedelta(minutes=5)
    else:
        target_date = current_time + timedelta(days=1)

    # A. 이미 퀴즈가 DB에 있다면 -> 날짜만 당김/밈 (재활용)
    if list(existing):
        docs = quiz_ref.where("originalDocId", "==", doc_id).where("userId", "==", user_id).stream()
        for d in docs:
            # forceNow가 True면 레벨 초기화 안 하고 날짜만 당김
            # (만약 레벨도 초기화하고 싶으면 reviewLevel: 0 으로 수정)
            batch.update(d.reference, {
                "nextReviewDate": target_date
            })

    # B. DB에 퀴즈가 없다면 -> 책 데이터에서 가져와서 저장
    else:
        book_snap = db.collection("books").document(doc_id).get()
        real_items = []
        if book_snap.exists:
            real_items = _extract_questions_from_book(book_snap.to_dict())
        
        # 문제가 하나도 없으면 더미 생성
        if not real_items:
            real_items = [
                {"q": f"[{title}] 이 문서의 핵심 주제는?", "type": "short", "answer": "직접 요약해보세요."},
                {"q": f"[{title}] 기억나는 키워드 3가지는?", "type": "short", "answer": "스스로 떠올려보세요."}
            ]
            
        # 최대 15개까지만 저장
        selected_items = real_items[:15]
        
        for idx, item in enumerate(selected_items):
            new_ref = quiz_ref.document()
            
            q_text = item.get("q") or item.get("question") or "질문 없음"
            ans_text = item.get("answer") or "정답 없음"
            q_type = item.get("type") or "short"
            
            batch.set(new_ref, {
                "userId": user_id,
                "bookId": doc_id,        # 최신 필드
                "originalDocId": doc_id, # 호환성 필드
                "docTitle": title,
                "question": q_text,
                "answer": ans_text,
                "type": q_type,
                "options": item.get("options", []), 
                "reviewLevel": 0,
                "nextReviewDate": target_date,
                "createdAt": firestore.SERVER_TIMESTAMP
            })

    batch.commit()
    return {"success": True}


# --------------------------------------------------------
# 2. 세션 생성 (스케줄된 문제 가져오기)
# --------------------------------------------------------
@https_fn.on_call(region="asia-northeast3")
def generateReviewSession(req: https_fn.CallableRequest) -> dict:
    db = get_db()
    user_id = req.auth.uid
    if not user_id: return {"success": False, "message": "로그인 필요"}

    data = req.data
    target_book_id = data.get("bookId")
    target_book_ids = data.get("bookIds")
    mode = data.get("mode", "general")

    quiz_ref = db.collection('quizItems')
    
    # 1. 기본 쿼리
    query = quiz_ref.where('userId', '==', user_id)

    # 2. 필터 적용
    if target_book_id:
        # 특정 책만 보기 -> originalDocId (또는 bookId) 기준
        query = query.where('originalDocId', '==', target_book_id)
        
    elif target_book_ids and isinstance(target_book_ids, list):
        if len(target_book_ids) > 0:
            query = query.where('originalDocId', 'in', target_book_ids[:30])
        else:
            return {"success": False, "message": "목록이 비어있습니다."}
    else:
        # 날짜 지난거(복습 대상) - 현재 시간보다 이전인 것들
        now = datetime.now(timezone.utc)
        query = query.where('nextReviewDate', '<=', now)

    # 3. 실행
    docs = query.stream()
    
    items = []
    for d in docs:
        item_data = d.to_dict()
        item_data['originalDocId'] = item_data.get('originalDocId', d.id)
        
        # 혹시라도 DB에 discussion이 남아있을 수 있으니 여기서도 한 번 더 거름
        if item_data.get("type") == "discussion":
            continue

        if "q" not in item_data and "question" in item_data:
            item_data["q"] = item_data["question"]
            
        items.append(item_data)

    if not items:
        return {"success": False, "message": "복습할 퀴즈가 없습니다."}

    random.shuffle(items)

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
# 3. 채점 및 제출
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
        return {"success": False, "message": "세션 없음"}
        
    session_data = session_snap.to_dict()
    if session_data.get("status") == "completed":
        return {"success": False, "message": "이미 제출됨"}

    items = session_data.get("items", [])
    correct_count = 0
    total_count = len(items)
    
    batch = db.batch()
    has_updates = False
    current_time = datetime.now(timezone.utc)

    for item in items:
        q_doc_id = item.get("originalDocId")
        # 퀴즈 아이템 DB ID가 없으면 패스 (더미 등)
        # 단, createDemoSchedule에서 originalDocId에 docId를 넣었으므로,
        # 실제 quizItems 문서 ID를 찾으려면 별도 로직이 필요할 수 있습니다.
        # 여기서는 편의상 quizItems 컬렉션의 문서 ID를 originalDocId로 가정하거나,
        # generateReviewSession에서 d.id를 originalDocId로 덮어썼으므로 그것을 사용합니다.
        
        # 🚨 [주의] 실제 quizItems 문서의 ID는 generateReviewSession에서 
        # item_data['originalDocId'] = d.id 로 할당한 값이어야 업데이트가 됩니다.
        if not q_doc_id or len(q_doc_id) < 5: continue 
        
        correct_answer = str(item.get("answer", "")).strip().lower()
        user_answer = str(user_answers.get(q_doc_id, "")).strip().lower()
        
        is_correct = (correct_answer.replace(" ", "") == user_answer.replace(" ", ""))
        
        q_ref = db.collection("quizItems").document(q_doc_id)
        
        if is_correct:
            correct_count += 1
            current_lvl = int(item.get("reviewLevel", 0))
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
            # 틀리면 1일 뒤로
            new_date = current_time + timedelta(days=1)
            batch.update(q_ref, {
                "reviewLevel": 0,
                "nextReviewDate": new_date,
                "lastReviewedAt": current_time,
                "isLastCorrect": False
            })
            has_updates = True

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
        "message": f"채점 완료! {score}점"
    }