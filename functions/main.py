# main.py
#
# ⭐️ [최종 지연 로딩 버전]
# - 배포 타임아웃(10초)을 피하기 위해, 모든 '무거운' import를 각 함수 "안"으로 옮깁니다.
# - '파이프라인'과 '빠른 퀴즈' 기능이 모두 포함되어 있습니다.
#

import firebase_admin
from firebase_admin import firestore, initialize_app, messaging, storage
from firebase_functions import https_fn, options, scheduler_fn, storage_fn

# ⭐️ [수정] 가벼운 표준 라이브러리만 남겨둡니다.
import os
import json
import traceback
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Dict, Any 

# ---------------------------------------------
# --- 1. Firebase 앱 및 클라이언트 초기화 ---
# ---------------------------------------------
initialize_app()

db = None
storage_client = None
vision_client = None
openai_client = None
tasks_client = None 
supabase_client = None
supabase_embeddings = None
options.set_global_options(
    region="asia-northeast3",
    memory=options.MemoryOption.GB_1, 
    timeout_sec=540,
    secrets=["OPENAI_API_KEY"]
)

ALLOWED_ORIGIN = "https://mybook-d143d.web.app"

# ---------------------------------------------
# --- 2. ⭐️ [수정] 단일 처리 파이프라인 (artifacts 감시) ---
# ---------------------------------------------
@storage_fn.on_object_finalized(
    timeout_sec=540,
    memory=options.MemoryOption.GB_2,
    secrets=["OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"]
)
def on_pdf_upload(event: storage_fn.CloudEvent[storage_fn.StorageObjectData]):
    """
    [⭐️ 최종 파이프라인 + 진행상황 알림]
    """
    # ⭐️ [지연 로딩]
    from quiz_generator import (
        PreprocessedDoc, Chunk, Output, ReviewOut, SummaryOut,
        pdf_to_preprocessed_doc, generate_base_review, 
        generate_custom_review
    )

    global storage_client, db
    if db is None: db = firestore.client()
    if storage_client is None: storage_client = storage.bucket()

    file_path = event.data.name
    
    if not file_path or not file_path.startswith("artifacts/") or not file_path.lower().endswith(".pdf"):
        return

    try:
        parts = file_path.split("/")
        user_id = parts[3]
        book_id = parts[5].replace(".pdf", "")
    except IndexError:
        return

    print(f"--- 🚀 '단일 처리 파이프라인' 시작 (Book ID: {book_id}) ---")
    doc_ref = db.collection("books").document(book_id)

    # ⭐️ [헬퍼 함수] 진행 상황 업데이트용
    def update_status(msg):
        print(f"--- 📢 [Progress] {msg} ---")
        doc_ref.set({
            "status": "processing",
            "progressMessage": msg,  # 👈 이 필드를 프론트에서 읽습니다.
            "owner_uid": user_id,
            "lastUpdated": firestore.SERVER_TIMESTAMP
        }, merge=True)

    # 1. 시작 알림
    update_status("PDF 다운로드 및 분석 준비 중...")

    # 3. PDF 다운로드
    try:
        blob = storage_client.blob(file_path)
        pdf_bytes = blob.download_as_bytes()
        update_status("텍스트 추출 및 전처리 중...") # 👈 업데이트
    except Exception as e:
        doc_ref.set({"status": f"error_download: {e}"}, merge=True)
        return

    # 4. 텍스트 청크 생성
    try:
        processed_doc: "PreprocessedDoc" = pdf_to_preprocessed_doc(
            pdf_bytes=pdf_bytes,
            doc_id=book_id
        )
        if not processed_doc.chunks:
             raise ValueError('PDF에서 텍스트를 추출할 수 없습니다.')
        update_status(f"AI 요약 및 기본 퀴즈 생성 중... ({len(processed_doc.chunks)}개 구간)") # 👈 업데이트
    except Exception as e:
        doc_ref.set({"status": f"error_processing: {e}"}, merge=True)
        return

    # 5. [요리 1] '전체 요약/퀴즈' 미리 생성
    try:
        base_review_output: "Output" = generate_base_review(
            processed_doc, 
            model="gpt-4o-mini"
        )
        update_status("심화(하이라이트) 퀴즈 생성 중...") # 👈 업데이트
    except Exception as e:
        doc_ref.set({"status": f"error_base_review: {e}"}, merge=True)
        return

    # 6. [요리 2] '하이라이트(루브릭)' 퀴즈 미리 생성
    try:
        all_chunk_ids = [c.id for c in processed_doc.chunks if c.id]
        custom_review_output: "ReviewOut" = generate_custom_review(
            doc=processed_doc,
            chunk_ids=all_chunk_ids,
            keywords=None,
            counts_override={"ox": 0, "short": 0, "discussion": 10},
            model="gpt-4o-mini"
        )
        update_status("챗봇용 지식(Vector) 업로드 중...") # 👈 업데이트
    except Exception as e:
        doc_ref.set({"status": f"error_custom_review: {e}"}, merge=True)
        return

# 7. [챗봇] 챗봇용 벡터 생성
    try:
        from langchain_openai import OpenAIEmbeddings
        from langchain_community.vectorstores import SupabaseVectorStore
        from supabase import create_client
        # ⭐️ [추가] LangChain 표준 문서 객체 임포트
        from langchain_core.documents import Document 
        
        global supabase_client, supabase_embeddings
        if supabase_client is None:
            supabase_url = os.environ.get("SUPABASE_URL")
            supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
            supabase_client = create_client(supabase_url, supabase_key)
        
        if supabase_embeddings is None:
            supabase_embeddings = OpenAIEmbeddings(openai_api_key=os.environ.get("OPENAI_API_KEY"))

        vector_store = SupabaseVectorStore(
            client=supabase_client,
            embedding=supabase_embeddings,
            table_name="documents",
            query_name="match_documents"
        )

        # ⭐️ [수정] 커스텀 Chunk 객체를 LangChain Document 객체로 명시적 변환
        docs_to_upload = []
        for chunk in processed_doc.chunks:
            # 메타데이터 구성
            metadata = {"bookId": book_id}
            if chunk.metadata and "page_number" in chunk.metadata:
                 metadata["page_number"] = chunk.metadata["page_number"]
            
            # Document 객체 생성
            doc = Document(
                page_content=chunk.text,  # 실제 텍스트 내용
                metadata=metadata         # 메타데이터
            )
            docs_to_upload.append(doc)

        # 기존 데이터 삭제
        supabase_client.table("documents").delete().eq("metadata->>bookId", book_id).execute()
        
        # 변환된 문서 리스트 업로드
        if docs_to_upload:
            vector_store.add_documents(docs_to_upload)
            print(f"--- ✅ Supabase에 {len(docs_to_upload)}개 벡터 저장 완료 ---")
        else:
            print("--- ⚠️ 업로드할 텍스트 청크가 없습니다. ---")
            
        update_status("모든 데이터 저장 및 마무리 중...")

    except Exception as e:
        print(f"Supabase Upload Error Details: {e}") # 에러 로그 자세히 출력
        doc_ref.set({"status": f"error_supabase_upload: {e}"}, merge=True)
        return

    # 8. [⭐️ 저장] 완료
    try:
        final_custom_output = Output(
            summaries=SummaryOut(summary="", sources=all_chunk_ids), 
            review=custom_review_output,
            meta={"model": "gpt-4o-mini", "doc_id": book_id}
        )
        
        doc_ref.set({
            "processedData": processed_doc.model_dump(),
            "baseReviewPayload": base_review_output.model_dump(),
            "customReviewPayload": final_custom_output.model_dump(),
            "status": "processed_all_ok",
            "progressMessage": "✅ 분석 완료! 퀴즈를 풀어보세요.", # 👈 최종 메시지
            "lastProcessed": firestore.SERVER_TIMESTAMP,
            "owner_uid": user_id
        }, merge=True) 
        
    except Exception as e:
        doc_ref.set({"status": f"error_saving: {e}"}, merge=True)
        return

# ---------------------------------------------
# --- 3. 헬퍼 함수 ---
# ---------------------------------------------

def _get_auth_and_book_id(req: https_fn.CallableRequest) -> tuple[str, str]:
    if req.auth is None:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.UNAUTHENTICATED, message="로그인이 필요합니다.")
    user_id = req.auth.uid
    book_id = req.data.get("bookId")
    if not book_id:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT, message="bookId가 필요합니다.")
    return user_id, book_id

def _load_processed_doc_from_firestore(book_id: str) -> "PreprocessedDoc":
    """
    [⭐️ 핵심 헬퍼] Firestore 'books' 컬렉션에서 'processedData'를 읽습니다.
    """
    from quiz_generator import PreprocessedDoc # ⭐️ 지연 로딩

    global db
    if db is None: db = firestore.client()
    if not book_id:
        raise https_fn.HttpsError(code="invalid-argument", message="bookId가 필요합니다.")
    try:
        doc_ref = db.collection("books").document(book_id)
        doc_snapshot = doc_ref.get()
        if not doc_snapshot.exists:
            raise https_fn.HttpsError(code="not-found", message=f"{book_id} 문서를 찾을 수 없습니다.")
        processed_data_dict = doc_snapshot.get("processedData")
        if not processed_data_dict:
             raise https_fn.HttpsError(code="aborted", message="PDF가 아직 처리되지 않았습니다.")
        doc_for_quiz = PreprocessedDoc(**processed_data_dict)
        return doc_for_quiz
    except Exception as e:
        print(f"Error loading processedData: {e}")
        raise https_fn.HttpsError(code="internal", message=f"처리된 데이터 로드 중 오류: {e}")

def _get_quiz_prompt(context: str) -> str:
    # (기존 코드 유지)
    return f"..." # (프롬프트 내용 생략)

def _get_next_review_date(new_review_level: int) -> datetime:
    # (기존 코드 유지)
    now = datetime.now(timezone.utc)
    if new_review_level == 1: return now + timedelta(days=1)
    elif new_review_level == 2: return now + timedelta(days=3)
    elif new_review_level == 3: return now + timedelta(days=7)
    elif new_review_level == 4: return now + timedelta(days=30)
    else: return now + timedelta(days=90)


# ---------------------------------------------
# --- 4. ⭐️ [수정] 퀴즈 생성 함수 (빠른 실전용) ---
# ---------------------------------------------

@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
)
def generateFullDocQuiz(req: https_fn.CallableRequest) -> https_fn.Response:
    """
    [⭐️ 최종 실전 버전]
    - Firestore 'books' 컬렉션에서 'baseReviewPayload'를 1초 만에 읽어옵니다.
    """
    global db
    if db is None: db = firestore.client()
    
    book_id = req.data.get("bookId")
    if not book_id:
        raise https_fn.HttpsError(code="invalid-argument", message="bookId가 필요합니다.")

    try:
        doc_ref = db.collection("books").document(book_id)
        doc_snapshot = doc_ref.get()
        if not doc_snapshot.exists:
            raise https_fn.HttpsError(code="not-found", message=f"{book_id} 문서를 찾을 수 없습니다.")
        
        payload = doc_snapshot.get("baseReviewPayload") 
        if not payload:
             raise https_fn.HttpsError(code="aborted", message="PDF가 아직 처리되지 않았습니다. (요약 데이터 없음)")
        
        return payload
    
    except Exception as e:
        print(f"Error in generateFullDocQuiz (fast): {e}")
        raise https_fn.HttpsError(code="internal", message=f"퀴즈/요약 로드 중 오류 발생: {e}")


@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
    memory=options.MemoryOption.GB_1
)
def generateCustomReview(req: https_fn.CallableRequest) -> https_fn.Response:
    """
    [⭐️ 최종 실전 버전]
    - Firestore 'books' 컬렉션에서 'customReviewPayload'를 1초 만에 읽어옵니다.
    """
    global db
    if db is None: db = firestore.client()

    book_id = req.data.get("bookId")
    if not book_id:
        raise https_fn.HttpsError(code="invalid-argument", message="bookId가 필요합니다.")

    try:
        doc_ref = db.collection("books").document(book_id)
        doc_snapshot = doc_ref.get()
        if not doc_snapshot.exists:
            raise https_fn.HttpsError(code="not-found", message=f"{book_id} 문서를 찾을 수 없습니다.")
        
        payload = doc_snapshot.get("customReviewPayload") 
        if not payload:
             raise https_fn.HttpsError(code="aborted", message="PDF가 아직 처리되지 않았습니다. (맞춤형 퀴즈 데이터 없음)")
        
        return payload
    
    except Exception as e:
        print(f"Error in generateCustomReview (fast): {e}")
        raise https_fn.HttpsError(code="internal", message=f"맞춤형 퀴즈 로드 중 오류 발생: {e}")


# ---------------------------------------------
# --- 5. ⭐️ 서술형 채점 함수 (유지) ---
# ---------------------------------------------
@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
)
def scoreQuizAnswer(req: https_fn.CallableRequest) -> https_fn.Response:
    # ⭐️ [지연 로딩]
    from quiz_generator import AnswerIn, ScoreResult, score_discussion_answer

    try:
        answer_data_dict = req.data.get("answerData")
        if not answer_data_dict:
            raise https_fn.HttpsError(code="invalid-argument", message="answerData가 필요합니다.")
        answer_in_model = AnswerIn(**answer_data_dict)
        score_result: "ScoreResult" = score_discussion_answer(
            answer_data=answer_in_model,
            model="gpt-4o-mini"
        )
        return {"result": score_result.model_dump()}
    except Exception as e:
        print(f"Error in scoreQuizAnswer: {e}")
        raise https_fn.HttpsError(code="internal", message=f"채점 중 오류 발생: {e}")


# ---------------------------------------------
# --- 6. ⭐️ [교체] 챗봇(RAG) 함수 (BM25 + Supabase 하이브리드 + 페르소나) ---
# ---------------------------------------------
@https_fn.on_request(
    secrets=["OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"],
    memory=options.MemoryOption.GB_1,
    timeout_sec=60
)
def ragChat(req: https_fn.Request) -> https_fn.Response:
    """
    [⭐️ 최종 챗봇]
    1. BM25 & 벡터 검색으로 문서 내용 확보 (페이지 번호 [PAGE n] 부착)
    2. Firestore에서 '사용자 하이라이트' 가져오기
    3. 프롬프트에 '하이라이트 우선 순위' + '페르소나' + '페이지 인용' 규칙 모두 통합
    """
    # --- 0. CORS 헤더 ---
    if req.method == "OPTIONS":
        headers = {
            "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "3600",
        }
        return https_fn.Response("", status=204, headers=headers)
    
    response_headers = {"Access-Control-Allow-Origin": ALLOWED_ORIGIN}

    # --- 1. 초기화 ---
    global supabase_client, supabase_embeddings, openai_client, db
    if db is None: db = firestore.client()
    
    from quiz_generator import search_chunks_with_bm25, PreprocessedDoc

    try:
        from supabase import create_client
        from langchain_openai import OpenAIEmbeddings
        from openai import OpenAI
        
        if supabase_client is None:
            supabase_url = os.environ.get("SUPABASE_URL")
            supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
            supabase_client = create_client(supabase_url, supabase_key)
        
        if supabase_embeddings is None:
            supabase_embeddings = OpenAIEmbeddings(openai_api_key=os.environ.get("OPENAI_API_KEY"))
        
        if openai_client is None:
            openai_client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

    except Exception as e:
        return https_fn.Response(json.dumps({"error": f"초기화 실패: {e}"}), status=500, headers=response_headers)

    # --- 2. 요청 파싱 ---
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

    # --- 3. 하이브리드 검색 (BM25 -> Vector) & 페이지 번호 처리 ---
    context_text = ""
    
    try:
        # [Step 3-1] BM25 검색 시도
        try:
            doc_obj = _load_processed_doc_from_firestore(book_id)
            bm25_chunks = search_chunks_with_bm25(doc_obj, user_query, top_k=4)
            
            if bm25_chunks:
                context_list = []
                for c in bm25_chunks:
                    # ⭐️ [수정] 페이지 번호 없으면 무조건 '1' (프론트엔드 오류 방지)
                    page_num = 1
                    if c.metadata and "page_number" in c.metadata:
                        try: page_num = int(c.metadata["page_number"])
                        except: page_num = 1
                    
                    context_list.append(f"[PAGE {page_num}] {c.text}")
                
                context_text = "\n\n".join(context_list)
                print(f"--- ✅ BM25 검색 성공 ({len(bm25_chunks)}개) ---")
                
        except Exception as bm25_e:
            print(f"⚠️ BM25 검색 건너뜀: {bm25_e}")

        # [Step 3-2] 벡터 검색 (BM25 실패 시 Fallback)
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
                    # ⭐️ [수정] 벡터 검색도 페이지 번호 없으면 '1'로 고정
                    meta = d.get('metadata', {})
                    try: page_num = int(meta.get('page_number', 1))
                    except: page_num = 1
                    
                    valid_docs.append(f"[PAGE {page_num}] {d['content']}")
            
            if valid_docs:
                context_text = "\n\n".join(valid_docs)
            else:
                context_text = "문서에서 관련 내용을 찾을 수 없습니다."

    except Exception as e:
        print(f"검색 프로세스 오류: {traceback.format_exc()}")
        context_text = "검색 중 오류가 발생하여 문서를 참조하지 못했습니다."

    # --- 4. [추가] 사용자 하이라이트(밑줄) 가져오기 ---
    user_highlights_text = ""
    try:
        highlight_docs = db.collection('highlights')\
            .where('bookId', '==', book_id)\
            .limit(15)\
            .stream() # 최신 15개만 가져옴 (토큰 절약)
            
        h_list = []
        for doc in highlight_docs:
            data = doc.to_dict()
            if data.get('text'):
                h_list.append(f"- {data['text']}")
        
        if h_list:
            user_highlights_text = "\n".join(h_list)
            print(f"--- ✅ 사용자 하이라이트 {len(h_list)}개 로드 ---")
    except Exception as hl_e:
        print(f"하이라이트 로드 실패: {hl_e}")

    # --- 5. OpenAI 응답 생성 (프롬프트 통합) ---
    try:
        final_system_prompt = f"""
        {base_system_prompt}

        ---
        [시스템 지침: 사용자 맞춤형 답변]
        1. 아래 [사용자가 밑줄 친 핵심 내용]은 사용자가 공부하면서 중요하다고 표시한 부분입니다.
        2. 답변을 구성할 때, 이 내용들이 질문과 관련이 있다면 **최우선적으로 인용하고 강조**해서 설명하세요.

        [시스템 RAG 지침]
        - 위 역할 원칙을 수행할 때, 반드시 아래 [문서 문맥]을 근거로 사용해야 합니다.
        - [문서 문맥]에는 각 텍스트 조각마다 **[PAGE 숫자]**가 표시되어 있습니다. 이를 보고 실제 페이지 번호를 파악하세요.

        [역할별 행동 지침]
        1. **'해설형 챗봇(교수)'** 역할일 경우: 
           - 핵심 개념을 친절하게 설명하세요.
           - 답변의 근거가 되는 문장 끝에 반드시 **[p.페이지번호]** 형식으로 출처를 명시하세요.
           - 예시: "이 이론은 BSM 모델에 기반합니다 [p.12]." (문맥의 [PAGE 12]를 참고)

        2. **'설명 유도형 챗봇(소크라테스)'** 역할일 경우: 
           - 이 문맥을 '정답'으로 간주하되, **절대 정답을 먼저 말하지 마세요.**
           - 사용자가 문맥의 내용과 일치하게 설명하는지 확인하고, 틀렸다면 질문을 던져 유도하세요.
           - 출처 표기는 굳이 하지 않아도 됩니다.

        3. **'주변 정보형 챗봇(선배)'** 역할일 경우: 
           - 이 문맥과 관련된 배경 지식이나 실무 팁을 섞어서 재미있게 말하세요.
           - "아, 이거 책 [p.15]에 나오는 내용인데~" 처럼 자연스럽게 언급하세요.

        [예외 처리]
        - 만약 [문서 문맥]에 질문과 관련된 내용이 전혀 없다면:
           - (해설형): "죄송합니다. 해당 PDF 문서에서 관련 내용을 찾을 수 없습니다."
           - (설명 유도형): "그 부분은 문서에 없네. 네가 아는 대로 설명해줄래?"
           - (주변 정보형): "그건 책에 없는데, 내가 아는 썰 풀어줄까?"
        - 절대 당신의 기존 지식을 [문서 문맥]보다 우선하여 사실인 것처럼 말하지 마세요.

        [사용자가 밑줄 친 핵심 내용]
        {user_highlights_text}

        [문서 문맥]
        {context_text}
        """

        messages_for_api = [{"role": "system", "content": final_system_prompt}] + chat_history
        
        completion = openai_client.chat.completions.create(
            model="gpt-4o",
            messages=messages_for_api
        )
        reply = completion.choices[0].message.content
        
        return https_fn.Response(json.dumps({"reply": reply}), status=200, headers=response_headers)

    except Exception as e:
        return https_fn.Response(json.dumps({"error": f"GPT 오류: {e}"}), status=500, headers=response_headers)
# ---------------------------------------------
# --- 7. (유지) 기존 기타 함수들 (OCR, 퀴즈 저장, 알림) ---
# ---------------------------------------------

# 7-1. (유지) 하이라이트 기반 [간단] 퀴즈
@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
)
def generateQuiz(req: https_fn.CallableRequest) -> https_fn.Response:
    import openai # ⭐️ 지연 로딩
    global db, openai_client
    if db is None: db = firestore.client()
    if openai_client is None: openai_client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    user_id, book_id = _get_auth_and_book_id(req)
    docs = db.collection('highlights').where('userId', '==', user_id).where('bookId', '==', book_id).stream()
    texts = [doc.to_dict().get('text', '') for doc in docs if doc.to_dict().get('text')]
    if not texts:
        return {"quiz": []}
    context = "\n".join(texts)
    prompt = _get_quiz_prompt(context)
    try:
        response = openai_client.chat.completions.create(
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


# 7-2. (유지) 이미지 영역 OCR (OpenAI Vision)
@https_fn.on_call(
    secrets=["OPENAI_API_KEY"],
)
def runOcrOnSelection(req: https_fn.CallableRequest) -> https_fn.Response:
    import openai # ⭐️ 지연 로딩
    global openai_client
    if openai_client is None:
        try:
            openai_client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
        except Exception as e:
            print(f"OpenAI 클라이언트 초기화 오류: {e}")
            raise https_fn.HttpsError(code='internal', message='OpenAI 클라이언트 초기화 실패')
    if req.auth is None:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.UNAUTHENTICATED, message="로그인이 필요합니다.")
    base64_image = req.data.get("imageData")
    if not base64_image:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT, message="이미지 데이터가 필요합니다.")
    try:
        image_url = f"data:image/png;base64,{base64_image}"
        prompt_text = "당신은 이미지 속의 표, 차트, 그래프를 분석하여 퀴즈를 만들 수 있도록 핵심 내용을 '줄글(prose)'로 요약하는 AI입니다. ... 5. 만약 단순 텍스트라면, 그 텍스트만 반환합니다."
        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": [{"type": "text", "text": prompt_text}, {"type": "image_url", "image_url": {"url": image_url}}] }],
            max_tokens=500
        )
        detected_text = response.choices[0].message.content
        print(f"OpenAI Vision API 결과 (줄글 요약): {detected_text}")
        return {"text": detected_text}
    except Exception as e:
        print(f"OpenAI Vision API 오류: {traceback.format_exc()}")
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INTERNAL, message=f"AI 비전 처리 중 서버 오류 발생: {str(e)}")


# 7-3. (유지) 퀴즈 저장 (중복 검사)
@https_fn.on_call()
def saveQuizItems(req: https_fn.CallableRequest) -> https_fn.Response:
    # ⭐️ [지연 로딩]
    from hashlib import sha256
    from utils_similarity import normalize_q, char_ngrams, simhash64, simhash_bands, hamming

    global db
    if db is None: db = firestore.client()
    if req.auth is None: raise https_fn.HttpsError(code="unauthenticated", message="로그인이 필요합니다.")
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
            except Exception: continue
            if hamming(sig64, c_sig) <= 6:
                is_dup = True
                dup_id = cid
                break
        if is_dup:
            skipped.append({"q": q, "reason": "DUPLICATE", "existingId": dup_id})
            continue
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


# 7-4. (유지) 복습 알림 (지휘자 / 일꾼 분리)
PROJECT_ID = "mybook-d143d" 
QUEUE_LOCATION = "asia-northeast3" 
QUEUE_ID = "quiz-generation-queue"
GENERATE_SESSION_URL = f"https://{QUEUE_LOCATION}-{PROJECT_ID}.cloudfunctions.net/generateUserReviewSession" 

@scheduler_fn.on_schedule(schedule="every day 09:00", timezone="Asia/Seoul")
def sendReviewNotifications(event: scheduler_fn.ScheduledEvent) -> None:
    from google.cloud import tasks_v2 # ⭐️ 지연 로딩
    global db, tasks_client
    if db is None: db = firestore.client()
    if tasks_client is None: tasks_client = tasks_v2.CloudTasksClient()
    print("매일 복습 알림 '지휘자' 함수 실행 시작.")
    now = datetime.now(timezone.utc)
    users_to_notify = set()
    wrong_quiz_query = (
        db.collection('quizItems')
          .where('nextReviewDate', '<=', now)
          .where('reviewLevel', '<', 4) 
    )
    for doc in wrong_quiz_query.stream():
        users_to_notify.add(doc.to_dict().get('userId'))
    if not users_to_notify:
        print("알림을 보낼 사용자가 없습니다.")
        return
    print(f"총 {len(users_to_notify)} 명의 사용자에 대한 복습 작업 생성 시작...")
    queue_path = tasks_client.queue_path(PROJECT_ID, QUEUE_LOCATION, QUEUE_ID)
    SERVICE_ACCOUNT_EMAIL = f"firebase-adminsdk-fbsvc@{PROJECT_ID}.iam.gserviceaccount.com"
    for user_id in users_to_notify:
        if not user_id: continue
        try:
            payload = {"userId": user_id}
            task = {
                "http_request": {
                    "http_method": tasks_v2.HttpMethod.POST,
                    "url": GENERATE_SESSION_URL, 
                    "headers": {"Content-Type": "application/json"},
                    "body": json.dumps(payload).encode(),
                    "oidc_token": {
                        "service_account_email": SERVICE_ACCOUNT_EMAIL
                    },
                },
                "dispatch_deadline": timedelta(minutes=15)
            }
            tasks_client.create_task(parent=queue_path, task=task)
            print(f"'{user_id}' 사용자를 위한 복습 작업을 큐에 추가했습니다.")
        except Exception as e:
            print(f"'{user_id}' 사용자 작업 생성 중 오류: {e}")
    print("모든 복습 작업 할당 완료.")

@https_fn.on_request(
    region="asia-northeast3",
    memory=options.MemoryOption.GB_2,
    timeout_sec=1800,
    secrets=["OPENAI_API_KEY"],
    invoker="private" 
)
def generateUserReviewSession(req: https_fn.Request) -> https_fn.Response:
    import openai # ⭐️ 지연 로딩
    global db, openai_client, storage_client
    if db is None: db = firestore.client()
    if openai_client is None: openai_client = openai.OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    if storage_client is None: storage_client = storage.bucket()
    user_id = None
    try:
        payload = req.get_json(silent=True)
        user_id = payload.get("userId")
        if not user_id:
            print("오류: userId가 없습니다.")
            return https_fn.Response("Bad Request", status=400)
        print(f"'{user_id}' 사용자의 복습 퀴즈 세션 생성을 시작합니다.")
        now = datetime.now(timezone.utc)
        wrong_quiz_query = db.collection('quizItems').where('userId', '==', user_id).where('reviewLevel', '<', 4)
        wrong_items_docs = list(wrong_quiz_query.stream())
        if not wrong_items_docs:
            print(f"'{user_id}' 사용자는 복습할 항목이 없습니다.")
            return https_fn.Response("No items to review", status=200)
        final_quiz_items = [doc.to_dict() for doc in wrong_items_docs] 
        session_ref = db.collection("reviewSessions").document()
        session_ref.set({
            "userId": user_id,
            "createdAt": firestore.SERVER_TIMESTAMP,
            "items": final_quiz_items
        })
        new_session_id = session_ref.id
        print(f"'{user_id}' 사용자의 퀴즈 세션 '{new_session_id}' 저장 완료.")
        try:
            user_doc = db.collection('users').document(user_id).get()
            fcm_token = None
            if user_doc.exists:
                fcm_token = user_doc.to_dict().get('fcmToken')
            else:
                print(f"'{user_id}' 사용자는 'users' 문서가 없습니다.")
            if fcm_token:
                quiz_url = f"/quiz-page.html?session={new_session_id}"
                message = messaging.Message(
                    data={ 
                        "urlToOpen": quiz_url,
                        "title": "MyBook 복습 시간입니다! 📚", 
                        "body": f"오늘 복습할 {len(final_quiz_items)}개의 퀴즈가 준비되었어요."
                    },
                    token=fcm_token
                )
                messaging.send(message)
                print(f"'{user_id}' 사용자에게 알림 전송 완료.")
            else:
                print(f"'{user_id}' 사용자는 FCM 토큰이 없어 알림을 보내지 않습니다.")
        except Exception as notify_e:
            print(f"'{user_id}' 사용자에게 알림 전송 중 오류 발생: {notify_e}")
        batch = db.batch()
        for doc in wrong_items_docs:
                current_level = doc.to_dict().get("reviewLevel", 0)
                new_level = current_level + 1
                next_review_date = _get_next_review_date(new_level)
                batch.update(doc.reference, {
                    "nextReviewDate": next_review_date, 
                    "reviewLevel": firestore.Increment(1)
                })
        batch.commit()
        print(f"'{user_id}' 사용자의 복습 날짜 (망각 곡선) 업데이트 완료.")
        return https_fn.Response("Session created", status=200)
    except Exception as e:
        print(f"'{user_id or 'Unknown user'}' 사용자 처리 중 치명적 오류: {traceback.format_exc()}")
        try:
             db.collection("reviewSessions").add({
                 "userId": user_id, "status": "error", "errorMessage": str(e),
                 "createdAt": firestore.SERVER_TIMESTAMP
             })
        except Exception as db_e:
            print(f"Firestore 오류 상태 저장 실패: {db_e}")
        return https_fn.Response(f"Internal Error: {e}", status=500)

# --------------------------------------------------------
# ⭐️ 백지 복습 채점 함수 (CORS 오류 수정 버전)
# --------------------------------------------------------
@https_fn.on_request(
    secrets=["OPENAI_API_KEY"],
    memory=options.MemoryOption.GB_1,
    timeout_sec=60
)
def gradeBlankPaper(req: https_fn.Request) -> https_fn.Response:
    
    # 1. [핵심] CORS 헤더 정의
    # ALLOWED_ORIGIN은 main.py 상단에 정의된 주소("https://mybook-d143d.web.app")를 씁니다.
    # 테스트 중에는 "*" (모두 허용)로 해도 됩니다.
    headers = {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN, 
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }

    # 2. [핵심] Preflight 요청(OPTIONS) 처리
    # 브라우저가 "보내도 돼?" 하고 먼저 물어보는 요청에 "응 보내!"라고 답하는 부분
    if req.method == "OPTIONS":
        return https_fn.Response("", status=204, headers=headers)

    # --- 기존 로직 시작 ---
    import json
    from openai import OpenAI
    from quiz_generator import search_chunks_with_bm25, PreprocessedDoc
    
    global db, openai_client
    if db is None: db = firestore.client()
    if openai_client is None: openai_client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

    try:
        data = req.get_json(silent=True)
        if not data:
             return https_fn.Response("Body is empty", status=400, headers=headers) # 헤더 추가

        book_id = data.get("bookId")
        base64_image = data.get("imageData")

        if not book_id or not base64_image:
            return https_fn.Response("bookId or imageData missing", status=400, headers=headers) # 헤더 추가

        # 1. 필기 인식 (Vision)
        vision_resp = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "이 이미지에 손글씨로 적힌 내용을 있는 그대로 텍스트로 변환해줘. 다른 말은 하지 말고 텍스트만 줘."},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{base64_image}"}}
                    ]
                }
            ],
            max_tokens=300
        )
        user_text = vision_resp.choices[0].message.content.strip()
        print(f"📝 사용자 필기 인식 결과: {user_text}")

        if not user_text or len(user_text) < 2:
            return https_fn.Response(json.dumps({
                "score": 0, 
                "feedback": "내용을 인식할 수 없습니다. 글씨를 조금 더 또렷하게 써주세요!"
            }), status=200, headers=headers) # 헤더 추가

        # 2. 정답지 찾기 (BM25 검색)
        doc_obj = _load_processed_doc_from_firestore(book_id)
        relevant_chunks = search_chunks_with_bm25(doc_obj, user_text, top_k=3)
        
        if not relevant_chunks:
             return https_fn.Response(json.dumps({
                "score": 0, 
                "feedback": "작성하신 내용과 관련된 부분을 책에서 찾을 수 없습니다. 엉뚱한 내용을 쓰신 건 아닌가요?"
            }), status=200, headers=headers) # 헤더 추가

        ground_truth = "\n\n".join([c.text for c in relevant_chunks])

        # 3. 채점 (GPT-4o)
        grading_prompt = f"""
        너는 친절한 학습 튜터야. 사용자가 '백지 복습'을 위해 기억나는 대로 적은 내용과, 실제 교재 내용을 비교해서 채점해줘.

        [교재 원문 (정답지)]
        {ground_truth}

        [사용자가 적은 내용]
        {user_text}

        [채점 기준]
        1. 점수(0~100점): 사용자가 교재의 핵심 개념을 얼마나 정확하게 기억해냈는지 평가.
        2. 피드백: 
           - 잘한 점 (칭찬)
           - 틀린 내용 교정 (Fact Check)
           - 빠뜨린 핵심 키워드 지적
        
        [출력 형식 (JSON)]
        {{
            "score": 85,
            "feedback": "..."
        }}
        """

        grading_resp = openai_client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "system", "content": grading_prompt}],
            response_format={"type": "json_object"}
        )
        
        result_json = json.loads(grading_resp.choices[0].message.content)
        
        # ⭐️ 성공 응답에도 headers를 꼭 넣어야 합니다!
        return https_fn.Response(json.dumps(result_json), status=200, headers=headers)

    except Exception as e:
        print(f"Error: {e}")
        # ⭐️ 에러 응답에도 headers를 꼭 넣어야 합니다!
        return https_fn.Response(json.dumps({"error": str(e)}), status=500, headers=headers)