"""Seed a small article set into the Firestore emulator (rules bypassed via Bearer owner)."""
import csv
import requests

CSV_PATH = "/home/user/projects1/pjh/lab-w20/task1-label-data-select/outputs/sampled_for_labeling_v1.csv"
BASE = "http://127.0.0.1:8089/v1/projects/hcai-news-la/databases/(default)/documents"
HEADERS = {"Authorization": "Bearer owner"}
N = 15

def field(value):
    if isinstance(value, bool):
        return {"booleanValue": value}
    if isinstance(value, int):
        return {"integerValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, list):
        return {"arrayValue": {"values": [field(v) for v in value]}}
    return {"stringValue": str(value)}

with open(CSV_PATH, encoding="utf-8-sig") as f:
    rows = list(csv.DictReader(f))[:N]

for row in rows:
    article_id = int(row["article_id"])
    doc = {
        "article_id": article_id,
        "headline": row["headline"],
        "press": row["press"],
        "category": row["category"],
        "published_at": row["published_at"],
        "bucket": row["bucket"],
        "model_top5_labels": row["model_top5_labels"].split(";"),
        "model_top5_probs": [float(p) for p in row["model_top5_probs"].split(";")],
    }
    r = requests.patch(
        f"{BASE}/articles/{article_id}",
        headers=HEADERS,
        json={"fields": {k: field(v) for k, v in doc.items()}},
    )
    r.raise_for_status()

print(f"seeded {len(rows)} articles")
