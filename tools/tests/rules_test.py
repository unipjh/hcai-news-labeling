"""Server-side security-rules test against the Firestore emulator (bypasses the app UI)."""
import requests

AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake"
FS = "http://127.0.0.1:8089/v1/projects/hcai-news-la/databases/(default)"
DOCS = f"{FS}/documents"
ANN = "규칙테스트"
ARTICLE = 3618214
results = []

def check(name, ok, detail=""):
    results.append((name, ok))
    print(("PASS" if ok else "FAIL"), "-", name, ("| " + detail if detail else ""))

def anon_user():
    r = requests.post(AUTH, json={"returnSecureToken": True})
    r.raise_for_status()
    return r.json()["idToken"]

def commit(token, path, fields, server_time_fields=()):
    write = {
        "update": {"name": f"projects/hcai-news-la/databases/(default)/documents/{path}", "fields": fields},
        "currentDocument": {"exists": False},
    }
    if server_time_fields:
        write["updateTransforms"] = [
            {"fieldPath": f, "setToServerValue": "REQUEST_TIME"} for f in server_time_fields
        ]
    return requests.post(f"{DOCS}:commit", headers={"Authorization": f"Bearer {token}"},
                         json={"writes": [write]})

def s(v): return {"stringValue": v}
def i(v): return {"integerValue": str(v)}
def b(v): return {"booleanValue": v}
def arr(vals): return {"arrayValue": {"values": [s(v) for v in vals]}}

token_a = anon_user()
token_b = anon_user()

# 사전 준비: A가 작업자 잠금·작업자·배정 생성 (앱과 동일한 구조)
r = commit(token_a, f"annotatorAccess/{ANN}",
           {"annotator_id": s(ANN), "uid": s("")}, ())
# uid는 request.auth.uid와 같아야 하므로 토큰에서 localId가 필요 — 다시 발급
r2 = requests.post(AUTH, json={"returnSecureToken": True}); r2.raise_for_status()
token_a, uid_a = r2.json()["idToken"], r2.json()["localId"]

r = commit(token_a, f"annotatorAccess/{ANN}",
           {"annotator_id": s(ANN), "uid": s(uid_a)}, ("claimed_at",))
check("작업자 잠금 생성", r.status_code == 200, r.text[:120] if r.status_code != 200 else "")
r = commit(token_a, f"annotators/{ANN}",
           {"annotator_id": s(ANN), "name": s(ANN)}, ("created_at",))
check("작업자 생성", r.status_code == 200, r.text[:120] if r.status_code != 200 else "")
aid = f"{ANN}_{ARTICLE}"
r = commit(token_a, f"assignments/{aid}",
           {"assignment_id": s(aid), "article_id": i(ARTICLE), "annotator_id": s(ANN),
            "position": i(0), "status": s("pending")})
check("배정 생성", r.status_code == 200, r.text[:120] if r.status_code != 200 else "")

def annotation_write(token, labels, skipped=False):
    fields = {
        "assignment_id": s(aid), "article_id": i(ARTICLE), "annotator_id": s(ANN),
        "labels": arr(labels), "is_skipped": b(skipped), "skip_reason": {"nullValue": None},
    }
    return commit(token, f"annotations/{aid}", fields, ("created_at", "updated_at"))

# 1) 6개 라벨 → 서버에서 거부되어야 함
r = annotation_write(token_a, ["기쁨", "행복", "기대감", "고마움", "존경", "감동/감탄"])
check("서버 규칙: 6개 라벨 저장 거부", r.status_code == 403, f"status={r.status_code}")

# 2) '없음' + 다른 라벨 → 거부
r = annotation_write(token_a, ["없음", "기쁨"])
check("서버 규칙: '없음'+타 라벨 거부", r.status_code == 403, f"status={r.status_code}")

# 3) 목록에 없는 라벨 → 거부
r = annotation_write(token_a, ["사랑"])
check("서버 규칙: 미정의 라벨 거부", r.status_code == 403, f"status={r.status_code}")

# 4) 5개 라벨 → 허용
r = annotation_write(token_a, ["기쁨", "행복", "기대감", "고마움", "존경"])
check("서버 규칙: 5개 라벨 저장 허용", r.status_code == 200, r.text[:200] if r.status_code != 200 else "")

# 5) 다른 사용자가 남의 작업자로 저장 → 거부 (ownsAnnotator)
requests.delete(f"{DOCS}/annotations/{aid}", headers={"Authorization": "Bearer owner"})
r = annotation_write(token_b, ["기쁨"])
check("서버 규칙: 타인 작업자로 저장 거부", r.status_code == 403, f"status={r.status_code}")

# 정리
for path in (f"annotations/{aid}", f"assignments/{aid}", f"annotators/{ANN}", f"annotatorAccess/{ANN}"):
    requests.delete(f"{DOCS}/{path}", headers={"Authorization": "Bearer owner"})

fails = [n for n, ok in results if not ok]
print(f"\nTOTAL {len(results)} checks, {len(fails)} failed", fails or "")
raise SystemExit(1 if fails else 0)
