import fitz
from firebase_functions import https_fn, options
from firebase_admin import initialize_app, firestore
from google.cloud import vision, storage
from PIL import Image
import io

initialize_app()

options.set_global_options(region="asia-northeast3", memory=options.MemoryOption.GB_1)

@https_fn.on_call()
def runOcrOnDemand(req: https_fn.CallableRequest) -> https_fn.Response:
    if req.auth is None:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.UNAUTHENTICATED, message="로그인이 필요합니다.")

    file_path = req.data.get("filePath")
    if not file_path:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT, message="파일 경로(filePath)가 필요합니다.")

    vision_client = vision.ImageAnnotatorClient()
    db = firestore.client()
    storage_client = storage.Client()
    
    bucket_name = "mybook-d143d.firebasestorage.app"
    
    print(f"OCR 요청 접수: {file_path}")

    bucket = storage_client.bucket(bucket_name)
    blob = bucket.blob(file_path)
    try:
        pdf_bytes = blob.download_as_bytes()
    except Exception as e:
        print(f"파일 다운로드 실패: {e}")
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.NOT_FOUND, message="Storage에서 파일을 찾을 수 없습니다.")

    pdf_document = fitz.open(stream=pdf_bytes, filetype="pdf")
    batch = db.batch()
    total_words = 0

    for page_num in range(len(pdf_document)):
        page = pdf_document.load_page(page_num)
        image_list = page.get_images(full=True)

        if not image_list:
            continue

        for image_index, img in enumerate(image_list):
            xref = img[0]
            base_image = pdf_document.extract_image(xref)
            image_bytes = base_image["image"]

            # ▼▼▼ 원본 이미지 크기 가져오기 ▼▼▼
            try:
                image_for_size = Image.open(io.BytesIO(image_bytes))
                img_width, img_height = image_for_size.size
            except Exception:
                img_width, img_height = 0, 0 # 크기를 알 수 없는 경우
            # ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲

            image = vision.Image(content=image_bytes)
            image_context = vision.ImageContext(language_hints=["ko", "en"])
            response = vision_client.document_text_detection(image=image, image_context=image_context)
            
            if response.full_text_annotation:
                page_data = response.full_text_annotation.pages[0]
                words_data = []

                for block in page_data.blocks:
                    for paragraph in block.paragraphs:
                        for word in paragraph.words:
                            word_text = "".join([symbol.text for symbol in word.symbols])
                            vertices = [{"x": v.x, "y": v.y} for v in word.bounding_box.vertices]
                            words_data.append({"text": word_text, "bounds": vertices})
                
                total_words += len(words_data)
                doc_ref = db.collection("ocr_results").document()
                batch.set(doc_ref, {
                    "sourceFile": file_path,
                    "pageNumber": page_num + 1,
                    "imageIndex": image_index,
                    "words": words_data,
                    "createdAt": firestore.SERVER_TIMESTAMP,
                    # ▼▼▼ 이미지 크기 정보 추가 ▼▼▼
                    "imageDimensions": {"width": img_width, "height": img_height}
                    # ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲
                })

    batch.commit()
    return {"status": "success", "message": f"OCR analysis complete. Found {total_words} words."}