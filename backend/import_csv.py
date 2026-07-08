"""Task 1 산출 CSV를 라벨링 DB로 임포트하고 작업자에게 라운드로빈 배정한다.

사용법:
    python import_csv.py --csv ../../task1-label-data-select/outputs/sampled_for_labeling_v1.csv \
        --annotators "작업자A,작업자B,작업자C" [--k 1] [--seed 42] [--replace]

- 배정 전 seed 고정 셔플로 버킷(A/B/C)이 각 작업자 큐에 골고루 섞이게 한다
  (CSV는 버킷순 정렬이라 그대로 배정하면 큐 앞부분이 버킷 A로 쏠림).
- --replace: 기존 데이터 전체 삭제 후 재임포트 (라벨링 시작 후에는 사용 금지).
- 증분 임포트(명단 유지, 새 기사 추가)는 --replace 없이 실행하면 된다.
"""
from __future__ import annotations

import argparse
import csv
import json
import random
from pathlib import Path

from app.config import settings
from app.storage import get_storage


def load_articles(csv_path: Path) -> list[dict]:
    articles = []
    with open(csv_path, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            articles.append({
                "article_id": int(row["article_id"]),
                "headline": row["headline"],
                "press": row.get("press", ""),
                "category": row.get("category", ""),
                "published_at": row.get("published_at", ""),
                "bucket": row.get("bucket", ""),
                "model_top5_labels": json.dumps(
                    row.get("model_top5_labels", "").split(";"), ensure_ascii=False),
                "model_top5_probs": json.dumps(
                    [float(p) for p in row.get("model_top5_probs", "").split(";") if p]),
            })
    return articles


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, type=Path)
    ap.add_argument("--annotators", required=True,
                    help="쉼표 구분 작업자 이름 목록")
    ap.add_argument("--k", type=int, default=settings.duplication_k,
                    help="중복 라벨링 배수 (기본 1)")
    ap.add_argument("--seed", type=int, default=42, help="배정 셔플 seed")
    ap.add_argument("--db", type=Path, default=settings.db_path)
    ap.add_argument("--replace", action="store_true",
                    help="기존 데이터 전체 삭제 후 재임포트")
    args = ap.parse_args()

    names = [n.strip() for n in args.annotators.split(",") if n.strip()]
    articles = load_articles(args.csv)
    random.Random(args.seed).shuffle(articles)

    storage = get_storage(settings.storage_backend, args.db)
    summary = storage.import_dataset(articles, names, args.k, args.replace, args.seed)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"db: {args.db}")


if __name__ == "__main__":
    main()
