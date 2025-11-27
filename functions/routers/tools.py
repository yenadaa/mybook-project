from firebase_functions import https_fn
from firebase_admin import firestore
from core.config import get_db
import os
import json
import traceback

# --------------------------------------------------------
# 헬퍼 함수 (Missing Helpers Added)
# --------------------------------------------------------

def _get_auth_and_book_id(req: https_fn.CallableRequest):
    """사용자 인증 및 bookId 검증 헬퍼"""
    if req.auth is None:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.UNAUTHENTICATED, message="로그인이 필요합니다.")
    
    user_id = req.auth.uid
    book_id = req.data.get("bookId")
    
    if not book_id:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT, message="bookId가 필요합니다.")
        
    return user_id, book_id

def _get_quiz_prompt(context: str) -> str:
    """하이라이트 기반 퀴즈 생성 프롬프트"""
    return f"""
    [지시]
    아래 [문맥]은 사용자가 중요하다고 밑줄 친 내용들입니다.
    이 내용을 바탕으로 학습용 퀴즈를 JSON 형식으로 생성하세요.
    
    [조건]
    1. OX 퀴즈 1~2개, 객관식 1~2개, 단답형 1개 (총 3~5문제)
    2. 언어: 한국어
    
    [문맥]
    {context}
    
    [출력 포맷(JSON)]
    {{
        "quiz": [
            {{ "type": "ox", "question": "...", "answer": "O", "explanation": "..." }},
            {{ "type": "multiple_choice", "question": "...", "options": ["A", "B", "C"], "answer": "A" }},
            {{ "type": "short_answer", "question": "...", "answer": "..." }}
        ]
    }}
    """

# --------------------------------------------------------
# 메인 함수들
# --------------------------------------------------------

@https_fn.on_call(secrets=["OPENAI_API_KEY"])
def generateQuiz(req: https_fn.CallableRequest) -> https_fn.Response:
    """
    하이라이트된 텍스트들을 모아서 즉석 퀴즈를 생성합니다.
    """
    import openai
    
    db = get_db()
    client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    
    # 헬퍼 함수 사용
    user_id, book_id = _get_auth_and_book_id(req)
    
    # DB에서 하이라이트 가져오기
    docs = db.collection('highlights').where('userId', '==', user_id).where('bookId', '==', book_id).stream()
    texts = [doc.to_dict().get('text', '') for doc in docs if doc.to_dict().get('text')]
    
    if not texts:
        return {"quiz": []}
    
    context = "\n".join(texts)
    prompt = _get_quiz_prompt(context)
    
    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "You are a helpful assistant that generates quizzes in JSON format."},
                {"role": "user", "content": prompt}
            ],
            response_format={"type": "json_object"}
        )
        quiz_data = response.choices[0].message.content
        return json.loads(quiz_data)
        
    except Exception as e:
        print(f"GPT API 호출 오류: {e}")
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INTERNAL, message="퀴즈 생성 중 오류가 발생했습니다.")


@https_fn.on_call(secrets=["OPENAI_API_KEY"])
def runOcrOnSelection(req: https_fn.CallableRequest) -> https_fn.Response:
    """
    드래그한 이미지(Base64)를 텍스트로 변환합니다.
    """
    import openai
    
    if req.auth is None:
        raise https_fn.HttpsError(code="unauthenticated", message="로그인이 필요합니다.")
        
    base64_image = req.data.get("imageData")
    if not base64_image:
        raise https_fn.HttpsError(code="invalid-argument", message="이미지 데이터가 필요합니다.")
        
    try:
        client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        image_url = f"data:image/png;base64,{base64_image}"
        
        prompt_text = "이미지의 텍스트를 추출하세요. 표나 수식이 있다면 적절히 마크다운/LaTeX으로 변환하세요. 설명 없이 결과 텍스트만 출력하세요."
        
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{
                "role": "user", 
                "content": [
                    {"type": "text", "text": prompt_text}, 
                    {"type": "image_url", "image_url": {"url": image_url}}
                ] 
            }],
            max_tokens=500
        )
        detected_text = response.choices[0].message.content
        return {"text": detected_text}
        
    except Exception as e:
        print(f"Vision API Error: {traceback.format_exc()}")
        raise https_fn.HttpsError(code="internal", message=f"OCR 처리 중 오류: {str(e)}")


@https_fn.on_call()
def saveQuizItems(req: https_fn.CallableRequest) -> https_fn.Response:
    """
    생성된 퀴즈를 DB에 저장합니다. (중복 검사 포함)
    """
    # ⭐️ 지연 로딩 (유사도 검사 모듈)
    from hashlib import sha256
    from utils_similarity import normalize_q, char_ngrams, simhash64, simhash_bands, hamming

    db = get_db()
    
    if req.auth is None: 
        raise https_fn.HttpsError(code="unauthenticated", message="로그인이 필요합니다.")
        
    uid = req.auth.uid
    book_id = req.data.get("bookId")
    scope = (req.data.get("scope") or "full").strip()
    items = req.data.get("items") or []
    
    if not book_id or not isinstance(items, list):
        raise https_fn.HttpsError(code="invalid-argument", message="bookId와 items가 필요합니다.")
        
    col = db.collection("quizItems")
    saved, skipped = [], []
    
    for raw in items:
        q = (raw.get("q") or raw.get("question") or "").strip()
        if not q:
            skipped.append({"q": "", "reason": "NO_QUESTION"})
            continue
            
        # SimHash 기반 중복 검사
        q_norm = normalize_q(q)
        tokens = char_ngrams(q_norm, n=3)
        sig64 = simhash64(tokens)
        bands = simhash_bands(sig64)
        
        candidates = {}
        for b in bands:
            qry = (
                col.where("userId", "==", uid)
                   .where("bookId", "==", book_id)
                   .where("scope", "==", scope)
                   .where("bands", "array_contains", b)
                   .limit(50)
            )
            for doc in qry.stream():
                if doc.id not in candidates:
                    candidates[doc.id] = doc.to_dict()
                    
        is_dup = False
        dup_id = None
        for cid, c in candidates.items():
            try: c_sig = int(c.get("sim64", "0"))
            except: continue
            
            if hamming(sig64, c_sig) <= 6:
                is_dup = True
                dup_id = cid
                break
                
        if is_dup:
            skipped.append({"q": q, "reason": "DUPLICATE", "existingId": dup_id})
            continue
            
        # 저장 로직
        qhash = sha256(q_norm.encode("utf-8")).hexdigest()[:10]
        doc_id = f"{uid}_{book_id}_{scope}_{qhash}"
        ref = col.document(doc_id)
        existed = ref.get().exists
        
        payload = {
            "userId": uid, "bookId": book_id, "scope": scope,
            "type": raw.get("type") or "unknown",
            "q": q, "q_norm": q_norm,
            "answer": raw.get("answer"),
            "sources": raw.get("sources") or [],
            "tags": raw.get("tags") or [], 
            "sim64": str(sig64), "bands": bands,
            "updatedAt": firestore.SERVER_TIMESTAMP,
            "reviewLevel": 0, 
            "nextReviewDate": firestore.SERVER_TIMESTAMP 
        }
        
        if not existed:
            payload["createdAt"] = firestore.SERVER_TIMESTAMP
            
        ref.set(payload, merge=True)
        saved.append(doc_id)
        
    return {"saved": saved, "skipped": skipped}