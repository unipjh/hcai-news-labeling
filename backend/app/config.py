"""앱 설정. 환경변수로 override 가능 (LABELING_ 접두사).

- sort_by_model: 라벨 칩을 모델 예측 확률순으로 정렬 (anchoring bias 우려로 기본 off)
- show_model_suggestions: 모델 top5 추천 행 표시 (gold set 오염 방지 위해 기본 off,
  버킷 B 개선용 라벨링 시에만 켤 것)
- storage_backend: sqlite | firestore(미구현, 인터페이스만 예약)
"""
from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    model_config = {"env_prefix": "LABELING_"}

    db_path: Path = Path(__file__).resolve().parent.parent / "data" / "labeling.db"
    storage_backend: str = "sqlite"
    sort_by_model: bool = False
    show_model_suggestions: bool = False
    # 중복 라벨링 배수 (임포트 시 사용). 작업자 수와 같으면 전원이 전체를 라벨링.
    # 2026-07-08 확정: 3명 전원 중복(k=3) — IAA 산출 목적
    duplication_k: int = 3


settings = Settings()
