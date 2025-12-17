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
# --------------------------------------------------------
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    # score_discussion_answer 등 필요한 함수 모두 import
    from quiz_generator import search_chunks_with_bm25, PreprocessedDoc, Chunk, AnswerIn, generate_base_review, generate_custom_review, score_discussion_answer
except ImportError as e:
    pass

# --------------------------------------------------------
# 전역 변수
# --------------------------------------------------------
openai_client = None

# --------------------------------------------------------
# 💎 [핵심] 만능 데이터 로더 (폴더/파일 통합 지원)
# --------------------------------------------------------
def _load_doc_data(data_payload):
    """
    bookId가 오면 파일 1개, folderId가 오면 폴더 내 모든 파일을 합쳐서 반환
    """
    db = get_db()
    book_id = data_payload.get("bookId")
    folder_id = data_payload.get("folderId")

    # 1. 단일 파일 모드
    if book_id:
        doc_snap = db.collection("books").document(book_id).get()
        if doc_snap.exists and doc_snap.get("processedData"):
            return PreprocessedDoc(**doc_snap.get("processedData"))
            
    # 2. 폴더 통합 모드
    elif folder_id:
        docs = db.collection("books").where("folderId", "==", folder_id).stream()
        all_chunks = []
        found_count = 0
        
        for d in docs:
            data = d.to_dict()
            p_data = data.get("processedData")
            title = data.get("title", "Unknown")
            
            if p_data and "chunks" in p_data:
                found_count += 1
                for c_data in p_data["chunks"]:
                    try:
                        if "metadata" not in c_data: c_data["metadata"] = {}
                        c_data["metadata"]["source_book"] = title
                        all_chunks.append(Chunk(**c_data))
                    except: pass
        
        if all_chunks:
            print(f"📂 [Folder Mode] {found_count}권 병합 완료 ({len(all_chunks)} chunks)")
            return PreprocessedDoc(doc_id=f"folder_{folder_id}", chunks=all_chunks)
            
    raise ValueError("유효한 문서 데이터(bookId 또는 folderId)를 찾을 수 없습니다.")


# --------------------------------------------------------
# Cloud Functions
# --------------------------------------------------------

@https_fn.on_call(
    region="asia-northeast3",
    memory=options.MemoryOption.GB_2, 
    timeout_sec=540
)
def generateFullDocQuiz(req: https_fn.CallableRequest) -> any:
    try:
        doc_obj = _load_doc_data(req.data)
        # 퀴즈 생성
        output = generate_base_review(doc_obj, model="gpt-4o-mini")
        return output.dict()
    except Exception as e:
        print(f"Quiz Gen Error: {e}")
        raise https_fn.HttpsError(code="internal", message=f"오류: {e}")


@https_fn.on_call(
    region="asia-northeast3",
    secrets=["OPENAI_API_KEY"], 
    memory=options.MemoryOption.GB_1
)
def generateCustomReview(req: https_fn.CallableRequest) -> any:
    try:
        doc_obj = _load_doc_data(req.data)
        review_out = generate_custom_review(
            doc=doc_obj,
            counts_override={"ox": 3, "short": 3, "discussion": 3},
            model="gpt-4o-mini"
        )
        return {"review": review_out.dict()}
    except Exception as e:
        print(f"Custom Quiz Error: {e}")
        raise https_fn.HttpsError(code="internal", message=f"오류: {e}")


# ⭐️ [복구됨] 기존 퀴즈 채점 함수 (main.py에서 찾고 있어서 복구)
@https_fn.on_call(
    region="asia-northeast3",
    secrets=["OPENAI_API_KEY"]
)
def scoreQuizAnswer(req: https_fn.CallableRequest) -> any:
    try:
        answer_data = req.data.get("answerData")
        if not answer_data:
            raise https_fn.HttpsError("invalid-argument", "answerData가 필요합니다.")
            
        # quiz_generator의 함수 사용
        res = score_discussion_answer(AnswerIn(**answer_data), "gpt-4o-mini")
        return {"result": res.model_dump()}
    except Exception as e:
        print(f"채점 오류: {e}")
        raise https_fn.HttpsError("internal", f"채점 중 오류: {e}")


# ⭐️ [수정됨] 백지 복습 채점 (한글 강제 + 폴더 지원 + Vision)
@https_fn.on_request(
    secrets=["OPENAI_API_KEY"],
    memory=options.MemoryOption.GB_1,
    timeout_sec=60,
    region="asia-northeast3"
)
def gradeBlankPaper(req: https_fn.Request) -> https_fn.Response:
    # CORS
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
        if not data: return https_fn.Response(json.dumps({"error": "No JSON data"}), status=400, headers=headers)

        book_id = data.get("bookId")
        folder_id = data.get("folderId")
        base64_image = data.get("imageData")
        user_text_direct = data.get("userTextDirect")

        # 1. 텍스트 추출
        user_text = ""
        if user_text_direct and str(user_text_direct).strip():
            user_text = str(user_text_direct).strip()
        elif base64_image:
            try:
                # Vision API 호출
                vision_resp = openai_client.chat.completions.create(
                    model="gpt-4o-mini", 
                    messages=[
                        {
                            "role": "user", 
                            "content": [
                                {"type": "text", "text": "이미지의 필기 내용을 텍스트로 변환해줘. 설명 없이 내용만 출력해. (Korean Only if possible)"},
                                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{base64_image}"}}
                            ]
                        }
                    ],
                    max_tokens=800
                )
                user_text = vision_resp.choices[0].message.content.strip()
            except Exception as vision_e:
                return https_fn.Response(json.dumps({"score": 0, "feedback": f"이미지 인식 실패: {vision_e}"}), status=200, headers=headers)
        
        if not user_text:
            return https_fn.Response(json.dumps({"score": 0, "feedback": "내용을 인식할 수 없습니다."}), status=200, headers=headers)

        # 2. RAG 검색 (폴더/파일 통합 로더 사용)
        target_question = data.get("targetQuestion") 
        is_hint_request = data.get("isHint", False)
        ground_truth = "관련 교재 내용 없음"

        try:
            doc_obj = _load_doc_data({"bookId": book_id, "folderId": folder_id})
            query_text = f"{user_text} {target_question if target_question else ''}"
            relevant_chunks = search_chunks_with_bm25(doc_obj, query_text, top_k=3)
            if relevant_chunks:
                ground_truth = "\n\n".join([c.text for c in relevant_chunks])
        except Exception as e:
            print(f"⚠️ RAG Search Error: {e}")

        # 3. 프롬프트 생성 (🇰🇷 한국어 강제)
        if target_question:
            prompt = f"""
            [역할] 소크라테스식 튜터.
            [언어] **반드시 한국어(Korean)로만 답변할 것.**
            [질문] {target_question}
            [답안] {user_text}
            [교재] {ground_truth}
            [지시] 답안 평가 후 정답 대신 힌트나 추가 질문 제공. 칭찬 포함.
            [출력(JSON)] {{ "feedback": "...", "next_question": "..." }}
            """
        elif is_hint_request:
            prompt = f"""
            [역할] 학습 도우미.
            [언어] **반드시 한국어(Korean)로만 답변할 것.**
            [글] {user_text}
            [교재] {ground_truth}
            [지시] 다음 내용 방향 제시.
            [출력(JSON)] {{ "feedback": "...", "score": null }}
            """
        else:
            prompt = f"""
            [역할] 채점관.
            [언어] **피드백과 심화 질문은 반드시 한국어(Korean)로 작성할 것.**
            [글] {user_text}
            [교재] {ground_truth}
            [지시] 100점 만점 채점, 피드백 제공.
            [출력(JSON)] {{ "score": 85, "feedback": "...", "challenge_question": "..." }}
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
        return https_fn.Response(json.dumps({"error": str(e)}), status=500, headers=headers)


# ⭐️ [수정됨] 정답 제출 채점 (한글 강제 + CORS 해결)
@https_fn.on_call(
    region="asia-northeast3",
    secrets=["OPENAI_API_KEY"],
    memory=options.MemoryOption.GB_1,
    timeout_sec=60
)
def scoreDiscussionAnswer(req: https_fn.CallableRequest) -> any:
    question = req.data.get("question")
    user_answer = req.data.get("user_answer")
    
    if not question or not user_answer:
        raise https_fn.HttpsError(code="invalid-argument", message="데이터 누락")

    try:
        client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        
        prompt = f"""
        [역할] 친절하고 꼼꼼한 선생님.
        [언어] **피드백은 반드시 한국어(Korean)로만 작성하세요.**
        [문제] {question}
        [학생 답안] {user_answer}
        [지시] 10점 만점 채점 및 피드백.
        [출력(JSON)] {{ "score": 8, "feedback": "..." }}
        """
        
        res = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role":"system","content":"JSON only"},{"role":"user","content":prompt}],
            response_format={"type":"json_object"}
        )
        return json.loads(res.choices[0].message.content)

    except Exception as e:
        raise https_fn.HttpsError(code="internal", message=f"채점 실패: {e}")