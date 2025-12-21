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
    force_now = req.data.get("forceNow", True)
    
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
def generateReviewSession(req: https_fn.CallableRequest) -> dict:
    db = get_db()
    user_id = req.auth.uid
    if not user_id: return {"success": False, "message": "로그인 필요"}

    # 프론트엔드에서 보낸 요청 데이터 받기
    data = req.data
    target_book_id = data.get("bookId")   # 단일 책 ID (문서 하나만 볼 때)
    target_book_ids = data.get("bookIds") # 책 ID 리스트 (오늘의 복습용)
    mode = data.get("mode", "general")    # 모드 (single_doc, daily_mix 등)

    quiz_ref = db.collection('quizItems')
    
    # 1. 기본 쿼리: 내 문제들 가져오기
    query = quiz_ref.where('userId', '==', user_id)

    # 2. 필터 적용 로직
    if target_book_id:
        # [Case A] 특정 책 하나만 보기 (날짜 상관없이 강제 복습)
        # "이 책(target_book_id)에 해당하는 문제만 가져와!"
        query = query.where('originalDocId', '==', target_book_id)
        
    elif target_book_ids and isinstance(target_book_ids, list):
        # [Case B] 오늘의 복습 (프론트에서 선별한 리스트)
        # "이 리스트(target_book_ids)에 포함된 문제만 가져와!"
        # 주의: Firestore 'in' 쿼리는 최대 30개까지만 가능
        if len(target_book_ids) > 0:
            query = query.where('originalDocId', 'in', target_book_ids[:30])
        else:
            return {"success": False, "message": "복습할 문서 목록이 비어있습니다."}
            
    else:
        # [Case C] 기존 방식 (날짜 지난거 아무거나 다)
        now = datetime.now(timezone.utc)
        query = query.where('nextReviewDate', '<=', now)

    # 3. 쿼리 실행
    docs = query.stream()
    
    items = []
    for d in docs:
        item_data = d.to_dict()
        item_data['originalDocId'] = item_data.get('originalDocId', d.id) # 원본 문서 ID 안전하게 확보
        
        # 키 이름 통일 (q vs question)
        if "q" not in item_data and "question" in item_data:
            item_data["q"] = item_data["question"]
            
        items.append(item_data)

    # 4. 문제가 없을 때 (예외 처리)
    if not items:
        # 단일 문서 모드인데 문제가 없다면 -> 문제를 즉석에서 생성 시도하거나 더미 반환
        if target_book_id:
             items.append({
                "q": "아직 생성된 퀴즈가 없습니다. 문서를 분석하여 퀴즈를 만들어보세요.", 
                "type": "ox", 
                "answer": "true", 
                "originalDocId": target_book_id
            })
        else:
            return {"success": False, "message": "생성할 퀴즈 데이터가 없습니다."}

    # 5. 문제 섞기 (랜덤)
    random.shuffle(items)

    # 6. 세션 저장 (최대 20문제까지만)
    session_ref = db.collection("reviewSessions").document()
    session_ref.set({
        "userId": user_id,
        "createdAt": firestore.SERVER_TIMESTAMP,
        "mode": mode,
        "targetBookId": target_book_id, # 나중에 분석용
        "items": items[:20], 
        "status": "ready"
    })

    return {
        "success": True, 
        "sessionId": session_ref.id, 
        "count": len(items[:20])
    }


@https_fn.on_call(region="asia-northeast3")
def submitReviewSession(req: https_fn.CallableRequest) -> dict:
    db = get_db()
    
    # 1. 데이터 검증
    session_id = req.data.get("sessionId")
    user_answers = req.data.get("answers", {})  # { "문서ID": "사용자답", ... }
    
    if not session_id: return {"success": False, "message": "세션 ID 누락"}

    session_ref = db.collection("reviewSessions").document(session_id)
    session_snap = session_ref.get()
    
    if not session_snap.exists:
        return {"success": False, "message": "세션이 존재하지 않습니다."}
        
    session_data = session_snap.to_dict()
    if session_data.get("status") == "completed":
        return {"success": False, "message": "이미 제출된 퀴즈입니다."}

    # 2. 채점 및 망각곡선 업데이트
    items = session_data.get("items", [])
    correct_count = 0
    total_count = len(items)
    
    # 배치 쓰기(Batch Write)를 사용해 DB 업데이트 효율을 높입니다.
    batch = db.batch()
    has_updates = False
    
    current_time = datetime.now(timezone.utc)

    for item in items:
        # 문제 ID (quizItems 컬렉션의 문서 ID여야 함)
        # 주의: generateReviewSession에서 d.id를 originalDocId나 id 필드에 담아줬어야 정확히 업데이트 됩니다.
        q_doc_id = item.get("originalDocId") 
        
        # 정답 비교
        correct_answer = str(item.get("answer", "")).strip().lower()
        user_answer = str(user_answers.get(q_doc_id, "")).strip().lower()
        
        is_correct = (correct_answer == user_answer)
        
        # 퀴즈 원본 문서 참조 (quizItems 컬렉션)
        q_ref = db.collection("quizItems").document(q_doc_id)
        
        if is_correct:
            correct_count += 1
            
            # 🟢 [정답] 망각곡선: 레벨업 & 날짜 미루기
            current_lvl = int(item.get("reviewLevel", 0))
            
            # 복습 주기 (일 단위): 1일 -> 3일 -> 7일 -> 14일 -> 30일 -> 60일
            intervals = [1, 3, 7, 14, 30, 60]
            
            # 다음 레벨 (최대 레벨을 넘지 않게)
            next_lvl = min(current_lvl + 1, len(intervals) - 1)
            days_to_add = intervals[next_lvl]
            
            new_date = current_time + timedelta(days=days_to_add)
            
            # 배치에 업데이트 추가
            batch.update(q_ref, {
                "reviewLevel": next_lvl,
                "nextReviewDate": new_date,
                "lastReviewedAt": current_time,
                "isLastCorrect": True
            })
            has_updates = True

        else:
            # 🔴 [오답] 망각곡선: 레벨 초기화 & 내일 다시 복습
            # 틀리면 0단계(1일 뒤)로 돌아갑니다.
            new_date = current_time + timedelta(days=1)
            
            batch.update(q_ref, {
                "reviewLevel": 0,
                "nextReviewDate": new_date,
                "lastReviewedAt": current_time,
                "isLastCorrect": False
            })
            has_updates = True

    # 3. 점수 계산 및 세션 완료 처리
    score = int((correct_count / total_count) * 100) if total_count > 0 else 0
    
    # 세션 상태 업데이트 (완료 처리)
    batch.update(session_ref, {
        "status": "completed",
        "score": score,
        "correctCount": correct_count,
        "submittedAt": current_time,
        "userAnswers": user_answers
    })

    # 모든 업데이트 한 번에 실행
    if has_updates:
        try:
            batch.commit()
            print(f"✅ 채점 완료: {correct_count}/{total_count} (업데이트 완료)")
        except Exception as e:
            print(f"❌ DB 업데이트 실패: {e}")
            # 배치가 실패해도 채점 결과는 사용자에게 보여주기 위해 에러를 무시하고 반환할 수도 있음

    return {
        "success": True,
        "correctCount": correct_count,
        "totalCount": total_count,
        "score": score,
        "message": f"수고하셨습니다! {score}점입니다.\n결과에 따라 복습 일정이 조정되었습니다."
    }