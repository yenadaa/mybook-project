from firebase_functions import storage_fn, options
from firebase_admin import firestore
from core.config import get_db, get_storage
import os

@storage_fn.on_object_finalized(
    timeout_sec=540,
    memory=options.MemoryOption.GB_2,
    secrets=["OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"]
)
def on_pdf_upload(event: storage_fn.CloudEvent[storage_fn.StorageObjectData]):
    from quiz_generator import (
        PreprocessedDoc, Chunk, Output, ReviewOut, SummaryOut,
        pdf_to_preprocessed_doc, generate_base_review, 
        generate_custom_review
    )
    from langchain_openai import OpenAIEmbeddings
    from langchain_community.vectorstores import SupabaseVectorStore
    from langchain_core.documents import Document
    from supabase import create_client

    db = get_db()
    storage_client = get_storage()

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

    def update_status(msg):
        print(f"--- 📢 [Progress] {msg} ---")
        doc_ref.set({
            "status": "processing",
            "progressMessage": msg,
            "owner_uid": user_id,
            "lastUpdated": firestore.SERVER_TIMESTAMP
        }, merge=True)

    update_status("PDF 다운로드 및 분석 준비 중...")

    try:
        blob = storage_client.blob(file_path)
        pdf_bytes = blob.download_as_bytes()
        update_status("텍스트 추출 및 전처리 중...")
    except Exception as e:
        doc_ref.set({"status": f"error_download: {e}"}, merge=True)
        return

    try:
        processed_doc: "PreprocessedDoc" = pdf_to_preprocessed_doc(
            pdf_bytes=pdf_bytes,
            doc_id=book_id
        )
        if not processed_doc.chunks:
             raise ValueError('PDF에서 텍스트를 추출할 수 없습니다.')
        update_status(f"AI 요약 및 기본 퀴즈 생성 중... ({len(processed_doc.chunks)}개 구간)")
    except Exception as e:
        doc_ref.set({"status": f"error_processing: {e}"}, merge=True)
        return

    try:
        base_review_output: "Output" = generate_base_review(
            processed_doc, 
            model="gpt-4o-mini"
        )
        update_status("심화(하이라이트) 퀴즈 생성 중...")
    except Exception as e:
        doc_ref.set({"status": f"error_base_review: {e}"}, merge=True)
        return

    try:
        all_chunk_ids = [c.id for c in processed_doc.chunks if c.id]
        custom_review_output: "ReviewOut" = generate_custom_review(
            doc=processed_doc,
            chunk_ids=all_chunk_ids,
            keywords=None,
            counts_override={"ox": 0, "short": 0, "discussion": 10},
            model="gpt-4o-mini"
        )
        update_status("챗봇용 지식(Vector) 업로드 중...")
    except Exception as e:
        doc_ref.set({"status": f"error_custom_review: {e}"}, merge=True)
        return

    try:
        supabase_url = os.environ.get("SUPABASE_URL")
        supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
        supabase_client = create_client(supabase_url, supabase_key)
        supabase_embeddings = OpenAIEmbeddings(openai_api_key=os.environ.get("OPENAI_API_KEY"))

        vector_store = SupabaseVectorStore(
            client=supabase_client,
            embedding=supabase_embeddings,
            table_name="documents",
            query_name="match_documents"
        )

        docs_to_upload = []
        for i, chunk in enumerate(processed_doc.chunks): 
            metadata = {
                "bookId": book_id,
                "chunk_index": i 
            }
            if chunk.metadata:
                if "page" in chunk.metadata:
                    metadata["page"] = chunk.metadata["page"] + 1
                elif "page_number" in chunk.metadata:
                    metadata["page"] = chunk.metadata["page_number"]
                else:
                    metadata["page"] = "unknown"
            else:
                 metadata["page"] = "unknown"
            
            if chunk.keywords:
                metadata["keywords"] = chunk.keywords
            if chunk.chapter:
                metadata["chapter"] = chunk.chapter
            
            doc = Document(page_content=chunk.text, metadata=metadata)
            docs_to_upload.append(doc)

        supabase_client.table("documents").delete().eq("metadata->>bookId", book_id).execute()
        
        if docs_to_upload:
            vector_store.add_documents(docs_to_upload)
            print(f"--- ✅ Supabase에 {len(docs_to_upload)}개 벡터 저장 완료 ---")
        else:
            print("--- ⚠️ 업로드할 텍스트 청크가 없습니다. ---")
            
        update_status("모든 데이터 저장 및 마무리 중...")

    except Exception as e:
        print(f"Supabase Upload Error Details: {e}")
        doc_ref.set({"status": f"error_supabase_upload: {e}"}, merge=True)
        return

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
            "progressMessage": "✅ 분석 완료! 퀴즈를 풀어보세요.",
            "lastProcessed": firestore.SERVER_TIMESTAMP,
            "owner_uid": user_id
        }, merge=True) 
        
    except Exception as e:
        doc_ref.set({"status": f"error_saving: {e}"}, merge=True)
        return