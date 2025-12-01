from firebase_functions import https_fn, options
from firebase_admin import firestore # 👈 이거 없어서 에러 났던 것임
from core.config import get_db, ALLOWED_ORIGIN
import json
import os
import traceback

# --------------------------------------------------------
# 헬퍼 함수 (파일 분리하면서 없어진 것 복구)
# --------------------------------------------------------
def _load_processed_doc_from_firestore(book_id: str):
    """
    Firestore에서 책 데이터를 읽어와서 PreprocessedDoc 객체로 변환합니다.
    """
    from quiz_generator import PreprocessedDoc
    
    db = get_db()
    if not book_id:
        raise ValueError("bookId가 필요합니다.")
        
    doc_ref = db.collection("books").document(book_id)
    doc_snapshot = doc_ref.get()
    
    if not doc_snapshot.exists:
        raise ValueError(f"{book_id} 문서를 찾을 수 없습니다.")
        
    processed_data = doc_snapshot.get("processedData")
    if not processed_data:
        raise ValueError("PDF가 아직 처리되지 않았거나 데이터가 손상되었습니다.")
        
    return PreprocessedDoc(**processed_data)


# --------------------------------------------------------
# 메인 함수들
# --------------------------------------------------------

@https_fn.on_call(
    region="asia-northeast3",  # 리전 명시 (프론트엔드와 일치 필요)
    memory=options.MemoryOption.GB_2, 
    timeout_sec=300
)
def generateFullDocQuiz(req: https_fn.CallableRequest) -> https_fn.Response:
    db = get_db()
    book_id = req.data.get("bookId")
    if not book_id:
        raise https_fn.HttpsError(code="invalid-argument", message="bookId가 필요합니다.")
    
    try:
        doc_ref = db.collection("books").document(book_id)
        doc_snapshot = doc_ref.get()
        if not doc_snapshot.exists:
            raise https_fn.HttpsError(code="not-found", message="문서를 찾을 수 없습니다.")

        payload = doc_snapshot.get("baseReviewPayload")
        if not payload:
            raise https_fn.HttpsError(code="aborted", message="요약 데이터가 아직 생성되지 않았습니다.")
        
        return payload
    except Exception as e:
        print(f"Error: {e}")
        raise https_fn.HttpsError(code="internal", message=f"오류: {e}")

@https_fn.on_call(secrets=["OPENAI_API_KEY"], memory=options.MemoryOption.GB_1)
def generateCustomReview(req: https_fn.CallableRequest) -> https_fn.Response:
    db = get_db()
    book_id = req.data.get("bookId")
    if not book_id:
        raise https_fn.HttpsError(code="invalid-argument", message="bookId가 필요합니다.")
    
    try:
        doc_ref = db.collection("books").document(book_id)
        doc_snapshot = doc_ref.get()
        if not doc_snapshot.exists:
            raise https_fn.HttpsError(code="not-found", message="문서를 찾을 수 없습니다.")

        payload = doc_snapshot.get("customReviewPayload")
        if not payload:
            raise https_fn.HttpsError(code="aborted", message="퀴즈 데이터가 아직 생성되지 않았습니다.")
        
        return payload
    except Exception as e:
        print(f"Error: {e}")
        raise https_fn.HttpsError(code="internal", message=f"오류: {e}")

@https_fn.on_call(secrets=["OPENAI_API_KEY"])
def scoreQuizAnswer(req: https_fn.CallableRequest) -> https_fn.Response:
    from quiz_generator import AnswerIn, ScoreResult, score_discussion_answer
    try:
        answer_data = req.data.get("answerData")
        if not answer_data:
            raise https_fn.HttpsError("invalid-argument", "answerData가 필요합니다.")
            
        res = score_discussion_answer(AnswerIn(**answer_data), "gpt-4o-mini")
        return {"result": res.model_dump()}
    except Exception as e:
        print(f"채점 오류: {e}")
        raise https_fn.HttpsError("internal", f"채점 중 오류: {e}")

@https_fn.on_request(
    secrets=["OPENAI_API_KEY"],
    memory=options.MemoryOption.GB_1,
    timeout_sec=60
)
def gradeBlankPaper(req: https_fn.Request) -> https_fn.Response:
    # --- CORS 헤더 ---
    headers = {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN, 
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }
    if req.method == "OPTIONS":
        return https_fn.Response("", status=204, headers=headers)

    import json
    from openai import OpenAI
    from quiz_generator import search_chunks_with_bm25, PreprocessedDoc
    
    global openai_client
    if 'openai_client' not in globals() or openai_client is None:
        openai_client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

    try:
        data = req.get_json(silent=True)
        book_id = data.get("bookId")
        
        # ⭐️ [수정 1] 텍스트/이미지 입력값 확인
        base64_image = data.get("imageData")
        user_text_direct = data.get("userTextDirect") # 프론트에서 보낸 텍스트

        target_question = data.get("targetQuestion") 
        is_hint_request = data.get("isHint", False)

        # ⭐️ [수정 2] 둘 다 없으면 에러 처리
        if not base64_image and not user_text_direct:
            return https_fn.Response("Missing input (image or text)", status=400, headers=headers)

        user_text = ""

        # ⭐️ [수정 3] 텍스트가 있으면 Vision API 건너뛰기! (핵심)
        if user_text_direct:
            print("📝 [Text Mode] 사용자 타이핑 입력 감지")
            user_text = str(user_text_direct).strip()
            
        # ⭐️ [수정 4] 텍스트가 없고 이미지만 있을 때 Vision 호출
        elif base64_image:
            print("🖼️ [Image Mode] 이미지 입력 감지 -> Vision API 호출")
            try:
                vision_resp = openai_client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[
                        {
                            "role": "user", 
                            "content": [
                                {"type": "text", "text": "이미지의 필기 내용을 텍스트로 변환하세요. 잡담 없이 텍스트만 출력하세요."},
                                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{base64_image}"}}
                            ]
                        }
                    ],
                    max_tokens=500
                )
                user_text = vision_resp.choices[0].message.content.strip()
            except Exception as vision_e:
                print(f"Vision API Error: {vision_e}")
                return https_fn.Response(json.dumps({"score": 0, "feedback": "이미지 인식 실패"}), status=200, headers=headers)
        
        if not user_text:
            return https_fn.Response(json.dumps({"score": 0, "feedback": "내용을 인식할 수 없습니다."}), status=200, headers=headers)

        # 2. 정답지(RAG) 검색
        # (문서 ID가 없으면 - 즉 화이트보드 단독 모드면 - 검색 없이 진행)
        ground_truth = "관련 교재 내용 없음 (자유 서술)"
        if book_id and book_id != "null":
            try:
                doc_obj = _load_processed_doc_from_firestore(book_id)
                query_text = f"{user_text} {target_question if target_question else ''}"
                relevant_chunks = search_chunks_with_bm25(doc_obj, query_text, top_k=3)
                if relevant_chunks:
                    ground_truth = "\n\n".join([c.text for c in relevant_chunks])
            except Exception as e:
                print(f"RAG Search Error (Non-fatal): {e}")

        # 3. 프롬프트 구성 (CASE A/B/C)
        if target_question: # 소크라테스 모드
            prompt = f"""
            [역할] 소크라테스식 튜터.
            [질문] {target_question}
            [학생 답안] {user_text}
            [교재 내용] {ground_truth}
            [지시] 답안 평가 후 정답 대신 힌트나 추가 질문 제공. 칭찬 포함.
            [출력(JSON)] {{ "feedback": "...", "next_question": "..." }}
            """
        elif is_hint_request: # 힌트 모드
            prompt = f"""
            [역할] 학습 도우미.
            [학생 글] {user_text}
            [교재 내용] {ground_truth}
            [지시] 다음에 쓸 내용 방향 제시 (정답 유출 금지).
            [출력(JSON)] {{ "feedback": "...", "score": null }}
            """
        else: # 일반 채점 모드
            prompt = f"""
            [역할] 채점관.
            [학생 글] {user_text}
            [교재 원문] {ground_truth}
            [지시] 100점 만점 채점, 빠진 키워드 지적, 80점 이상 시 심화 질문.
            [출력(JSON)] {{ "score": 85, "feedback": "...", "challenge_question": "..." }}
            """

        # 4. GPT 호출
        resp = openai_client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "system", "content": prompt}],
            response_format={"type": "json_object"}
        )
        result_json = json.loads(resp.choices[0].message.content)
        result_json["ocr_text"] = user_text
        
        return https_fn.Response(json.dumps(result_json), status=200, headers=headers)

    except Exception as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=500, headers=headers)