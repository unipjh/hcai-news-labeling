# Firebase + Vercel frontend deployment

이 개편판은 FastAPI 백엔드 없이 Vite React 앱이 Firestore를 직접 사용한다.
Vercel에는 `frontend/`만 정적 앱으로 배포하고, CSV 업로드는 로컬 Admin 스크립트로 1회 수행한다.

## 1. Firebase 설정

1. Firebase Console에서 프로젝트를 생성한다.
2. Authentication에서 Anonymous provider를 활성화한다.
3. Firestore Database를 생성한다.
4. `firestore.rules` 내용을 Firestore Rules에 배포한다.
5. Project settings > General > Web app을 추가하고 Firebase config 값을 확인한다.

## 2. 로컬 환경변수

`frontend/.env.local`:

```bash
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

## 3. CSV 업로드

서비스 계정 JSON을 받은 뒤 로컬에서 실행한다. JSON 파일은 Git에 커밋하지 않는다.

```bash
cd /home/user/projects1/pjh/lab-w20/task2-labeling-platform
python -m pip install -r tools/requirements.txt
python tools/import_csv_to_firestore.py \
  --credentials ./service-account.json \
  --csv ../task1-label-data-select/outputs/sampled_for_labeling_v1.csv \
  --replace
```

기본 작업자는 `Sample` 한 명이다. `--k`를 생략하면 작업자 수만큼 자동 설정되므로,
초기 Sample 1명 업로드에서는 전체 기사가 Sample에게 배정된다. 추가 작업자는 앱 첫 화면의 입력창에서 만들 수 있고,
생성 시 현재 등록된 전체 기사에 대해 그 작업자의 배정 큐가 자동 생성된다.

`--replace`는 `annotations`, `assignments`, `articles`, `annotators`, `annotatorAccess`를 지운 뒤 다시 올린다.
실제 라벨링 시작 후에는 사용하지 않는다.

## 4. 작업자 잠금 해제

다른 브라우저/주소에서 만든 작업자 잠금 때문에 접속할 수 없으면 관리자 키로 잠금을 해제한다.

```bash
python tools/unlock_annotator.py Sample --credentials ./service-account.json
```

앱 안에서 정상 종료할 때는 상단의 `세션 종료` 버튼을 사용한다.

## 4. Vercel 설정

Vercel 프로젝트 Root Directory를 `frontend`로 설정한다.

- Build Command: `npm run build`
- Output Directory: `dist`
- Environment Variables: `.env.local`과 같은 `VITE_FIREBASE_*` 값

## 보안 모델

- 모든 사용자는 Anonymous Auth로 로그인된다.
- 첫 데이터 업로드는 `Sample` 작업자만 만든다.
- 새 작업자는 앱 첫 화면에서 추가할 수 있으며, 추가한 브라우저 UID가 `annotatorAccess/{annotatorId}`를 생성한다.
- 이후 해당 UID만 그 작업자의 `assignments`와 `annotations`를 읽고 쓸 수 있다.
- `articles`와 `annotators`는 로그인한 사용자에게 읽기 허용된다.
- 기사, 작업자, 배정 생성/삭제는 클라이언트에서 금지되고 Admin 업로드 스크립트만 수행한다.
