import base64
from firebase_functions import https_fn, options
from firebase_admin import initialize_app
from google.cloud import vision

initialize_app()
options.set_global_options(region="asia-northeast3", memory=options.MemoryOption.MB_256)

@https_fn.on_call()
def runOcrOnSelection(req: https_fn.CallableRequest) -> https_fn.Response:
    if req.auth is None:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.UNAUTHENTICATED, message="로그인이 필요합니다.")

    # 1. 프론트엔드에서 보낸 Base64 이미지 데이터 받기
    base64_image = req.data.get("imageData")
    if not base64_image:
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INVALID_ARGUMENT, message="이미지 데이터가 필요합니다.")

    try:
        # 2. Base64 데이터를 이미지 바이트로 디코딩
        image_bytes = base64.b64decode(base64_image)
        
        # 3. Vision API 클라이언트 초기화 및 호출
        client = vision.ImageAnnotatorClient()
        image = vision.Image(content=image_bytes)
        response = client.text_detection(image=image)
        
        # 4. 결과 텍스트 추출 및 반환
        detected_text = response.text_annotations[0].description if response.text_annotations else ""
        
        return {"text": detected_text}

    except Exception as e:
        print(f"OCR 처리 중 오류 발생: {e}")
        raise https_fn.HttpsError(code=https_fn.FunctionsErrorCode.INTERNAL, message="OCR 처리 중 서버에서 오류가 발생했습니다.")