"""Release an annotator lock created in annotatorAccess.

Use this when a worker name is stuck because it was claimed from another
browser/origin, or when Firestore rules were not deployed before ending session.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("annotator", help="작업자 이름, 예: Sample")
    parser.add_argument("--credentials", type=Path, default=Path("service-account.json"),
                        help="Firebase service account JSON (default: service-account.json)")
    args = parser.parse_args()

    firebase_admin.initialize_app(credentials.Certificate(args.credentials))
    db = firestore.client()
    ref = db.collection("annotatorAccess").document(args.annotator)
    snap = ref.get()
    if not snap.exists:
        print({"ok": True, "annotator": args.annotator, "message": "lock did not exist"})
        return
    ref.delete()
    print({"ok": True, "annotator": args.annotator, "message": "lock deleted"})


if __name__ == "__main__":
    main()
