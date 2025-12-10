from firebase_functions import https_fn
from firebase_admin import firestore
import json

# ❌ [삭제됨] 파일 맨 위의 db = firestore.client() 제거!

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
        # ✅ [이동] 함수가 실행될 때 DB 연결 (배포 시에는 실행 안 됨)
        db = firestore.client()

        data = req.get_json(silent=True)
        print(f"🔵 [Save] Received Data: {data}")

        if not data:
            return https_fn.Response(json.dumps({'error': 'JSON 데이터가 비어있습니다.'}), status=400)

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

# 2. 화이트보드 불러오기 함수
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

        # [수정] force=True 추가 (헤더 무시하고 강제로 JSON 파싱)
        data = req.get_json(silent=True, force=True)
        
        # [디버깅] 만약 JSON 파싱 실패했으면 raw data라도 찍어봄
        if not data:
            print(f"⚠️ JSON Parsing Failed. Raw Data: {req.data}")
            # 최후의 수단: 문자열로 들어온 경우 수동 파싱 시도
            try:
                data = json.loads(req.data)
            except:
                pass

        print(f"🔵 [Load] Final Data: {data}")

        if not data or 'bookId' not in data:
            print("🔴 [Load Error] bookId is missing!")
            return https_fn.Response(
                json.dumps({'error': 'bookId가 필요합니다. 데이터가 전송되지 않았습니다.'}), 
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