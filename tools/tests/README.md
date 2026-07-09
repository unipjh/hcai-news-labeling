# 로컬 통합 테스트 (에뮬레이터)
실서비스 데이터를 건드리지 않고 전체 플로우를 검증한다. 필요: Java 21, playwright(pip), Chromium.
```bash
npx firebase-tools emulators:start --only firestore,auth --project hcai-news-la   # 터미널 1
cd frontend && VITE_FIREBASE_EMULATOR=1 npx vite --port 5199 --strictPort        # 터미널 2
cd tools/tests
python e2e_test.py     # 브라우저 E2E 23건 + 스크린샷 (./shots)
python rules_test.py   # Firestore Rules 서버 검증 6건
```
