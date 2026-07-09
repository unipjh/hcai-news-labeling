| 배포 URL: https://hcai-news-labeling.vercel.app/

# Task 2: 뉴스 헤드라인 감정 라벨링 웹앱

Task 1에서 선정된 헤드라인을 여러 작업자가 KOTE 44개 감정으로 멀티라벨 라벨링하는 웹앱.
사용 흐름: **URL 접속 → 내 이름 선택 → 라벨링 → 건별 자동저장**. (스펙: `task2_labeling_app_spec.md`)

현재 배포 권장 구조는 **Vercel 정적 프론트엔드 + Firebase Firestore 직접 연결**이다.
설정·업로드·배포 절차는 `docs/firebase-vercel.md` 참고.

## 실행

```bash
cd frontend
npm install
cp .env.example .env.local  # Firebase VITE_* 값 입력
npm run dev
```

데이터 업로드와 Vercel 배포 절차는 `docs/firebase-vercel.md` 참고.
초기 데이터 업로드는 기본 작업자 `Sample` 한 명만 만들고, 이후 작업자는 앱 첫 화면에서 추가한다.
프론트 수정 시 재빌드: `cd frontend && npm run build` (출력이 `frontend/dist`로 감).

## 구조

```
backend/
  app/labels.py     # 44라벨 정본 + 긍/부/중립 그룹(안 B, 2026-07-08 확정)
  app/config.py     # 플래그·DB 경로 (env: LABELING_*)
  app/storage.py    # Storage 인터페이스 + SQLite 구현
  app/main.py       # API + 정적 서빙
  import_csv.py     # Task1 CSV 임포트 + 배정
  data/labeling.db  # SQLite (WAL)
frontend/           # React (Vite) 단일 페이지
docs/screenshots/   # UI 초안 스크린샷
```

## Config 플래그 (기본 모두 off)

| 플래그 | 기본 | 용도 |
|---|---|---|
| `LABELING_SHOW_MODEL_SUGGESTIONS` | false | 모델 top5 추천 행 표시. gold set 오염 방지를 위해 기본 off — 버킷 B 개선용 라벨링 시에만 켤 것 |
| `LABELING_SORT_BY_MODEL` | false | 모델 예측 기반 정렬 (anchoring bias 우려로 기본 가나다순) |

## 배포용 고도화 (2026-07-09)

- **라벨링 가이드 상시 표시**: 라벨링 화면 오른쪽에 가이드 패널(모바일은 상단 접이식).
  감정 표현 선택 안내 · 최소 1~최대 5개 · '저장 후 다음' 필수 · 스킵/수정 방법 · 단축키.
- **라벨 수 제한**: 최소 1개 ~ 최대 5개. 클라이언트(6번째 클릭 차단 + 힌트),
  `api.js` 검증, Firestore Rules(`labels.size() <= 5`) 3중 강제.
- **관리자 페이지**: 첫 화면 하단 링크 → 비밀번호(기본 `1234`,
  `frontend/src/App.jsx`의 `ADMIN_PASSWORD`) → 작업자별 진행 현황(진행률/완료/스킵/세션),
  작업자별·전체 CSV 다운로드, 세션 잠금 해제, 작업자 삭제(이름 재입력 확인, 배정·결과 일괄 삭제).
- **CSV 내보내기**: 라벨링 화면 상단 '내 결과 CSV'(본인 저장분), 완료 배너의 다운로드 버튼,
  관리자 페이지의 작업자별/전체 내보내기. UTF-8 BOM(엑셀 호환), 라벨은 `|` 구분.
- **저장된 라벨링 조회 (2026-07-10)**: 데이터 목록의 '라벨링' 열에 라벨링한 작업자 버튼 표시,
  클릭 시 팝업으로 저장된 감정(또는 스킵 사유)·저장 시각 확인. 주의 — 목록은 라벨링 전
  작업자도 볼 수 있으므로 타인 라벨 열람에 따른 anchoring bias 가능성 있음(운영 시 안내 권장).
- **저장 비용/안정성**: 저장 후 전체 큐 재조회 제거(저장 1건당 Firestore 읽기 ~2,000건 → 0건,
  진행률은 클라이언트 파생). 미저장 편집은 localStorage에 보존되어 새로고침 후 복원,
  미저장 상태로 창을 닫으면 브라우저 경고.
- **로컬 통합 테스트**: `firebase.json` + `VITE_FIREBASE_EMULATOR=1`로 Firestore/Auth
  에뮬레이터에 연결해 실데이터 오염 없이 전체 플로우 테스트 가능 (Java 21 필요).

## 동작 규칙

- **배정 (2026-07-08 확정: k=3 전원 중복)**: 모든 작업자가 동일한 전체 건을 라벨링하되,
  큐 순서는 작업자별 seed 셔플로 서로 다름 — 같은 기사를 같은 작업 시점에 보는 데서 오는
  순서 효과(피로도·학습 효과 동조)를 IAA에서 분리하기 위함.
- **데이터 목록**: 온보딩 화면 '라벨링 대상 데이터 목록 보기'로 전체 1,000건 열람
  (검색·버킷 필터, 모델 예측은 bias 방지를 위해 미표시).
- 저장은 건별 즉시(upsert). 서버 성공 응답 후에만 다음 건으로 이동, 실패 시 에러 배너 + 재시도.
- 미저장 편집은 세션 내 draft로 유지(이전/다음 이동해도 유실 없음), '미저장 변경' 배지 표시.
- **세션 이어하기**: 같은 브라우저 재접속 시 자동 복원(이름=localStorage, 잠금=익명 UID,
  미저장 편집=localStorage). '세션 종료'는 다른 기기·브라우저로 옮길 때만 필요 —
  미저장 편집은 기기 간 이동되지 않으므로 옮기기 전 저장 필수. 시크릿 창은 닫으면
  UID가 사라져 이어하기 불가(관리자 잠금 해제 필요).
- '없음'은 다른 라벨과 배타 (서버에서도 검증). 라벨은 최대 5개 (서버에서도 검증).
- 빈 선택 저장 → "감정 없음으로 저장할까요?" 확인 후 `["없음"]`으로 저장.
- 스킵은 사유(판단 불가/뉴스 아님/텍스트 깨짐/기타) 필수.
- 키보드: `Enter` 저장 후 다음 · `←/→` 이전/다음 · `/` 라벨 검색 · `Esc` 모달 닫기.

## Firebase(Firestore) 전환 대비

현재 개편판은 프론트엔드에서 Firebase Web SDK로 Firestore를 직접 사용한다.
- `frontend/src/api.js`: Firestore CRUD + Anonymous Auth + 관리자 기능
- `firestore.rules`: 접근 제어 (수정 시 `tools/deploy_firestore_rules.py`로 재배포 필요)
- `tools/import_csv_to_firestore.py`: CSV·배정 데이터 업로드

**보안 모델 주의**: 관리자 기능(전체 결과 열람·삭제·잠금 해제)을 앱에서 쓸 수 있도록
Rules가 `signedIn()` 수준으로 완화되어 있다. 비밀번호 게이트는 UI 편의 장치일 뿐이므로,
링크를 아는 내부 인원만 쓰는 소규모 라벨링 용도로만 적합하다. 쓰기(라벨 저장)는 여전히
작업자 잠금 소유 브라우저만 가능하고 라벨 검증도 서버에서 강제된다.

## 데이터 주의

- 원본 DB publisher가 '기타'인 기사가 다수(1,000건 중 696건) — 앱 문제 아님.
- annotator_id + created_at/updated_at 기록됨 (추후 IAA 계산용).
