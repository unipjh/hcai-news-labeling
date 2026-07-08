"""저장소 계층. Storage 인터페이스 뒤에 SQLite 구현을 둔다.

Firebase(Firestore) 전환 대비:
- API/임포트 코드는 이 인터페이스만 사용하고 SQL을 직접 만지지 않는다.
- 스키마는 문서형으로 옮기기 쉽게 유지 — annotations는 (article_id, annotator_id)
  단위 upsert 문서, labels는 JSON 배열. Firestore 구현 시 FirestoreStorage가
  같은 메서드를 구현하고 config.storage_backend로 선택하면 된다.
"""
from __future__ import annotations

import json
import random
import sqlite3
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS annotators (
    annotator_id TEXT PRIMARY KEY,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS articles (
    article_id INTEGER PRIMARY KEY,
    headline TEXT NOT NULL,
    press TEXT,
    category TEXT,
    published_at TEXT,
    bucket TEXT,
    model_top5_labels TEXT NOT NULL DEFAULT '[]',
    model_top5_probs TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS assignments (
    article_id INTEGER NOT NULL REFERENCES articles(article_id),
    annotator_id TEXT NOT NULL REFERENCES annotators(annotator_id),
    position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'done', 'skipped')),
    PRIMARY KEY (article_id, annotator_id)
);
CREATE INDEX IF NOT EXISTS idx_assignments_queue
    ON assignments (annotator_id, position);
CREATE TABLE IF NOT EXISTS annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL,
    annotator_id TEXT NOT NULL,
    labels TEXT NOT NULL,
    is_skipped INTEGER NOT NULL DEFAULT 0,
    skip_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (article_id, annotator_id)
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Storage(ABC):
    @abstractmethod
    def list_annotators(self) -> list[dict]: ...

    @abstractmethod
    def get_queue(self, annotator_id: str) -> list[dict]:
        """배정 순서대로 기사 + 현재 상태 + 기존 저장 내용을 반환."""

    @abstractmethod
    def get_progress(self, annotator_id: str) -> dict: ...

    @abstractmethod
    def save_annotation(self, article_id: int, annotator_id: str, labels: list[str],
                        is_skipped: bool, skip_reason: str | None) -> dict:
        """upsert + assignment 상태 갱신을 원자적으로 수행. 갱신된 진행률 반환."""

    @abstractmethod
    def list_articles(self) -> list[dict]:
        """전체 라벨링 대상 목록 (데이터 목록 화면용)."""

    @abstractmethod
    def import_dataset(self, articles: list[dict], annotator_names: list[str],
                       k: int, replace: bool, seed: int) -> dict: ...


class SQLiteStorage(Storage):
    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.db_path = db_path
        with self._conn() as conn:
            conn.executescript(SCHEMA)

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def list_annotators(self) -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT annotator_id, name FROM annotators ORDER BY name"
            ).fetchall()
        return [dict(r) for r in rows]

    def get_queue(self, annotator_id: str) -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute(
                """
                SELECT a.article_id, a.headline, a.press, a.category, a.published_at,
                       a.bucket, a.model_top5_labels, a.model_top5_probs,
                       s.position, s.status,
                       n.labels AS saved_labels, n.is_skipped, n.skip_reason
                FROM assignments s
                JOIN articles a ON a.article_id = s.article_id
                LEFT JOIN annotations n
                    ON n.article_id = s.article_id AND n.annotator_id = s.annotator_id
                WHERE s.annotator_id = ?
                ORDER BY s.position
                """,
                (annotator_id,),
            ).fetchall()
        items = []
        for r in rows:
            d = dict(r)
            d["model_top5_labels"] = json.loads(d["model_top5_labels"])
            d["model_top5_probs"] = json.loads(d["model_top5_probs"])
            d["saved_labels"] = json.loads(d["saved_labels"]) if d["saved_labels"] else None
            d["is_skipped"] = bool(d["is_skipped"])
            items.append(d)
        return items

    def get_progress(self, annotator_id: str) -> dict:
        with self._conn() as conn:
            row = conn.execute(
                """
                SELECT COUNT(*) AS total,
                       SUM(status = 'done') AS done,
                       SUM(status = 'skipped') AS skipped
                FROM assignments WHERE annotator_id = ?
                """,
                (annotator_id,),
            ).fetchone()
        total = row["total"] or 0
        done = row["done"] or 0
        skipped = row["skipped"] or 0
        return {"total": total, "done": done, "skipped": skipped,
                "pending": total - done - skipped}

    def save_annotation(self, article_id: int, annotator_id: str, labels: list[str],
                        is_skipped: bool, skip_reason: str | None) -> dict:
        now = _now()
        status = "skipped" if is_skipped else "done"
        with self._conn() as conn:
            assigned = conn.execute(
                "SELECT 1 FROM assignments WHERE article_id = ? AND annotator_id = ?",
                (article_id, annotator_id),
            ).fetchone()
            if not assigned:
                raise KeyError(f"배정되지 않은 건: article={article_id}, annotator={annotator_id}")
            conn.execute(
                """
                INSERT INTO annotations
                    (article_id, annotator_id, labels, is_skipped, skip_reason,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (article_id, annotator_id) DO UPDATE SET
                    labels = excluded.labels,
                    is_skipped = excluded.is_skipped,
                    skip_reason = excluded.skip_reason,
                    updated_at = excluded.updated_at
                """,
                (article_id, annotator_id, json.dumps(labels, ensure_ascii=False),
                 int(is_skipped), skip_reason, now, now),
            )
            conn.execute(
                "UPDATE assignments SET status = ? WHERE article_id = ? AND annotator_id = ?",
                (status, article_id, annotator_id),
            )
        return self.get_progress(annotator_id)

    def list_articles(self) -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute(
                """
                SELECT article_id, headline, press, category, published_at, bucket
                FROM articles ORDER BY published_at DESC, article_id DESC
                """
            ).fetchall()
        return [dict(r) for r in rows]

    def import_dataset(self, articles: list[dict], annotator_names: list[str],
                       k: int, replace: bool, seed: int) -> dict:
        if k > len(annotator_names):
            raise ValueError(f"k({k})가 작업자 수({len(annotator_names)})보다 큼")
        with self._conn() as conn:
            if replace:
                for table in ("annotations", "assignments", "articles", "annotators"):
                    conn.execute(f"DELETE FROM {table}")
            for name in annotator_names:
                conn.execute(
                    "INSERT OR IGNORE INTO annotators (annotator_id, name) VALUES (?, ?)",
                    (name, name),
                )
            conn.executemany(
                """
                INSERT OR REPLACE INTO articles
                    (article_id, headline, press, category, published_at, bucket,
                     model_top5_labels, model_top5_probs)
                VALUES (:article_id, :headline, :press, :category, :published_at,
                        :bucket, :model_top5_labels, :model_top5_probs)
                """,
                articles,
            )
            # 1) 라운드로빈 배정: 기사 i → annotators[(i+j) % n], j in 0..k-1
            #    (k = 작업자 수이면 전원이 전체를 라벨링)
            n = len(annotator_names)
            assigned: dict[str, list[int]] = {name: [] for name in annotator_names}
            for i, art in enumerate(articles):
                for j in range(k):
                    assigned[annotator_names[(i + j) % n]].append(art["article_id"])
            # 2) 작업자별 큐 순서는 서로 다른 seed로 셔플 — 같은 기사를 같은 시점에
            #    보는 데서 오는 순서 효과(피로도·학습 효과 동조)를 IAA에서 분리
            counts = {}
            for name, ids in assigned.items():
                random.Random(f"{seed}:{name}").shuffle(ids)
                conn.executemany(
                    """
                    INSERT OR IGNORE INTO assignments
                        (article_id, annotator_id, position) VALUES (?, ?, ?)
                    """,
                    [(aid, name, pos) for pos, aid in enumerate(ids)],
                )
                counts[name] = len(ids)
        return {"articles": len(articles), "annotators": annotator_names,
                "k": k, "seed": seed, "assignments_per_annotator": counts}


def get_storage(backend: str, db_path: Path) -> Storage:
    if backend == "sqlite":
        return SQLiteStorage(db_path)
    if backend == "firestore":
        raise NotImplementedError(
            "FirestoreStorage 미구현 — Storage 인터페이스를 구현해 여기 등록할 것"
        )
    raise ValueError(f"알 수 없는 storage_backend: {backend}")
