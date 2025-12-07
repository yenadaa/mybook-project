# functions/routers/quiz.py

from firebase_functions import https_fn, options
from firebase_admin import firestore
from core.config import get_db, ALLOWED_ORIGIN
import json
import os
import sys
import traceback
from openai import OpenAI

# --------------------------------------------------------
# [중요] 모듈 경로 문제 해결
# quiz_generator.py가 상위(functions/)에 있으므로 경로를 추가
# --------------------------------------------------------
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 이제 quiz_generator를 정상적으로 import 할 수 있습니다.
try:
    from quiz_generator import search_chunks_with_bm25, PreprocessedDoc, AnswerIn, score_discussion_answer
except ImportError as e:
    print(f"❌ quiz_generator import 실패: {e}")
    # 배포 시 에러가 터지지 않게 일단 넘어가지만, 실행 시 에러 날 수 있음
    pass


# --------------------------------------------------------
# 전역 변수
# --------------------------------------------------------
openai_client = None


# --------------------------------------------------------
# 헬퍼 함수
# --------------------------------------------------------
def _load_processed_doc_from_firestore(book_id: str):
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
# Cloud Functions
# --------------------------------------------------------

@https_fn.on_call(
    region="asia-northeast3",
    memory=options.MemoryOption.GB_2, 
    timeout_sec=540
)
def generateFullDocQuiz(req: https_fn.CallableRequest) -> any:
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


@https_fn.on_call(
    region="asia-northeast3",
    secrets=["OPENAI_API_KEY"], 
    memory=options.MemoryOption.GB_1
)
def generateCustomReview(req: https_fn.CallableRequest) -> any:
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


@https_fn.on_call(
    region="asia-northeast3",
    secrets=["OPENAI_API_KEY"]
)
def scoreQuizAnswer(req: https_fn.CallableRequest) -> any:
    try:
        answer_data = req.data.get("answerData")
        if not answer_data:
            raise https_fn.HttpsError("invalid-argument", "answerData가 필요합니다.")
            
        res = score_discussion_answer(AnswerIn(**answer_data), "gpt-4o-mini")
        return {"result": res.model_dump()}
    except Exception as e:
        print(f"채점 오류: {e}")
        raise https_fn.HttpsError("internal", f"채점 중 오류: {e}")


# ⭐️ [수정됨] 백지 복습 채점 (Vision + Text 로직 개선)
@https_fn.on_request(
    secrets=["OPENAI_API_KEY"],
    memory=options.MemoryOption.GB_1,
    timeout_sec=60,
    region="asia-northeast3"
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

    global openai_client
    if 'openai_client' not in globals() or openai_client is None:
        openai_client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

    try:
        data = req.get_json(silent=True)
        if not data:
             return https_fn.Response(json.dumps({"error": "No JSON data"}), status=400, headers=headers)

        book_id = data.get("bookId")
        base64_image = data.get("imageData")
        user_text_direct = data.get("userTextDirect")

        # 1. 입력값 유효성 검사 (공백 문자열 방지)
        has_valid_text = user_text_direct and str(user_text_direct).strip()

        if not base64_image and not has_valid_text:
            return https_fn.Response("Missing input (image or text)", status=400, headers=headers)

        user_text = ""

        # 2. 텍스트 우선 처리
        if has_valid_text:
            print(f"📝 [Text Mode] 사용자 입력: {str(user_text_direct)[:20]}...")
            user_text = str(user_text_direct).strip()
            
        # 3. 텍스트가 없을 때만 이미지 처리 (Vision API)
        elif base64_image:
            print("🖼️ [Image Mode] Vision API 호출")
            try:
                vision_resp = openai_client.chat.completions.create(
                    model="gpt-4o-mini", 
                    messages=[
                        {
                            "role": "user", 
                            "content": [
                                {"type": "text", "text": "이미지의 필기 내용을 텍스트로 변환해줘. 설명 없이 내용만 출력해."},
                                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{base64_image}"}}
                            ]
                        }
                    ],
                    max_tokens=800
                )
                user_text = vision_resp.choices[0].message.content.strip()
                print(f"✅ [Vision Result] {user_text[:30]}...")
            except Exception as vision_e:
                print(f"❌ Vision Error: {vision_e}")
                return https_fn.Response(json.dumps({"score": 0, "feedback": f"이미지 인식 실패: {vision_e}"}), status=200, headers=headers)
        
        if not user_text:
            return https_fn.Response(json.dumps({"score": 0, "feedback": "내용을 인식할 수 없습니다."}), status=200, headers=headers)

        # 4. RAG 검색
        target_question = data.get("targetQuestion") 
        is_hint_request = data.get("isHint", False)
        ground_truth = "관련 교재 내용 없음 (자유 서술)"

        if book_id and book_id != "null":
            try:
                doc_obj = _load_processed_doc_from_firestore(book_id)
                query_text = f"{user_text} {target_question if target_question else ''}"
                relevant_chunks = search_chunks_with_bm25(doc_obj, query_text, top_k=3)
                if relevant_chunks:
                    ground_truth = "\n\n".join([c.text for c in relevant_chunks])
            except Exception as e:
                print(f"⚠️ RAG Search Error: {e}")

        # 5. 프롬프트 및 채점
        if target_question:
            prompt = f"""
            [역할] 소크라테스식 튜터.
            [질문] {target_question}
            [답안] {user_text}
            [교재] {ground_truth}
            [지시] 답안 평가 후 정답 대신 힌트나 추가 질문 제공. 칭찬 포함.
            중요: 반드시 아래 포맷의 JSON 형식으로만 출력할 것.
            [출력 포맷(JSON)] {{ "feedback": "...", "next_question": "..." }}
            """
        elif is_hint_request:
            prompt = f"""
            [역할] 학습 도우미.
            [글] {user_text}
            [교재] {ground_truth}
            [지시] 다음 내용 방향 제시.
            중요: 반드시 아래 포맷의 JSON 형식으로만 출력할 것.
            [출력 포맷(JSON)] {{ "feedback": "...", "score": null }}
            """
        else:
            prompt = f"""
            [역할] 채점관.
            [글] {user_text}
            [교재] {ground_truth}
            [지시] 100점 만점 채점, 피드백 제공.
            중요: 반드시 아래 포맷의 JSON 형식으로만 출력할 것.
            [출력 포맷(JSON)] {{ "score": 85, "feedback": "...", "challenge_question": "..." }}
            """
        resp = openai_client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "system", "content": prompt}],
            response_format={"type": "json_object"}
        )
        result_json = json.loads(resp.choices[0].message.content)
        result_json["ocr_text"] = user_text
        
        return https_fn.Response(json.dumps(result_json), status=200, headers=headers)

    except Exception as e:
        print(f"❌ Error: {e}")
        traceback.print_exc()
        return https_fn.Response(json.dumps({"error": str(e)}), status=500, headers=headers)
    
@https_fn.on_call(
    region="asia-northeast3",
    secrets=["OPENAI_API_KEY"],
    memory=options.MemoryOption.GB_1,
    timeout_sec=60
)
# ⭐️ [핵심 2] 매개변수 타입을 CallableRequest로 변경
def scoreDiscussionAnswer(req: https_fn.CallableRequest) -> any:
    # ❌ CORS 처리는 on_call이 알아서 하므로 삭제합니다.
    
    # 1. 데이터 수신 (req.data로 바로 접근)
    question = req.data.get("question")
    user_answer = req.data.get("user_answer")
    
    if not question or not user_answer:
        raise https_fn.HttpsError(code="invalid-argument", message="문제 내용과 답안이 필요합니다.")

    # 2. 채점 로직
    try:
        # 전역 openai_client가 없다면 생성 (안전장치)
        # (상단에서 import from openai import OpenAI 확인 필요)
        client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        
        prompt = f"""
        [역할] 친절하고 꼼꼼한 선생님.
        [문제] {question}
        [학생 답안] {user_answer}
        
        [지시]
        1. 10점 만점으로 점수 매기기.
        2. 부족한 부분은 구체적으로 피드백.
        3. 잘한 점 칭찬.
        
        [출력(JSON)] {{ "score": 8, "feedback": "..." }}
        """
        
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "system", "content": "JSON output only."}, 
                      {"role": "user", "content": prompt}],
            response_format={"type": "json_object"}
        )
        
        # 3. 결과 반환 (Response 객체가 아니라 그냥 dict를 리턴하면 됩니다)
        result = json.loads(response.choices[0].message.content)
        return result

    except Exception as e:
        print(f"채점 오류: {e}")
        # 에러도 HttpsError로 던져야 프론트가 알아듣습니다.
        raise https_fn.HttpsError(code="internal", message=f"채점 실패: {e}")