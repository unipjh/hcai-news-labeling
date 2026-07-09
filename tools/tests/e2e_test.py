"""E2E test of the labeling app against Firestore/Auth emulators, with screenshots."""
import os
import subprocess
import requests
from playwright.sync_api import sync_playwright, expect

# 멱등성: 에뮬레이터 데이터 초기화 후 기사 재시드
requests.delete(
    "http://127.0.0.1:8089/emulator/v1/projects/hcai-news-la/databases/(default)/documents"
).raise_for_status()
subprocess.run(
    ["python3", os.path.join(os.path.dirname(__file__), "seed_emulator.py")], check=True
)

BASE = "http://127.0.0.1:5199"
SHOTS = "./shots"
DL = "./downloads"
os.makedirs(SHOTS, exist_ok=True)
os.makedirs(DL, exist_ok=True)
TESTER = "배포테스트"
results = []

def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS" if ok else "FAIL"), "-", name, ("| " + detail if detail else ""))

def shot(page, name):
    page.screenshot(path=f"{SHOTS}/{name}.png", full_page=False)
    print("shot:", name)

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # ── 1. 첫 화면: 안내 + 관리자 링크 ──
    page.goto(BASE)
    expect(page.get_by_text("본인 이름을 선택하거나")).to_be_visible(timeout=15000)
    check("첫 화면 로드", True)
    check("첫 화면 이용 안내 표시", page.get_by_text("라벨링 가이드를 먼저 읽고").count() == 1)
    check("관리자 페이지 링크 표시", page.get_by_text("관리자 페이지 (진행 현황").count() == 1)
    shot(page, "01_select_screen")

    # ── 1b. 데이터 목록 (버튼 존재만이 아니라 실제 렌더까지 확인) ──
    page.get_by_text("라벨링 대상 데이터 목록 보기").click()
    expect(page.locator(".data-table tbody tr")).to_have_count(15, timeout=15000)
    check("데이터 목록 열람 (15건 렌더)", True)
    shot(page, "01b_datalist")
    page.locator(".back-btn").click()
    expect(page.get_by_text("본인 이름을 선택하거나")).to_be_visible()

    # ── 2. 작업자 추가 → 라벨링 화면 + 가이드 패널 ──
    page.get_by_placeholder("새 작업자 이름").fill(TESTER)
    page.get_by_role("button", name="추가").click()
    expect(page.get_by_text("라벨링 가이드")).to_be_visible(timeout=30000)
    expect(page.get_by_text("내 진행:")).to_be_visible()
    guide_open = page.locator(".guide-panel details[open]").count() == 1
    check("라벨링 화면 진입 + 가이드 패널 (데스크톱 기본 펼침)", guide_open)
    check("가이드에 저장 주의 문구", page.get_by_text("'저장 후 다음' 버튼을 눌러야 저장됩니다.").count() == 1)
    check("가이드에 최소1~최대5 문구", page.get_by_text("최소 1개 ~ 최대 5개").count() == 1)
    shot(page, "02_labeling_with_guide")

    # ── 3. 최대 5개 제한 ──
    for label in ["기쁨", "행복", "기대감", "고마움", "존경"]:
        page.get_by_role("button", name=label, exact=True).click()
    expect(page.get_by_text("선택 5/5")).to_be_visible()
    page.get_by_role("button", name="감동/감탄", exact=True).click()
    hint_visible = page.locator(".hint-banner").count() == 1
    still5 = page.get_by_text("선택 5/5").count() == 1
    check("6번째 선택 차단 + 안내 힌트", hint_visible and still5,
          page.locator(".hint-banner").inner_text() if hint_visible else "힌트 없음")
    shot(page, "03_max5_hint")

    # ── 4. '없음' 배타 선택 ──
    page.get_by_role("button", name="없음", exact=True).click()
    expect(page.get_by_text("선택 1/5")).to_be_visible()
    summary = page.locator(".summary-chip").all_inner_texts()
    check("'없음' 선택 시 단독 선택", summary == ["없음 ✕"], str(summary))

    # ── 5. 저장 후 다음 ──
    page.get_by_role("button", name="없음", exact=True).click()  # 해제
    page.get_by_role("button", name="기쁨", exact=True).click()
    page.get_by_role("button", name="기대감", exact=True).click()
    page.locator(".save-btn").click()
    expect(page.locator(".progress-text")).to_contain_text("1", timeout=15000)
    expect(page.locator(".pos-indicator")).to_contain_text("2 / 15")
    check("저장 후 다음 건으로 이동 (진행 1/15)", "1" in page.locator(".progress-text b").inner_text())
    shot(page, "04_saved_next")

    # ── 6. 스킵 ──
    page.locator(".skip-btn").click()
    expect(page.get_by_text("이 건을 스킵할까요?")).to_be_visible()
    page.locator(".reason", has_text="뉴스 아님").click()
    shot(page, "05_skip_modal")
    page.locator(".modal-confirm.warn").click()
    expect(page.locator(".pos-indicator")).to_contain_text("3 / 15", timeout=15000)
    check("스킵 저장 (진행 2/15, 스킵 1)", "스킵 1" in page.locator(".progress-text").inner_text())

    # ── 7. 빈 선택 저장 → '없음' 확인 모달 ──
    page.locator(".save-btn").click()
    expect(page.get_by_text("감정 없음으로 저장할까요?")).to_be_visible()
    shot(page, "06_empty_modal")
    page.locator(".modal-confirm", has_text="감정 없음으로").click()
    expect(page.locator(".pos-indicator")).to_contain_text("4 / 15", timeout=15000)
    check("빈 선택 → '없음' 저장", True)

    # ── 8. 새로고침 후 draft 복원 ──
    page.get_by_role("button", name="슬픔", exact=True).click()
    expect(page.get_by_text("미저장 변경")).to_be_visible()
    page.reload()
    expect(page.get_by_text("내 진행:")).to_be_visible(timeout=15000)
    restored = page.get_by_text("변경 사항 1건").count() == 1
    check("새로고침 후 미저장 draft 복원", restored)
    shot(page, "07_draft_restored")
    # draft 건으로 이동해 저장
    page.locator(".changes-top-btn").click()
    page.locator(".change-item").first.click()
    page.locator(".save-btn").click()
    expect(page.get_by_text("변경 사항 0건")).to_be_visible(timeout=15000)

    # ── 9. 내 결과 CSV 다운로드 ──
    with page.expect_download() as dl_info:
        page.locator(".csv-top-btn").click()
    dl = dl_info.value
    my_csv = f"{DL}/{dl.suggested_filename}"
    dl.save_as(my_csv)
    content = open(my_csv, encoding="utf-8-sig").read()
    lines = content.strip().splitlines()
    check("내 결과 CSV 다운로드 (헤더+4행)", len(lines) == 5 and lines[0].startswith("annotator_id"),
          f"{dl.suggested_filename}, {len(lines)-1} rows")
    check("CSV에 라벨 파이프 구분 포함", "기쁨|기대감" in content)
    shot(page, "08_csv_downloaded")

    # ── 10. 모바일 뷰 (가이드 접힘 확인) ──
    mob = browser.new_context(viewport={"width": 390, "height": 844})
    mpage = mob.new_page()
    # 다른 브라우저(컨텍스트)는 잠금 때문에 기존 작업자를 못 쓰므로 새 작업자로 진입
    mpage.goto(BASE)
    mpage.get_by_placeholder("새 작업자 이름").fill("모바일테스트")
    mpage.get_by_role("button", name="추가").click()
    expect(mpage.get_by_text("내 진행:")).to_be_visible(timeout=30000)
    collapsed = mpage.locator(".guide-panel details[open]").count() == 0
    check("모바일: 가이드 기본 접힘 + 요약 표시", collapsed and mpage.get_by_text("라벨링 가이드").is_visible())
    shot(mpage, "09_mobile")
    mpage.locator(".guide-panel summary").click()
    shot(mpage, "10_mobile_guide_open")
    mob.close()

    # ── 10b. 데이터 목록에서 저장된 라벨링 조회 ──
    # '변경' 버튼은 제거됨 — 이름 선택을 지우고 재접속해 온보딩으로 이동 (잠금은 유지)
    check("라벨링 화면에 '변경' 버튼 없음",
          page.locator(".topbar .link-btn", has_text="변경").count() == 0)
    page.evaluate("localStorage.removeItem('annotator_id')")
    page.reload()
    expect(page.get_by_text("본인 이름을 선택하거나")).to_be_visible(timeout=15000)
    page.get_by_text("라벨링 대상 데이터 목록 보기").click()
    expect(page.locator(".data-table tbody tr")).to_have_count(15, timeout=15000)
    expect(page.locator(".ann-btn").first).to_be_visible(timeout=15000)
    btns = page.locator(".ann-btn", has_text=TESTER)
    check("목록에 라벨러 버튼 표시 (저장 4건)", btns.count() == 4, f"count={btns.count()}")
    shot(page, "18_datalist_ann_buttons")
    btns.first.click()
    expect(page.get_by_text(f"{TESTER} 님의 라벨링")).to_be_visible()
    has_content = (page.locator(".ann-labels .chip").count() > 0
                   or page.locator(".ann-skip").count() == 1)
    check("팝업에 저장된 감정/스킵 내용 표시", has_content)
    shot(page, "19_ann_popup")
    page.locator(".modal-cancel").click()
    page.locator(".back-btn").click()
    expect(page.get_by_text("본인 이름을 선택하거나")).to_be_visible()

    # ── 11. 관리자: 비밀번호 게이트 ──
    page.get_by_text("관리자 페이지 (진행 현황").click()
    expect(page.get_by_text("관리자 비밀번호를 입력해 주세요.")).to_be_visible()
    page.get_by_placeholder("비밀번호").fill("0000")
    page.get_by_role("button", name="확인").click()
    wrong = page.get_by_text("비밀번호가 올바르지 않습니다.").count() == 1
    check("잘못된 비밀번호 거부", wrong)
    shot(page, "11_admin_wrong_pw")
    page.get_by_placeholder("비밀번호").fill("1234")
    page.get_by_role("button", name="확인").click()
    expect(page.get_by_text("관리자 · 작업자 관리")).to_be_visible(timeout=15000)
    expect(page.locator(".data-table td", has_text=TESTER)).to_be_visible(timeout=15000)
    row = page.locator("tr", has_text=TESTER)
    progress_cell = row.locator(".admin-progress").inner_text()
    check("관리자 현황: 진행률 표시", "4 / 15" in progress_cell, progress_cell.replace("\n", " "))
    check("관리자 현황: 세션 사용 중 표시", row.locator(".lock-badge.on").count() == 1)
    shot(page, "12_admin_panel")

    # ── 12. 관리자: 전체 CSV ──
    with page.expect_download() as dl_info:
        page.locator(".export-all-btn").click()
    dl = dl_info.value
    all_csv = f"{DL}/{dl.suggested_filename}"
    dl.save_as(all_csv)
    all_lines = open(all_csv, encoding="utf-8-sig").read().strip().splitlines()
    check("관리자 전체 CSV 다운로드", len(all_lines) == 5, f"{dl.suggested_filename}, {len(all_lines)-1} rows")

    # ── 13. 관리자: 잠금 해제 ──
    row.locator(".admin-btn", has_text="해제").click()
    expect(page.get_by_text("세션 잠금을 해제했습니다.")).to_be_visible(timeout=15000)
    expect(page.locator("tr", has_text=TESTER).locator(".lock-badge", has_text="해제됨")).to_be_visible(timeout=15000)
    check("관리자 잠금 해제", True)
    shot(page, "13_admin_unlocked")

    # ── 14. 관리자: 작업자 삭제 (이름 불일치 → 취소, 일치 → 삭제) ──
    prompt_answer = {"value": "오타이름"}
    page.on("dialog", lambda d: d.accept(prompt_answer["value"]) if d.type == "prompt" else d.accept())
    page.locator("tr", has_text=TESTER).locator(".admin-btn.danger").click()
    expect(page.get_by_text("이름이 일치하지 않아")).to_be_visible()
    check("삭제 확인: 이름 불일치 시 취소", True)
    prompt_answer["value"] = TESTER
    page.locator("tr", has_text=TESTER).locator(".admin-btn.danger").click()
    expect(page.get_by_text(f"'{TESTER}' 작업자와 라벨링 결과 4건을 삭제했습니다.")).to_be_visible(timeout=30000)
    page.wait_for_timeout(1500)
    gone = page.locator(".data-table td", has_text=TESTER).count() == 0
    check("작업자 삭제 후 목록에서 제거", gone)
    shot(page, "14_admin_deleted")

    check("콘솔 페이지 에러 없음", len(errors) == 0, "; ".join(errors[:3]))
    browser.close()

print()
fails = [r for r in results if not r[1]]
print(f"TOTAL {len(results)} checks, {len(fails)} failed")
for name, _, detail in fails:
    print("  FAILED:", name, detail)
raise SystemExit(1 if fails else 0)
