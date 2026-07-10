"""task2 Firestore 타깃 반영 — 22건 기사 교체 + 텍스트 갱신 (진행분 보존).

- 교체 22건: old article 문서/배정 삭제 → new article 문서/배정 생성(position 유지)
- 텍스트 갱신: article_id 동일, headline 만 한자수정본으로 업데이트
- 기존 annotations·annotatorAccess·position 은 건드리지 않음 (교체 22건에 라벨 없음 확인됨)
- 실행 전 영향 문서를 JSON 백업

사용법:
  python tools/migrate_fixed_articles.py --credentials service-account.json \
      --old outputs/.../sampled_for_labeling_v1.csv --new outputs/.../sampled_for_labeling_v1_fixed.csv [--apply]
  (--apply 없으면 dry-run: 백업+계획만 출력)
"""
import argparse
import csv
import json
from datetime import datetime
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore


def load(csv_path):
    rows = {}
    with open(csv_path, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            rows[int(r["article_id"])] = r
    return rows


def article_doc(r):
    probs = [float(p) for p in r.get("model_top5_probs", "").split(";") if p]
    return {
        "article_id": int(r["article_id"]),
        "headline": r["headline"],
        "press": r.get("press", ""),
        "category": r.get("category", ""),
        "published_at": r.get("published_at", ""),
        "bucket": r.get("bucket", ""),
        "model_top5_labels": [x for x in r.get("model_top5_labels", "").split(";") if x],
        "model_top5_probs": probs,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--credentials", required=True)
    ap.add_argument("--old", required=True)
    ap.add_argument("--new", required=True)
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    old, new = load(args.old), load(args.new)
    old_ids, new_ids = set(old), set(new)
    removed = old_ids - new_ids          # 교체로 사라진 22 old
    added = new_ids - old_ids            # 교체로 들어온 22 new
    kept = old_ids & new_ids
    refreshed = [i for i in kept if old[i]["headline"] != new[i]["headline"]]
    assert len(removed) == len(added), (len(removed), len(added))
    print(f"교체: -{len(removed)} / +{len(added)}   텍스트갱신(headline): {len(refreshed)}건")

    firebase_admin.initialize_app(credentials.Certificate(args.credentials))
    db = firestore.client()

    # ── 영향 문서 백업 ──
    backup = {"removed_articles": {}, "removed_assignments": {},
              "removed_annotations": {}, "refreshed_headlines": {}}
    for i in removed:
        d = db.collection("articles").document(str(i)).get()
        if d.exists:
            backup["removed_articles"][str(i)] = d.to_dict()
        for a in db.collection("assignments").where(filter=firestore.FieldFilter("article_id", "==", i)).stream():
            backup["removed_assignments"][a.id] = a.to_dict()
        # 교체 대상에 걸린 기존 라벨(스킵 포함)은 고아가 되므로 백업 후 삭제
        for an in db.collection("annotations").where(filter=firestore.FieldFilter("article_id", "==", i)).stream():
            backup["removed_annotations"][an.id] = an.to_dict()
    if backup["removed_annotations"]:
        print(f"교체 대상에 걸린 기존 라벨 {len(backup['removed_annotations'])}건 → 백업 후 삭제 예정: "
              f"{list(backup['removed_annotations'].keys())}")
    for i in refreshed:
        d = db.collection("articles").document(str(i)).get()
        if d.exists:
            backup["refreshed_headlines"][str(i)] = d.to_dict().get("headline")
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    bpath = Path(args.credentials).parent / f"firestore_backup_migrate_{ts}.json"
    bpath.write_text(json.dumps(backup, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    print(f"백업 저장: {bpath}  (기사 {len(backup['removed_articles'])} / 배정 {len(backup['removed_assignments'])})")

    # ── 교체 매핑(버킷 기준 1:1): 같은 버킷/emotion 순서로 old↔new 짝짓기 ──
    def key(i, src):
        return (src[i]["bucket"], src[i].get("quota_emotion", ""))
    rem_sorted = sorted(removed, key=lambda i: (key(i, old), i))
    add_sorted = sorted(added, key=lambda i: (key(i, new), i))
    pairs = list(zip(rem_sorted, add_sorted))
    for o, n in pairs:
        if key(o, old) != key(n, new):
            raise SystemExit(f"버킷/감정 불일치 매핑: old {o}{key(o,old)} ↔ new {n}{key(n,new)}")
    print("교체 매핑(버킷/감정 일치 확인):")
    for o, n in pairs:
        print(f"  {o} {key(o,old)}  →  {n}   {new[n]['headline'][:40]}")

    if not args.apply:
        print("\n[dry-run] --apply 없이 종료 (백업만 생성, 쓰기 없음)")
        return

    batch = db.batch(); ops = 0
    def flush():
        nonlocal batch, ops
        if ops:
            batch.commit(); batch = db.batch(); ops = 0
    def add(fn):
        nonlocal ops
        fn(batch); ops += 1
        if ops >= 400:
            flush()

    for o, n in pairs:
        # 배정 이전: old 배정 → new 배정(position 유지)
        for a in db.collection("assignments").where(filter=firestore.FieldFilter("article_id", "==", o)).stream():
            ad = a.to_dict(); name = ad["annotator_id"]; pos = ad["position"]
            newdoc = f"{name}_{n}"
            add(lambda b, r=a.reference: b.delete(r))
            add(lambda b, doc=newdoc, name=name, n=n, pos=pos: b.set(
                db.collection("assignments").document(doc),
                {"assignment_id": doc, "article_id": n, "annotator_id": name,
                 "position": pos, "status": "pending"}))
        # 교체 대상에 걸린 고아 라벨 삭제
        for an in db.collection("annotations").where(filter=firestore.FieldFilter("article_id", "==", o)).stream():
            add(lambda b, r=an.reference: b.delete(r))
        # 기사 문서 교체
        add(lambda b, o=o: b.delete(db.collection("articles").document(str(o))))
        add(lambda b, n=n: b.set(db.collection("articles").document(str(n)), article_doc(new[n])))

    # 텍스트 갱신(headline)
    for i in refreshed:
        add(lambda b, i=i: b.update(db.collection("articles").document(str(i)),
                                    {"headline": new[i]["headline"]}))
    flush()
    print(f"반영 완료. articles 교체 {len(pairs)} / headline 갱신 {len(refreshed)}")


if __name__ == "__main__":
    main()
