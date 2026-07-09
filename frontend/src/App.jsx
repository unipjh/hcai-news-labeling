import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createAnnotator, deleteAnnotator, getAdminOverview, getAnnotators, getArticleAnnotations,
  getArticles, getExportRows, getMeta, getQueue, releaseAnnotator, saveAnnotation,
  unlockAnnotatorLock,
} from "./api.js";
import { downloadCsv } from "./csv.js";
import { GROUPS, LABELS, MAX_LABELS } from "./labels.js";

const GROUP_CLASS = { "긍정": "pos", "부정": "neg", "중립·기타": "neu" };
const LABEL_GROUP = Object.fromEntries(
  Object.entries(GROUPS).flatMap(([group, labels]) =>
    labels.map((label) => [label, GROUP_CLASS[group] || "neu"]))
);
// 배포 시 실제 운영 비밀번호로 교체할 것 (클라이언트 노출 전제의 간단 게이트)
const ADMIN_PASSWORD = "1234";

function formatDate(iso) {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[1]}.${m[2]}.${m[3]} ${m[4]}:${m[5]}` : iso;
}

function sameLabels(a = [], b = []) {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((label, i) => label === right[i]);
}

function exportRowFromItem(item, annotator) {
  return {
    annotator_id: annotator,
    article_id: item.article_id,
    headline: item.headline,
    press: item.press,
    category: item.category,
    published_at: item.published_at,
    bucket: item.bucket,
    status: item.status,
    labels: item.saved_labels ?? [],
    is_skipped: item.status === "skipped",
    skip_reason: item.skip_reason ?? "",
    saved_at: item.saved_at ?? "",
  };
}

export default function App() {
  const [meta, setMeta] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [annotator, setAnnotator] = useState(() => {
    // ?annotator=이름 으로 접속하면 자동 선택 (작업자별 공유 링크용)
    const fromUrl = new URLSearchParams(location.search).get("annotator");
    if (fromUrl) {
      localStorage.setItem("annotator_id", fromUrl);
      return fromUrl;
    }
    return localStorage.getItem("annotator_id") || null;
  });

  useEffect(() => {
    getMeta().then(setMeta).catch((e) => setLoadError(e.message));
  }, []);

  const [view, setView] = useState("main"); // main | datalist | admin

  if (loadError) return <CenterNote text={`초기화 실패: ${loadError}`} />;
  if (!meta) return <CenterNote text="불러오는 중…" />;
  if (view === "datalist") return <DataList onBack={() => setView("main")} />;
  if (view === "admin") return <AdminPanel onBack={() => setView("main")} />;
  if (!annotator) {
    return (
      <AnnotatorSelect
        onSelect={(id) => {
          localStorage.setItem("annotator_id", id);
          setAnnotator(id);
        }}
        onShowData={() => setView("datalist")}
        onShowAdmin={() => setView("admin")}
      />
    );
  }
  const clearAnnotator = () => {
    localStorage.removeItem("annotator_id");
    setAnnotator(null);
  };

  const endSession = async () => {
    if (!window.confirm(
      `'세션 종료'는 다른 기기·브라우저로 옮겨서 작업할 때만 필요합니다.\n` +
      `같은 브라우저로 다시 접속할 거라면 그냥 창을 닫아도 하던 곳부터 이어집니다.\n\n` +
      `${annotator} 세션을 종료하고 작업자 잠금을 해제할까요?`
    )) return;
    try {
      await releaseAnnotator(annotator);
    } catch (error) {
      alert(`${error.message}

현재 브라우저의 선택은 해제하고 작업자 선택 화면으로 돌아갑니다.`);
      clearAnnotator();
      return;
    }
    clearAnnotator();
  };

  return (
    <Labeling
      meta={meta}
      annotator={annotator}
      onChangeAnnotator={clearAnnotator}
      onEndSession={endSession}
    />
  );
}

function CenterNote({ text, actionLabel = null, onAction = null }) {
  return (
    <div className="center-note">
      <p>{text}</p>
      {actionLabel && onAction && (
        <button className="center-action" onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}

function AnnotatorSelect({ onSelect, onShowData, onShowAdmin }) {
  const [annotators, setAnnotators] = useState(null);
  const [error, setError] = useState(null);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);

  useEffect(() => {
    getAnnotators().then(setAnnotators).catch((e) => setError(e.message));
  }, []);

  const onAdd = async (e) => {
    e.preventDefault();
    if (adding) return;
    setAdding(true);
    setAddError(null);
    try {
      const created = await createAnnotator(newName);
      setAnnotators((prev) => [...(prev || []), created]
        .sort((a, b) => a.name.localeCompare(b.name, "ko")));
      setNewName("");
      onSelect(created.annotator_id);
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAdding(false);
    }
  };

  if (error) return <CenterNote text={`명단 로드 실패: ${error}`} actionLabel="다시 시도" onAction={() => location.reload()} />;
  if (!annotators) return <CenterNote text="불러오는 중…" />;
  return (
    <div className="select-screen">
      <h1>KOTE 헤드라인 라벨링</h1>
      <p className="select-guide">본인 이름을 선택하거나 새 작업자를 추가해 주세요.</p>
      <ol className="select-steps">
        <li>본인 이름을 선택하면 배정된 헤드라인이 순서대로 나옵니다.</li>
        <li>화면의 <b>라벨링 가이드</b>를 먼저 읽고 시작해 주세요.</li>
        <li>중간에 창을 닫아도 괜찮습니다. <b>같은 브라우저로 다시 접속하면
          하던 곳부터 자동으로 이어집니다.</b></li>
      </ol>
      <div className="annotator-list">
        {annotators.map((a) => (
          <button key={a.annotator_id} className="annotator-card"
            onClick={() => onSelect(a.annotator_id)}>
            {a.name}
          </button>
        ))}
      </div>
      <form className="annotator-add" onSubmit={onAdd}>
        <input
          type="text"
          value={newName}
          maxLength={40}
          placeholder="새 작업자 이름"
          onChange={(e) => setNewName(e.target.value)}
        />
        <button type="submit" disabled={adding || !newName.trim()}>
          {adding ? "추가 중…" : "추가"}
        </button>
      </form>
      {addError && <p className="annotator-error">{addError}</p>}
      <button className="data-link" onClick={onShowData}>
        라벨링 대상 데이터 목록 보기 →
      </button>
      <button className="admin-link" onClick={onShowAdmin}>
        관리자 페이지 (진행 현황·CSV·작업자 관리)
      </button>
    </div>
  );
}

function DataList({ onBack }) {
  const [articles, setArticles] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [bucket, setBucket] = useState("전체");
  const [annsByArticle, setAnnsByArticle] = useState(null); // Map | null(로딩) | false(실패)
  const [popup, setPopup] = useState(null); // {article, ann} | null
  useEffect(() => {
    getArticles().then(setArticles).catch((e) => setError(e.message));
    // 라벨링 조회 실패는 치명적이지 않음 — 목록은 그대로 보이고 라벨링 열만 생략
    getArticleAnnotations().then(setAnnsByArticle).catch(() => setAnnsByArticle(false));
  }, []);
  if (error) return <CenterNote text={`목록 로드 실패: ${error}`} actionLabel="돌아가기" onAction={onBack} />;
  if (!articles) return <CenterNote text="데이터 목록 불러오는 중…" />;

  const q = query.trim();
  const filtered = articles.filter((a) =>
    (bucket === "전체" || a.bucket === bucket) &&
    (!q || a.headline.includes(q) || (a.press || "").includes(q) ||
      (a.category || "").includes(q))
  );
  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <button className="back-btn" onClick={onBack}>← 돌아가기</button>
          <span className="app-name">라벨링 대상 데이터</span>
          <span className="data-count">
            {filtered.length.toLocaleString()} / {articles.length.toLocaleString()}건
          </span>
        </div>
      </header>
      <main className="content datalist">
        <p className="datalist-guide">
          Task 1 샘플링으로 선정된 라벨링 대상 전체입니다. 버킷 A=감정별 쿼터,
          B=순수 랜덤, C=모델 저신뢰. 모든 작업자가 전체를 서로 다른 순서로 라벨링합니다.
          라벨링 열의 이름 버튼을 누르면 그 작업자가 저장한 감정을 볼 수 있습니다.
        </p>
        <div className="datalist-controls">
          <input className="search" type="search" placeholder="헤드라인·언론사·카테고리 검색"
            value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="bucket-filter">
            {["전체", "A", "B", "C"].map((b) => (
              <button key={b} className={`bucket-chip ${bucket === b ? "on" : ""}`}
                onClick={() => setBucket(b)}>{b}</button>
            ))}
          </div>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>#</th><th>헤드라인</th><th>언론사</th><th>카테고리</th><th>발행일</th><th>버킷</th><th>라벨링</th></tr>
            </thead>
            <tbody>
              {filtered.map((a, i) => {
                const anns = (annsByArticle && annsByArticle.get(String(a.article_id))) || [];
                return (
                  <tr key={a.article_id}>
                    <td className="num">{i + 1}</td>
                    <td className="headline-cell">{a.headline}</td>
                    <td>{a.press}</td>
                    <td>{a.category}</td>
                    <td className="num">{formatDate(a.published_at).slice(0, 10)}</td>
                    <td><span className={`bucket-badge b-${a.bucket}`}>{a.bucket}</span></td>
                    <td className="ann-cell">
                      {anns.length === 0 ? (
                        <span className="ann-none">–</span>
                      ) : (
                        anns.map((ann) => (
                          <button key={ann.annotator_id}
                            className={`ann-btn ${ann.is_skipped ? "skipped" : ""}`}
                            title="클릭하면 저장된 감정을 보여줍니다"
                            onClick={() => setPopup({ article: a, ann })}>
                            {ann.annotator_id}
                          </button>
                        ))
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && <p className="table-empty">검색 결과가 없습니다.</p>}
        </div>
      </main>

      {popup && (
        <Modal onClose={() => setPopup(null)} className="ann-modal">
          <p className="modal-title">{popup.ann.annotator_id} 님의 라벨링</p>
          <p className="ann-headline">{popup.article.headline}</p>
          {popup.ann.is_skipped ? (
            <p className="ann-skip">스킵됨 · 사유: {popup.ann.skip_reason || "미기재"}</p>
          ) : (
            <div className="ann-labels">
              {popup.ann.labels.map((l) => (
                <span key={l} className={`chip ${LABEL_GROUP[l] || "neu"} on`}>{l}</span>
              ))}
            </div>
          )}
          {popup.ann.saved_at && (
            <p className="ann-meta">저장 시각: {new Date(popup.ann.saved_at).toLocaleString("ko-KR")}</p>
          )}
          <div className="modal-actions">
            <button className="modal-cancel" onClick={() => setPopup(null)}>닫기</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function AdminPanel({ onBack }) {
  const [authed, setAuthed] = useState(false);
  const [pw, setPw] = useState("");
  const [pwError, setPwError] = useState(null);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // annotator_id | "__all__" | null
  const [notice, setNotice] = useState(null);

  const load = useCallback(() => {
    setRows(null);
    setError(null);
    getAdminOverview().then(setRows).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (authed) load();
  }, [authed, load]);

  const submitPw = (e) => {
    e.preventDefault();
    if (pw === ADMIN_PASSWORD) {
      setAuthed(true);
      setPwError(null);
    } else {
      setPwError("비밀번호가 올바르지 않습니다.");
    }
  };

  const run = async (key, fn) => {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice(e.message);
    } finally {
      setBusy(null);
    }
  };

  const today = () => new Date().toISOString().slice(0, 10);

  const exportAll = () => run("__all__", async () => {
    const data = await getExportRows();
    if (data.length === 0) {
      setNotice("내보낼 라벨링 결과가 아직 없습니다.");
      return;
    }
    downloadCsv(`kote_labels_all_${today()}.csv`, data);
    setNotice(`전체 결과 ${data.length}건을 CSV로 내려받았습니다.`);
  });

  const exportOne = (row) => run(row.annotator_id, async () => {
    const data = await getExportRows(row.annotator_id);
    if (data.length === 0) {
      setNotice(`'${row.name}'의 저장된 라벨링 결과가 아직 없습니다.`);
      return;
    }
    downloadCsv(`kote_labels_${row.name}_${today()}.csv`, data);
    setNotice(`'${row.name}' 결과 ${data.length}건을 CSV로 내려받았습니다.`);
  });

  const unlock = (row) => run(row.annotator_id, async () => {
    await unlockAnnotatorLock(row.annotator_id);
    setNotice(`'${row.name}' 세션 잠금을 해제했습니다.`);
    load();
  });

  const remove = (row) => {
    const savedCount = row.done + row.skipped;
    const typed = window.prompt(
      `'${row.name}' 작업자를 삭제합니다. 저장된 라벨링 결과 ${savedCount}건도 함께 삭제되며 되돌릴 수 없습니다.\n\n삭제하려면 작업자 이름을 그대로 입력하세요.`
    );
    if (typed === null) return;
    if (typed.trim() !== row.name) {
      setNotice("입력한 이름이 일치하지 않아 삭제를 취소했습니다.");
      return;
    }
    run(row.annotator_id, async () => {
      await deleteAnnotator(row.annotator_id);
      setNotice(`'${row.name}' 작업자와 라벨링 결과 ${savedCount}건을 삭제했습니다.`);
      load();
    });
  };

  if (!authed) {
    return (
      <div className="select-screen admin-gate">
        <h1>관리자 페이지</h1>
        <p className="select-guide">관리자 비밀번호를 입력해 주세요.</p>
        <form className="annotator-add" onSubmit={submitPw}>
          <input
            type="password"
            value={pw}
            placeholder="비밀번호"
            autoFocus
            onChange={(e) => setPw(e.target.value)}
          />
          <button type="submit" disabled={!pw}>확인</button>
        </form>
        {pwError && <p className="annotator-error">{pwError}</p>}
        <button className="data-link" onClick={onBack}>← 돌아가기</button>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <button className="back-btn" onClick={onBack}>← 돌아가기</button>
          <span className="app-name">관리자 · 작업자 관리</span>
          <div className="topbar-right">
            <button className="back-btn" disabled={busy !== null} onClick={load}>새로고침</button>
            <button className="export-all-btn" disabled={busy !== null} onClick={exportAll}>
              {busy === "__all__" ? "내보내는 중…" : "전체 결과 CSV 다운로드"}
            </button>
          </div>
        </div>
      </header>
      <main className="content datalist">
        {notice && <div className="admin-notice">{notice}</div>}
        {error && (
          <CenterNote text={`현황 로드 실패: ${error}`} actionLabel="다시 시도" onAction={load} />
        )}
        {!error && !rows && <CenterNote text="작업자 현황 불러오는 중…" />}
        {rows && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>작업자</th><th>진행</th><th>완료</th><th>스킵</th>
                  <th>세션</th><th>CSV</th><th>잠금 해제</th><th>삭제</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const doneCount = r.done + r.skipped;
                  const pct = r.total > 0 ? Math.round((doneCount / r.total) * 100) : 0;
                  const rowBusy = busy === r.annotator_id;
                  return (
                    <tr key={r.annotator_id}>
                      <td className="headline-cell admin-name">{r.name}</td>
                      <td className="num admin-progress">
                        <span>{doneCount} / {r.total} ({pct}%)</span>
                        <div className="progress-bar"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
                      </td>
                      <td className="num">{r.done}</td>
                      <td className="num">{r.skipped}</td>
                      <td>{r.locked ? <span className="lock-badge on">사용 중</span> : <span className="lock-badge">해제됨</span>}</td>
                      <td>
                        <button className="admin-btn" disabled={busy !== null}
                          onClick={() => exportOne(r)}>{rowBusy ? "…" : "다운로드"}</button>
                      </td>
                      <td>
                        <button className="admin-btn" disabled={busy !== null || !r.locked}
                          onClick={() => unlock(r)}>{rowBusy ? "…" : "해제"}</button>
                      </td>
                      <td>
                        <button className="admin-btn danger" disabled={busy !== null}
                          onClick={() => remove(r)}>{rowBusy ? "…" : "삭제"}</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length === 0 && <p className="table-empty">등록된 작업자가 없습니다.</p>}
          </div>
        )}
        <p className="datalist-guide admin-footnote">
          삭제는 해당 작업자의 배정·라벨링 결과를 모두 지우며 되돌릴 수 없습니다.
          삭제 전 CSV 다운로드로 백업해 두세요. '잠금 해제'는 다른 브라우저에 물려 있는
          세션을 풀 때 사용합니다.
        </p>
      </main>
    </div>
  );
}

function GuidePanel() {
  const [open, setOpen] = useState(
    () => window.matchMedia("(min-width: 1100px)").matches
  );
  return (
    <aside className="guide-panel">
      <details open={open} onToggle={(e) => setOpen(e.target.open)}>
        <summary>라벨링 가이드</summary>
        <ol className="guide-steps">
          <li><b>이 문장(헤드라인)이 어떤 감정을 표현하고 있는지</b> 아래 감정 칩에서 골라주세요.</li>
          <li>감정은 <b>최소 1개 ~ 최대 {MAX_LABELS}개</b>까지 고를 수 있어요. 감정이 없다고 판단되면 <b>'없음'</b>을 골라주세요 ('없음'은 단독 선택만 가능).</li>
          <li className="guide-important"><b>'저장 후 다음' 버튼을 눌러야 저장됩니다.</b> 누르지 않고 넘어가면 저장이 안 되니 꼭 누르고 넘어가 주세요.</li>
          <li>판단이 어렵거나 뉴스가 아니면 <b>스킵</b> 버튼으로 사유를 선택해 넘겨주세요.</li>
          <li>이전/다음(←/→)으로 지난 건을 수정할 수 있어요. 수정한 뒤에도 꼭 '저장 후 다음'을 눌러주세요.</li>
        </ol>
        <div className="guide-session">
          <p className="guide-session-title">쉬었다 다시 하기</p>
          <ul>
            <li>잠깐 쉬거나 창을 닫는 건 자유예요. <b>같은 브라우저로 다시 접속하면
              미저장 편집까지 그대로 복원됩니다.</b> 이때 '세션 종료'는 누르지 마세요.</li>
            <li><b>'세션 종료'는 다른 기기·브라우저로 옮길 때만</b> 누르세요.
              미저장 편집은 기기 간에 넘어가지 않으니 옮기기 전에 꼭 저장해 주세요.</li>
            <li>시크릿(사생활 보호) 창은 닫으면 이어하기가 안 됩니다. 일반 창을 사용해 주세요.
              (접속이 막히면 관리자에게 잠금 해제를 요청하세요)</li>
          </ul>
        </div>
        <div className="guide-keys">
          단축키: <kbd>Enter</kbd> 저장 후 다음 · <kbd>←</kbd><kbd>→</kbd> 이동 · <kbd>/</kbd> 라벨 검색 · <kbd>Esc</kbd> 닫기
        </div>
      </details>
    </aside>
  );
}

function Labeling({ meta, annotator, onChangeAnnotator, onEndSession }) {
  const [items, setItems] = useState(null);
  const [idx, setIdx] = useState(0);
  const [drafts, setDrafts] = useState({}); // article_id → labels (미저장 편집)
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null); // {message, retry}
  const [modal, setModal] = useState(null); // null | "empty" | "skip" | "changes"
  const [skipReason, setSkipReason] = useState(meta.skip_reasons[0]);
  const [query, setQuery] = useState("");
  const [loadError, setLoadError] = useState(null);
  const [hint, setHint] = useState(null);
  const searchRef = useRef(null);
  const hintTimer = useRef(null);

  const noneLabel = meta.none_label;
  const draftKey = `labeling_drafts_${annotator}`;

  useEffect(() => {
    getQueue(annotator)
      .then((d) => {
        setItems(d.items);
        // 새로고침 대비: localStorage에 남은 미저장 편집 복원
        let stored = {};
        try {
          stored = JSON.parse(localStorage.getItem(draftKey) || "{}");
        } catch { /* 손상된 draft는 무시 */ }
        const restored = {};
        d.items.forEach((it) => {
          const draft = stored[it.article_id];
          if (!Array.isArray(draft)) return;
          const cleaned = draft.filter((l) => LABELS.includes(l));
          if (!sameLabels(cleaned, it.saved_labels ?? [])) restored[it.article_id] = cleaned;
        });
        setDrafts(restored);
        const firstPending = d.items.findIndex((it) => it.status === "pending");
        setIdx(firstPending === -1 ? 0 : firstPending);
      })
      .catch((e) => setLoadError(e.message));
  }, [annotator, draftKey]);

  // 미저장 편집을 localStorage에 보존 (새로고침/실수 이탈 대비)
  useEffect(() => {
    if (!items) return;
    localStorage.setItem(draftKey, JSON.stringify(drafts));
  }, [drafts, items, draftKey]);

  // 미저장 편집이 있으면 창 닫기/새로고침 전에 경고
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (Object.keys(drafts).length === 0) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [drafts]);

  const progress = useMemo(() => {
    if (!items) return null;
    const done = items.filter((it) => it.status === "done").length;
    const skipped = items.filter((it) => it.status === "skipped").length;
    return { total: items.length, done, skipped, pending: items.length - done - skipped };
  }, [items]);

  const current = items?.[idx];
  const selected = useMemo(() => {
    if (!current) return [];
    return drafts[current.article_id] ?? current.saved_labels ?? [];
  }, [current, drafts]);
  const isDirty = current ? current.article_id in drafts : false;
  const changeItems = useMemo(() => {
    if (!items) return [];
    return items
      .map((item, itemIdx) => {
        if (!(item.article_id in drafts)) return null;
        return {
          item,
          itemIdx,
          labels: drafts[item.article_id],
          kind: item.status === "pending" ? "미저장 변경" : "저장 후 수정",
        };
      })
      .filter(Boolean);
  }, [items, drafts]);

  const showHint = useCallback((message) => {
    setHint(message);
    clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), 3200);
  }, []);
  useEffect(() => () => clearTimeout(hintTimer.current), []);

  const setCurrentDraft = useCallback((next) => {
    if (!current) return;
    const base = current.saved_labels ?? [];
    setDrafts((d) => {
      const { [current.article_id]: _, ...rest } = d;
      if (sameLabels(next, base)) return rest;
      return { ...rest, [current.article_id]: next };
    });
  }, [current]);

  const toggle = useCallback((label) => {
    if (!current) return;
    let next;
    if (selected.includes(label)) {
      next = selected.filter((l) => l !== label);
    } else if (label === noneLabel) {
      next = [noneLabel]; // '없음'은 단독 선택
    } else {
      const withoutNone = selected.filter((l) => l !== noneLabel);
      if (withoutNone.length >= MAX_LABELS) {
        showHint(`감정은 최대 ${MAX_LABELS}개까지만 선택할 수 있어요. 다른 라벨을 해제한 뒤 선택해 주세요.`);
        return;
      }
      next = [...withoutNone, label];
    }
    setCurrentDraft(next);
  }, [current, selected, noneLabel, setCurrentDraft, showHint]);

  const goToChange = useCallback((itemIdx) => {
    setIdx(itemIdx);
    setModal(null);
    setSaveError(null);
    setQuery("");
  }, []);

  const doSave = useCallback(async (labels, { skip = null } = {}) => {
    if (!current || saving) return;
    setSaving(true);
    setSaveError(null);
    const payload = {
      article_id: current.article_id,
      annotator_id: annotator,
      labels: skip ? [] : labels,
      is_skipped: !!skip,
      skip_reason: skip,
    };
    try {
      const res = await saveAnnotation(payload);
      setItems((prev) => prev.map((it, i) => i !== idx ? it : {
        ...it,
        status: skip ? "skipped" : "done",
        saved_labels: skip ? [] : labels,
        is_skipped: !!skip,
        skip_reason: skip,
        saved_at: res.saved_at,
      }));
      setDrafts((d) => {
        const { [current.article_id]: _, ...rest } = d;
        return rest;
      });
      setModal(null);
      setQuery("");
      // 다음 pending으로 이동 (현재 이후 우선, 없으면 앞쪽)
      setItems((prev) => {
        const after = prev.findIndex((it, i) => i > idx && it.status === "pending");
        const anywhere = prev.findIndex((it) => it.status === "pending");
        const nextIdx = after !== -1 ? after : anywhere;
        if (nextIdx !== -1) setIdx(nextIdx);
        return prev;
      });
    } catch (e) {
      setSaveError({
        message: e.message,
        retry: () => doSave(labels, { skip }),
      });
    } finally {
      setSaving(false);
    }
  }, [current, saving, annotator, idx]);

  const onSaveClick = useCallback(() => {
    if (!current || saving) return;
    if (selected.length === 0) setModal("empty");
    else doSave(selected);
  }, [current, saving, selected, doSave]);

  const nav = useCallback((delta) => {
    setSaveError(null);
    setQuery("");
    setIdx((i) => Math.min(Math.max(i + delta, 0), (items?.length ?? 1) - 1));
  }, [items]);

  const downloadMyResults = useCallback(() => {
    if (!items) return;
    const rows = items
      .filter((it) => it.status !== "pending")
      .map((it) => exportRowFromItem(it, annotator));
    if (rows.length === 0) {
      showHint("아직 저장된 라벨링 결과가 없습니다. 먼저 '저장 후 다음'으로 저장해 주세요.");
      return;
    }
    downloadCsv(`kote_labels_${annotator}_${new Date().toISOString().slice(0, 10)}.csv`, rows);
  }, [items, annotator, showHint]);

  // 키보드: Enter=저장 후 다음 / ←→=이전·다음 / Esc=모달 닫기 / "/"=검색
  useEffect(() => {
    const onKey = (e) => {
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName);
      if (e.key === "Escape") {
        setModal(null);
        if (typing) e.target.blur();
        return;
      }
      if (modal === "empty" && e.key === "Enter") {
        e.preventDefault();
        doSave([noneLabel]);
        return;
      }
      if (modal === "skip" && e.key === "Enter") {
        e.preventDefault();
        doSave([], { skip: skipReason });
        return;
      }
      if (modal || typing) return;
      if (e.key === "Enter") { e.preventDefault(); onSaveClick(); }
      else if (e.key === "ArrowLeft") nav(-1);
      else if (e.key === "ArrowRight") nav(1);
      else if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal, skipReason, doSave, onSaveClick, nav, noneLabel]);

  if (loadError) return (
    <CenterNote
      text={`큐 로드 실패: ${loadError}`}
      actionLabel="작업자 선택으로 돌아가기"
      onAction={onChangeAnnotator}
    />
  );
  if (!items || !progress) return <CenterNote text="큐 불러오는 중…" />;
  if (items.length === 0) return (
    <CenterNote
      text="배정된 작업이 없습니다."
      actionLabel="작업자 선택으로 돌아가기"
      onAction={onChangeAnnotator}
    />
  );

  const finished = progress.pending === 0;
  const doneCount = progress.done + progress.skipped;
  const q = query.trim();
  const matchesQuery = (label) => !q || label.includes(q);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <span className="app-name">KOTE 라벨링</span>
          <div className="progress-wrap">
            <div className="progress-text">
              내 진행: <b>{doneCount}</b> / {progress.total}
              {progress.skipped > 0 && <span className="muted"> (스킵 {progress.skipped})</span>}
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${(doneCount / progress.total) * 100}%` }} />
            </div>
          </div>
          <div className="topbar-right">
            <button className="changes-top-btn" disabled={changeItems.length === 0}
              onClick={() => setModal("changes")}>
              변경 사항 {changeItems.length}건
            </button>
            <button className="csv-top-btn" disabled={doneCount === 0} onClick={downloadMyResults}
              title="지금까지 저장한 내 라벨링 결과를 CSV로 다운로드">
              내 결과 CSV
            </button>
            <span className="annotator-name">{annotator}</span>
            <button className="link-btn danger" onClick={onEndSession}>세션 종료</button>
          </div>
        </div>
      </header>

      <main className="content with-guide">
        <div className="work-col">
          {finished && (
            <div className="done-banner">
              <span>모든 배정 건을 완료했습니다. ←/→ 로 지난 건을 다시 확인·수정할 수 있습니다.</span>
              <button className="done-csv-btn" onClick={downloadMyResults}>내 결과 CSV 다운로드</button>
            </div>
          )}

          <article className="headline-card">
            <div className="headline-meta">
              <span className="pos-indicator">{idx + 1} / {items.length}</span>
              {current.status !== "pending" && (
                <span className={`status-chip ${current.status}`}>
                  {current.status === "done" ? "저장됨" : `스킵됨 · ${current.skip_reason}`}
                  {isDirty && " · 수정 중"}
                </span>
              )}
              {current.status === "pending" && isDirty && (
                <span className="status-chip dirty">미저장 변경</span>
              )}
            </div>
            <h2 className="headline">{current.headline}</h2>
            <div className="headline-sub">
              <span>{current.press}</span>
              {current.category && <span>· {current.category}</span>}
              <span>· {formatDate(current.published_at)}</span>
            </div>
            <div className="selected-summary">
              <span className={`selected-count ${selected.length > 0 ? "on" : ""}`}>
                선택 {selected.length}/{MAX_LABELS}
              </span>
              {selected.length === 0 ? (
                <span className="summary-empty">선택된 감정 없음</span>
              ) : (
                selected.map((l) => (
                  <button key={l} className="summary-chip" onClick={() => toggle(l)}
                    title="클릭하여 해제">{l} ✕</button>
                ))
              )}
            </div>
            {hint && <p className="hint-banner">{hint}</p>}
          </article>

          {meta.flags.show_model_suggestions && (
            <section className="suggestions">
              <span className="suggestions-title">모델 추천</span>
              {current.model_top5_labels.map((l, i) => (
                <button key={l}
                  className={`chip suggestion ${selected.includes(l) ? "on" : ""}`}
                  onClick={() => toggle(l)}>
                  {l} <span className="prob">{current.model_top5_probs[i]?.toFixed(2)}</span>
                </button>
              ))}
            </section>
          )}

          <div className="search-row">
            <input ref={searchRef} className="search" type="search"
              placeholder="라벨 검색 ( / 키 )" value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }} />
          </div>

          {meta.groups.map((g) => {
            const visible = g.labels.filter(matchesQuery);
            if (visible.length === 0) return null;
            const cls = GROUP_CLASS[g.name] || "neu";
            return (
              <section key={g.name} className={`group ${cls}`}>
                <h3 className="group-title"><span className="group-dot" />{g.name}</h3>
                <div className="chips">
                  {visible.map((l) => (
                    <button key={l} className={`chip ${cls} ${selected.includes(l) ? "on" : ""}`}
                      onClick={() => toggle(l)}>{l}</button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>

        <GuidePanel />
      </main>

      <footer className="actionbar">
        {saveError && (
          <div className="error-banner">
            <span>저장 실패: {saveError.message}</span>
            <button className="retry-btn" onClick={saveError.retry}>재시도</button>
          </div>
        )}
        <div className="actionbar-inner">
          <button className="nav-btn" disabled={idx === 0 || saving} onClick={() => nav(-1)}>← 이전</button>
          <button className="skip-btn" disabled={saving} onClick={() => setModal("skip")}>스킵</button>
          <button className="save-btn" disabled={saving} onClick={onSaveClick}>
            {saving ? "저장 중…" : "저장 후 다음 ⏎"}
          </button>
          <button className="nav-btn" disabled={idx === items.length - 1 || saving} onClick={() => nav(1)}>다음 →</button>
        </div>
      </footer>

      {modal === "changes" && (
        <Modal onClose={() => setModal(null)} className="changes-modal">
          <p className="modal-title">변경 사항 {changeItems.length}건</p>
          {changeItems.length === 0 ? (
            <p className="modal-body">미저장 변경이나 저장 후 수정 중인 건이 없습니다.</p>
          ) : (
            <div className="changes-list">
              {changeItems.map(({ item, itemIdx, labels, kind }) => (
                <button key={item.article_id} className="change-item" onClick={() => goToChange(itemIdx)}>
                  <span className={`change-kind ${kind === "미저장 변경" ? "unsaved" : "edited"}`}>{kind}</span>
                  <span className="change-headline">{item.headline}</span>
                  <span className="change-meta">{itemIdx + 1} / {items.length} · {labels.length ? labels.join(", ") : "선택 없음"}</span>
                </button>
              ))}
            </div>
          )}
          <div className="modal-actions">
            <button className="modal-cancel" onClick={() => setModal(null)}>닫기</button>
          </div>
        </Modal>
      )}

      {modal === "empty" && (
        <Modal onClose={() => setModal(null)}>
          <p className="modal-title">감정 없음으로 저장할까요?</p>
          <p className="modal-body">선택된 라벨이 없습니다. 확인 시 ‘{noneLabel}’ 라벨로 저장됩니다.</p>
          <div className="modal-actions">
            <button className="modal-cancel" onClick={() => setModal(null)}>취소</button>
            <button className="modal-confirm" disabled={saving}
              onClick={() => doSave([noneLabel])}>감정 없음으로 저장 ⏎</button>
          </div>
        </Modal>
      )}

      {modal === "skip" && (
        <Modal onClose={() => setModal(null)}>
          <p className="modal-title">이 건을 스킵할까요?</p>
          <div className="skip-reasons">
            {meta.skip_reasons.map((r) => (
              <label key={r} className={`reason ${skipReason === r ? "on" : ""}`}>
                <input type="radio" name="skip-reason" value={r}
                  checked={skipReason === r} onChange={() => setSkipReason(r)} />
                {r}
              </label>
            ))}
          </div>
          <div className="modal-actions">
            <button className="modal-cancel" onClick={() => setModal(null)}>취소</button>
            <button className="modal-confirm warn" disabled={saving}
              onClick={() => doSave([], { skip: skipReason })}>스킵 ⏎</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({ children, onClose, className = "" }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${className}`} onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}
