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
        if not data: return https_fn.Response(json.dumps({"error": "No JSON"}), status=400, headers=headers)

        book_id = data.get("bookId")
        base64_image = data.get("imageData")
        user_text_direct = data.get("userTextDirect")

        has_valid_text = user_text_direct and str(user_text_direct).strip()
        
        if not base64_image and not has_valid_text:
            return https_fn.Response("Missing input", status=400, headers=headers)

        user_text = ""

        # 1. Vision API 호출 (강력한 gpt-4o 사용)
        if has_valid_text:
            print(f"📝 [Input] Text Mode: {str(user_text_direct)[:30]}...")
            user_text = str(user_text_direct).strip()
        elif base64_image:
            print("🖼️ [Input] Image Mode -> Vision API (GPT-4o) 호출")
            try:
                # ⭐️ [핵심 1] gpt-4o-mini -> gpt-4o 변경 (인식률 대폭 상승)
                vision_resp = openai_client.chat.completions.create(
                    model="gpt-4o", 
                    messages=[
                        {
                            "role": "user", 
                            "content": [
                                {"type": "text", "text": "이 이미지에 손으로 쓴 글씨가 있습니다. 내용을 빠짐없이 텍스트로 변환해주세요. 그림이나 도표는 '[도표]'라고만 표시하고 텍스트 위주로 읽어주세요."},
                                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{base64_image}"}}
                            ]
                        }
                    ],
                    max_tokens=1000
                )
                user_text = vision_resp.choices[0].message.content.strip()
                print(f"✅ [OCR Success] 인식된 텍스트: {user_text}") # 로그 꼭 확인하세요!
            except Exception as vision_e:
                print(f"❌ Vision Error: {vision_e}")
                return https_fn.Response(json.dumps({"score": 0, "feedback": f"이미지 인식 오류: {vision_e}"}), status=200, headers=headers)
        
        if not user_text:
            return https_fn.Response(json.dumps({"score": 0, "feedback": "글씨를 인식하지 못했습니다. 더 또렷하게 써주세요."}), status=200, headers=headers)

        # 2. RAG 검색 (범위 확대)
        target_question = data.get("targetQuestion") 
        is_hint_request = data.get("isHint", False)
        ground_truth = ""

        if book_id and book_id != "null":
            try:
                doc_obj = _load_processed_doc_from_firestore(book_id)
                
                # 검색어 구성: 질문 + 사용자 답변 (키워드 매칭 확률 높임)
                query_text = f"{target_question if target_question else ''} {user_text}"
                
                # ⭐️ [핵심 2] top_k 3 -> 15 (관련 내용 찾을 확률 높임)
                relevant_chunks = search_chunks_with_bm25(doc_obj, query_text, top_k=15)
                
                if relevant_chunks:
                    ground_truth = "\n\n".join([f"[발췌 {i+1}] {c.text}" for i, c in enumerate(relevant_chunks)])
                    print(f"📚 [RAG Success] 관련 청크 {len(relevant_chunks)}개 찾음.")
                else:
                    print("⚠️ [RAG Warning] 관련 내용을 찾지 못함.")
            except Exception as e:
                print(f"❌ RAG Error: {e}")

        # 3. 채점/피드백 생성
        # RAG 데이터가 없으면 없다고 AI에게 알려줌
        context_prompt = f"참고할 교재 내용:\n{ground_truth}" if ground_truth else "참고할 교재 내용이 검색되지 않았습니다. 일반적인 지식으로 판단하세요."

        if target_question:
            prompt = f"""
            [역할] 소크라테스식 튜터.
            [질문] {target_question}
            [학생 답안] {user_text}
            [교재 컨텍스트] {context_prompt}
            
            [지시] 
            1. 학생의 답안이 교재 내용과 일치하는지 확인하세요.
            2. 교재에 있는 내용은 구체적으로 인용하며 피드백하세요.
            3. 정답을 바로 알려주지 말고, 힌트나 추가 질문을 던지세요.
            
            ⭐️중요: JSON Key는 영어(feedback, next_question)로, 내용은 한국어로 작성.
            [출력(JSON)] {{ "feedback": "...", "next_question": "..." }}
            """
        elif is_hint_request:
            prompt = f"""
            [역할] 친절한 학습 조교.
            [학생 글] {user_text}
            [교재 컨텍스트] {context_prompt}
            
            [지시] 
            1. 학생이 쓰고 있는 내용이 교재의 어느 부분인지 파악하세요.
            2. 다음에 이어질 내용을 교재에 기반하여 힌트로 주세요.
            
            ⭐️중요: JSON Key는 영어(feedback)로, 내용은 한국어로 작성.
            [출력(JSON)] {{ "feedback": "...", "score": null }}
            """
        else:
            prompt = f"""
            [역할] 꼼꼼한 채점관.
            [학생 글] {user_text}
            [교재 컨텍스트] {context_prompt}
            
            [지시]
            1. 학생이 쓴 내용이 교재의 핵심 내용과 일치하는지 분석하세요.
            2. 점수 대신 '잘한 점'과 '보완할 점'을 명확히 나누어 주세요.
            3. 교재에 있지만 학생이 빠트린 키워드가 있다면 '보완할 점'에 언급하세요.
            
            ⭐️중요: JSON Key는 영어(feedback, good_points, weak_points, challenge_question)로, 내용은 한국어로 작성.
            [출력(JSON)] 
            {{ 
                "feedback": "총평...", 
                "good_points": "- ...", 
                "weak_points": "- ...", 
                "challenge_question": "..." 
            }}
            """

        resp = openai_client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "system", "content": prompt}],
            response_format={"type": "json_object"}
        )
        result_json = json.loads(resp.choices[0].message.content)
        
        # 디버깅용: 인식된 텍스트를 피드백 앞부분에 살짝 붙여서 보내줌 (확인용)
        # 나중에 잘 되면 이 줄은 삭제하세요.
        # result_json["feedback"] = f"[인식된 텍스트: {user_text}] \n\n" + result_json.get("feedback", "")
        
        return https_fn.Response(json.dumps(result_json), status=200, headers=headers)

    except Exception as e:
        print(f"❌ Critical Error: {e}")
        traceback.print_exc()
        return https_fn.Response(json.dumps({"error": str(e)}), status=500, headers=headers)