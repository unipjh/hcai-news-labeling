"""라벨링 웹앱 API + 프론트엔드 정적 서빙.

실행: uvicorn app.main:app --host 0.0.0.0 --port 8020 (backend/ 에서)
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

from .config import settings
from .labels import GROUPS, LABELS, NONE_LABEL, SKIP_REASONS
from .storage import get_storage

app = FastAPI(title="KOTE 헤드라인 라벨링")
storage = get_storage(settings.storage_backend, settings.db_path)

LABEL_SET = set(LABELS)


class AnnotationIn(BaseModel):
    article_id: int
    annotator_id: str
    labels: list[str] = []
    is_skipped: bool = False
    skip_reason: str | None = None

    @field_validator("labels")
    @classmethod
    def labels_must_be_known(cls, v: list[str]) -> list[str]:
        unknown = set(v) - LABEL_SET
        if unknown:
            raise ValueError(f"알 수 없는 라벨: {unknown}")
        if len(v) != len(set(v)):
            raise ValueError("라벨 중복")
        if NONE_LABEL in v and len(v) > 1:
            raise ValueError(f"'{NONE_LABEL}'은 다른 라벨과 동시 선택 불가")
        return v


@app.get("/api/meta")
def get_meta():
    """라벨 그룹, 스킵 사유, UI 플래그 — 프론트가 기동 시 1회 로드."""
    return {
        "groups": [{"name": name, "labels": labels} for name, labels in GROUPS.items()],
        "none_label": NONE_LABEL,
        "skip_reasons": SKIP_REASONS,
        "flags": {
            "sort_by_model": settings.sort_by_model,
            "show_model_suggestions": settings.show_model_suggestions,
        },
    }


@app.get("/api/annotators")
def list_annotators():
    return storage.list_annotators()


@app.get("/api/articles")
def list_articles():
    """라벨링 대상 전체 목록 (온보딩 데이터 목록 화면용 — 모델 예측은 미포함)."""
    return storage.list_articles()


@app.get("/api/queue/{annotator_id}")
def get_queue(annotator_id: str):
    if annotator_id not in {a["annotator_id"] for a in storage.list_annotators()}:
        raise HTTPException(404, "등록되지 않은 작업자")
    return {
        "items": storage.get_queue(annotator_id),
        "progress": storage.get_progress(annotator_id),
    }


@app.post("/api/annotations")
def save_annotation(body: AnnotationIn):
    if body.is_skipped:
        if not body.skip_reason or body.skip_reason not in SKIP_REASONS:
            raise HTTPException(422, f"스킵 사유 필요 (하나 선택: {SKIP_REASONS})")
    elif not body.labels:
        raise HTTPException(422, f"라벨 없이 저장 불가 — 감정 없음은 ['{NONE_LABEL}']로 저장")
    try:
        progress = storage.save_annotation(
            body.article_id, body.annotator_id, body.labels,
            body.is_skipped, body.skip_reason if body.is_skipped else None,
        )
    except KeyError as e:
        raise HTTPException(404, str(e))
    return {"ok": True, "progress": progress}


STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
