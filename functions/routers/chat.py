from firebase_functions import https_fn, options
from core.config import get_db, ALLOWED_ORIGIN
import json
import os
import traceback

@https_fn.on_request(
    secrets=["OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"],
    memory=options.MemoryOption.GB_1,
    timeout_sec=60
)
def ragChat(req: https_fn.Request) -> https_fn.Response:
    if req.method == "OPTIONS":
        headers = {
            "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "3600",
        }
        return https_fn.Response("", status=204, headers=headers)
    
    response_headers = {"Access-Control-Allow-Origin": ALLOWED_ORIGIN}

    db = get_db()
    
    from quiz_generator import search_chunks_with_bm25, PreprocessedDoc

    try:
        from supabase import create_client
        from langchain_openai import OpenAIEmbeddings
        from openai import OpenAI
        
        supabase_url = os.environ.get("SUPABASE_URL")
        supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
        supabase_client = create_client(supabase_url, supabase_key)
        supabase_embeddings = OpenAIEmbeddings(openai_api_key=os.environ.get("OPENAI_API_KEY"))
        openai_client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

    except Exception as e:
        return https_fn.Response(json.dumps({"error": f"초기화 실패: {e}"}), status=500, headers=response_headers)

    try:
        data = req.get_json(silent=True)
        if not data: raise Exception("Body is empty")
        
        base_system_prompt = data.get("system_prompt", "")
        chat_history = data.get("messages", [])
        book_id = data.get("book_id")
        user_query = chat_history[-1]["content"] if chat_history else ""

        if not book_id or not user_query:
            raise Exception("book_id 또는 질문 내용이 없습니다.")

    except Exception as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=422, headers=response_headers)

    context_text = ""
    
    try:
        # [Step 3-1] BM25 검색
        try:
            # _load_processed_doc_from_firestore 함수는 routers/tools.py에 있거나 여기서 정의해야 함
            # 여기서는 편의상 내부 정의 없이 직접 DB 접근한다고 가정 (혹은 tools에서 import)
            doc_ref = db.collection("books").document(book_id)
            doc_snapshot = doc_ref.get()
            if doc_snapshot.exists and doc_snapshot.get("processedData"):
                doc_obj = PreprocessedDoc(**doc_snapshot.get("processedData"))
                bm25_chunks = search_chunks_with_bm25(doc_obj, user_query, top_k=4)
                if bm25_chunks:
                    context_list = []
                    for c in bm25_chunks:
                        page_num = c.metadata.get("page", 1) if c.metadata else 1
                        context_list.append(f"[PAGE {page_num}] {c.text}")
                    context_text = "\n\n".join(context_list)
                    print(f"--- ✅ BM25 검색 성공 ({len(bm25_chunks)}개) ---")
        except Exception as bm25_e:
            print(f"⚠️ BM25 검색 건너뜀: {bm25_e}")

        # [Step 3-2] 벡터 검색
        if not context_text:
            print("--- 🔍 벡터 검색(Supabase) 시도 ---")
            query_vec = supabase_embeddings.embed_query(user_query)
            rpc_res = supabase_client.rpc("match_documents", {
                "query_embedding": query_vec,
                "filter": {"bookId": book_id},
                "match_count": 4
            }).execute()
            
            valid_docs = []
            for d in rpc_res.data:
                if d['similarity'] > 0.5:
                    meta = d.get('metadata', {})
                    page_num = meta.get('page', 1)
                    valid_docs.append(f"[PAGE {page_num}] {d['content']}")
            
            if valid_docs:
                context_text = "\n\n".join(valid_docs)
            else:
                context_text = "문서에서 관련 내용을 찾을 수 없습니다."

    except Exception as e:
        print(f"검색 프로세스 오류: {traceback.format_exc()}")
        context_text = "검색 중 오류가 발생하여 문서를 참조하지 못했습니다."

    user_highlights_text = ""
    try:
        highlight_docs = db.collection('highlights').where('bookId', '==', book_id).limit(15).stream()
        h_list = [f"- {d.to_dict()['text']}" for d in highlight_docs if d.to_dict().get('text')]
        if h_list:
            user_highlights_text = "\n".join(h_list)
    except Exception as hl_e:
        print(f"하이라이트 로드 실패: {hl_e}")

    try:
        final_system_prompt = f"""
        {base_system_prompt}
        ---
        [시스템 지침]
        ... (기존 프롬프트 내용 유지) ...
        [사용자가 밑줄 친 핵심 내용]
        {user_highlights_text}
        [문서 문맥]
        {context_text}
        """

        messages_for_api = [{"role": "system", "content": final_system_prompt}] + chat_history
        completion = openai_client.chat.completions.create(model="gpt-4o", messages=messages_for_api)
        reply = completion.choices[0].message.content
        return https_fn.Response(json.dumps({"reply": reply}), status=200, headers=response_headers)

    except Exception as e:
        return https_fn.Response(json.dumps({"error": f"GPT 오류: {e}"}), status=500, headers=response_headers)