"""Upload the labeling CSV and assignments to Firestore.

This is a local setup tool. It uses Firebase Admin credentials and is not part
of the Vercel frontend runtime.
"""
from __future__ import annotations

import argparse
import csv
import random
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore


COLLECTIONS = ("annotations", "assignments", "articles", "annotators", "annotatorAccess")


def load_articles(csv_path: Path) -> list[dict]:
    articles = []
    with csv_path.open(encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            probs = [float(p) for p in row.get("model_top5_probs", "").split(";") if p]
            articles.append({
                "article_id": int(row["article_id"]),
                "headline": row["headline"],
                "press": row.get("press", ""),
                "category": row.get("category", ""),
                "published_at": row.get("published_at", ""),
                "bucket": row.get("bucket", ""),
                "model_top5_labels": [
                    label for label in row.get("model_top5_labels", "").split(";") if label
                ],
                "model_top5_probs": probs,
            })
    return articles


def commit_batches(db, writes: list[tuple[str, str, dict]], batch_size: int = 450) -> None:
    for start in range(0, len(writes), batch_size):
        batch = db.batch()
        for collection_name, doc_id, data in writes[start:start + batch_size]:
            batch.set(db.collection(collection_name).document(doc_id), data)
        batch.commit()


def delete_collection(db, collection_name: str, batch_size: int = 300) -> None:
    while True:
        docs = list(db.collection(collection_name).limit(batch_size).stream())
        if not docs:
            return
        batch = db.batch()
        for doc in docs:
            batch.delete(doc.reference)
        batch.commit()


def validate_annotators(names: list[str]) -> None:
    bad = [name for name in names if "/" in name or not name]
    if bad:
        raise ValueError(f"Firestore 문서 ID로 쓸 수 없는 작업자명: {bad}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True, type=Path)
    parser.add_argument("--annotators", default="Sample", help="쉼표 구분 작업자 이름 목록 (기본: Sample)")
    parser.add_argument("--k", type=int, help="중복 라벨링 배수 (기본: 작업자 수)")
    parser.add_argument("--seed", type=int, default=42, help="배정 셔플 seed")
    parser.add_argument("--credentials", type=Path, help="Firebase service account JSON")
    parser.add_argument("--replace", action="store_true", help="기존 Firestore 데이터를 삭제 후 업로드")
    args = parser.parse_args()

    names = [name.strip() for name in args.annotators.split(",") if name.strip()]
    validate_annotators(names)
    k = args.k if args.k is not None else len(names)
    if k > len(names):
        raise ValueError(f"k({k})가 작업자 수({len(names)})보다 큼")

    if args.credentials:
        firebase_admin.initialize_app(credentials.Certificate(args.credentials))
    else:
        firebase_admin.initialize_app()
    db = firestore.client()

    if args.replace:
        for collection_name in COLLECTIONS:
            delete_collection(db, collection_name)

    articles = load_articles(args.csv)
    random.Random(args.seed).shuffle(articles)

    writes: list[tuple[str, str, dict]] = []
    for name in names:
        writes.append(("annotators", name, {"annotator_id": name, "name": name}))

    for article in articles:
        writes.append(("articles", str(article["article_id"]), article))

    n = len(names)
    assigned: dict[str, list[int]] = {name: [] for name in names}
    for i, article in enumerate(articles):
        for j in range(k):
            assigned[names[(i + j) % n]].append(article["article_id"])

    counts = {}
    for name, ids in assigned.items():
        random.Random(f"{args.seed}:{name}").shuffle(ids)
        counts[name] = len(ids)
        for position, article_id in enumerate(ids):
            doc_id = f"{name}_{article_id}"
            writes.append(("assignments", doc_id, {
                "assignment_id": doc_id,
                "article_id": article_id,
                "annotator_id": name,
                "position": position,
                "status": "pending",
            }))

    commit_batches(db, writes)
    print({
        "articles": len(articles),
        "annotators": names,
        "k": k,
        "seed": args.seed,
        "assignments_per_annotator": counts,
        "replace": args.replace,
    })


if __name__ == "__main__":
    main()
