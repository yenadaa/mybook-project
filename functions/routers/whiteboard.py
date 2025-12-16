from firebase_functions import https_fn
from firebase_admin import firestore
import json

# 1. 화이트보드 저장 함수
@https_fn.on_request()
def saveWhiteboard(req: https_fn.Request) -> https_fn.Response:
    # CORS 처리
    if req.method == "OPTIONS":
        return https_fn.Response(status=204, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "Content-Type",
        })

    try:
        db = firestore.client()

        # ⭐️ [수정] force=True 추가 (안전장치)
        data = req.get_json(silent=True, force=True)
        
        # 데이터가 문자열로 들어왔을 경우 대비 (수동 파싱)
        if not data and req.data:
            try:
                data = json.loads(req.data)
            except:
                pass

        print(f"🔵 [Save] Received Data: {data}")

        if not data:
            return https_fn.Response(json.dumps({'error': '데이터가 비어있습니다.'}), status=400, headers={"Access-Control-Allow-Origin": "*"})

        book_id = str(data.get('bookId'))
        
        doc_ref = db.collection('whiteboards').document(book_id)
        doc_ref.set({
            'text': data.get('text', ''),
            'imageData': data.get('imageData', ''),
            'updatedAt': firestore.SERVER_TIMESTAMP
        })
        
        return https_fn.Response(
            json.dumps({'success': True}), 
            status=200, 
            headers={"Access-Control-Allow-Origin": "*", "Content-Type": "application/json"}
        )
    except Exception as e:
        print(f"🔴 [Save Error] {str(e)}")
        return https_fn.Response(
            json.dumps({'error': str(e)}), 
            status=500, 
            headers={"Access-Control-Allow-Origin": "*", "Content-Type": "application/json"}
        )

# 2. 화이트보드 불러오기 함수 (기존 코드 유지하되 주석 정리)
@https_fn.on_request()
def loadWhiteboard(req: https_fn.Request) -> https_fn.Response:
    # CORS 처리
    if req.method == "OPTIONS":
        return https_fn.Response(status=204, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "Content-Type",
        })

    try:
        db = firestore.client()

        # force=True로 강제 파싱 (이미 잘 되어 있음)
        data = req.get_json(silent=True, force=True)
        
        if not data and req.data:
            try:
                data = json.loads(req.data)
            except:
                pass

        print(f"🔵 [Load] Final Data: {data}")

        if not data or 'bookId' not in data:
            print("🔴 [Load Error] bookId is missing!")
            return https_fn.Response(
                json.dumps({'error': 'bookId가 필요합니다.'}), 
                status=400,
                headers={"Access-Control-Allow-Origin": "*", "Content-Type": "application/json"}
            )

        book_id = str(data.get('bookId'))
        
        doc_ref = db.collection('whiteboards').document(book_id)
        doc = doc_ref.get()
        
        result = {}
        if doc.exists:
            result = doc.to_dict()
            if 'updatedAt' in result:
                del result['updatedAt'] 
        else:
            # 문서가 없으면 빈 값 반환 (에러 아님)
            result = {'text': '', 'imageData': ''}
            
        return https_fn.Response(
            json.dumps(result), 
            status=200, 
            headers={"Access-Control-Allow-Origin": "*", "Content-Type": "application/json"}
        )
    except Exception as e:
        print(f"🔴 [Load Exception] {str(e)}")
        return https_fn.Response(
            json.dumps({'error': str(e)}), 
            status=500, 
            headers={"Access-Control-Allow-Origin": "*", "Content-Type": "application/json"}
        )