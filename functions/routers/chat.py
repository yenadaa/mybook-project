from firebase_functions import https_fn, options
from core.config import get_db, ALLOWED_ORIGIN
import json
import os
import sys
import traceback
from openai import OpenAI

# 상위 폴더 모듈 가져오기
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    # quiz_generator에서 필요한 모듈 가져오기
    from quiz_generator import search_chunks_with_bm25, PreprocessedDoc
    # ⭐️ quiz.py에 있는 공통 로더 가져오기 (1MB 제한 해결됨)
    from routers.quiz import _load_doc_data 
except ImportError:
    pass

@https_fn.on_request(
    secrets=["OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"],
    memory=options.MemoryOption.GB_1,
    timeout_sec=60,
    region="asia-northeast3"
)
def ragChat(req: https_fn.Request) -> https_fn.Response:
    # 1. CORS
    if req.method == "OPTIONS":
        headers = {
            "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        }
        return https_fn.Response("", status=204, headers=headers)
    
    headers = {"Access-Control-Allow-Origin": ALLOWED_ORIGIN}

    try:
        data = req.get_json(silent=True)
        if not data: raise Exception("Body is empty")
        
        base_system_prompt = data.get("system_prompt", "")
        chat_history = data.get("messages", [])
        user_query = chat_history[-1]["content"] if chat_history else ""
        
        # ⭐️ [추가] persona 확인 (기본값 professor)
        persona = data.get("persona", "professor")
        
        book_id = data.get("book_id")
        folder_id = data.get("folder_id")

        if not book_id and not folder_id:
            raise Exception("대상을 선택해주세요 (book_id or folder_id).")
        if not user_query:
            raise Exception("질문 내용이 없습니다.")

    except Exception as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=400, headers=headers)

    # 2. 문서 로드 (공통 로더 사용 -> 1MB 제한 극복 & 폴더 지원)
    doc_obj = None
    try:
        payload = {}
        if book_id: payload['bookId'] = book_id
        if folder_id: payload['folderId'] = folder_id
        
        doc_obj = _load_doc_data(payload)
        
    except Exception as e:
        print(f"Doc Load Error: {e}")
        pass

    # 3. RAG 검색 (BM25)
    context_text = ""
    try:
        if doc_obj:
            top_k = 10 if folder_id else 5
            
            search_query = user_query
            if len(chat_history) > 1:
                search_query += " " + chat_history[-2]["content"][:50]
                
            chunks = search_chunks_with_bm25(doc_obj, search_query, top_k=top_k)
            
            if chunks:
                context_list = []
                for c in chunks:
                    src = c.metadata.get('source_book', '문서')
                    page = c.metadata.get('page', '?')
                    context_list.append(f"[[출처: {src} | p.{page}]]\n{c.text}")
                
                context_text = "\n\n".join(context_list)
                print(f"✅ RAG 검색 성공: {len(chunks)}개 청크")
            else:
                context_text = "문서에서 관련 내용을 찾을 수 없습니다."
    except Exception as e:
        print(f"RAG Error: {e}")

    # 4. 하이라이트 (단일 파일일 때만)
    highlights_text = ""
    if book_id:
        try:
            db = get_db()
            h_docs = db.collection('highlights').where('bookId', '==', book_id).limit(10).stream()
            h_list = [d.to_dict().get('text') for d in h_docs]
            if h_list: highlights_text = "\n".join([f"- {t}" for t in h_list if t])
        except: pass

    # 5. GPT 응답 생성
    try:
        client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        
        # ⭐️ [핵심 수정] 페르소나에 따라 제약 조건 다르게 적용
        if persona == 'general':
            # ✅ 자유 모드: 제약 없음, 문서는 '참고용'으로만 제공
            final_prompt = f"""
            {base_system_prompt}

            [상황]
            사용자는 문서 내용을 보고 있지만, 당신에게 자유로운 질문을 하고 싶어합니다.
            
            [참조 문서 내용 (참고용)]
            {context_text}
            
            [지시사항]
            1. 위 [참조 문서]에 내용이 있다면 활용해서 답변하세요.
            2. **하지만 문서에 내용이 없거나 부족하면, 당신의 일반 지식을 총동원해서 답변하세요.**
            3. "문서에 없습니다"라는 말은 하지 마세요.
            """
        else:
            # 🔒 엄격 모드 (기존 로직): 문서 내용만 말해라
            final_prompt = f"""
            {base_system_prompt}
            
            [상황]
            사용자는 문서(또는 문서 폴더)에 대해 질문하고 있습니다.
            
            [참조 문서 내용 (RAG)]
            {context_text}
            
            [사용자의 중요 표시 (Highlights)]
            {highlights_text}
            
            [지시사항]
            1. [참조 문서 내용]을 최우선으로 근거하여 답변하세요.
            2. 여러 출처의 내용이 있다면 "A문서에 따르면..., B문서에서는..." 처럼 구분해 주세요.
            3. **문서에 없는 내용은 지어내지 말고 "문서에 내용이 없습니다"라고 하세요.**
            """

        messages = [{"role": "system", "content": final_prompt}] + chat_history
        
        res = client.chat.completions.create(
            model="gpt-4o", 
            messages=messages,
            temperature=0.3
        )
        reply = res.choices[0].message.content
        
        return https_fn.Response(json.dumps({"reply": reply}), status=200, headers=headers)

    except Exception as e:
        return https_fn.Response(json.dumps({"error": f"GPT Error: {e}"}), status=500, headers=headers)