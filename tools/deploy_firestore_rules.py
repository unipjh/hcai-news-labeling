"""firestore.rules를 Firebase 프로젝트에 배포한다 (Rules REST API + 서비스 계정).

사용법:
    python tools/deploy_firestore_rules.py --credentials ./service-account.json
"""
import argparse
import json
import pathlib

import google.auth.transport.requests
import requests
from google.oauth2 import service_account

ROOT = pathlib.Path(__file__).resolve().parent.parent
API = "https://firebaserules.googleapis.com/v1"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--credentials", required=True, help="서비스 계정 JSON 경로")
    parser.add_argument("--rules", default=str(ROOT / "firestore.rules"))
    args = parser.parse_args()

    creds = service_account.Credentials.from_service_account_file(
        args.credentials,
        scopes=["https://www.googleapis.com/auth/firebase"],
    )
    creds.refresh(google.auth.transport.requests.Request())
    project = json.load(open(args.credentials))["project_id"]
    headers = {"Authorization": f"Bearer {creds.token}"}
    source = open(args.rules, encoding="utf-8").read()

    r = requests.post(
        f"{API}/projects/{project}/rulesets",
        headers=headers,
        json={"source": {"files": [{"name": "firestore.rules", "content": source}]}},
    )
    r.raise_for_status()
    ruleset_name = r.json()["name"]

    release = f"projects/{project}/releases/cloud.firestore"
    r = requests.patch(
        f"{API}/{release}",
        headers=headers,
        json={"release": {"name": release, "rulesetName": ruleset_name}},
    )
    if r.status_code == 404:
        r = requests.post(
            f"{API}/projects/{project}/releases",
            headers=headers,
            json={"name": release, "rulesetName": ruleset_name},
        )
    r.raise_for_status()
    print(f"배포 완료: {project} ← {ruleset_name}")


if __name__ == "__main__":
    main()
