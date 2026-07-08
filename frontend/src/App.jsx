import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAnnotator, getAnnotators, getArticles, getMeta, getQueue, releaseAnnotator, saveAnnotation } from "./api.js";

const GROUP_CLASS = { "긍정": "pos", "부정": "neg", "중립·기타": "neu" };

function formatDate(iso) {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[1]}.${m[2]}.${m[3]} ${m[4]}:${m[5]}` : iso;
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

  const [view, setView] = useState("main"); // main | datalist

  if (loadError) return <CenterNote text={`초기화 실패: ${loadError}`} />;
  if (!meta) return <CenterNote text="불러오는 중…" />;
  if (view === "datalist") return <DataList onBack={() => setView("main")} />;
  if (!annotator) {
    return (
      <AnnotatorSelect
        onSelect={(id) => {
          localStorage.setItem("annotator_id", id);
          setAnnotator(id);
        }}
        onShowData={() => setView("datalist")}
      />
    );
  }
  const clearAnnotator = () => {
    localStorage.removeItem("annotator_id");
    setAnnotator(null);
  };

  const endSession = async () => {
    if (!window.confirm(`${annotator} 세션을 종료하고 작업자 잠금을 해제할까요?`)) return;
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

function AnnotatorSelect({ onSelect, onShowData }) {
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
    </div>
  );
}

function DataList({ onBack }) {
  const [articles, setArticles] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [bucket, setBucket] = useState("전체");
  useEffect(() => {
    getArticles().then(setArticles).catch((e) => setError(e.message));
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
              <tr><th>#</th><th>헤드라인</th><th>언론사</th><th>카테고리</th><th>발행일</th><th>버킷</th></tr>
            </thead>
            <tbody>
              {filtered.map((a, i) => (
                <tr key={a.article_id}>
                  <td className="num">{i + 1}</td>
                  <td className="headline-cell">{a.headline}</td>
                  <td>{a.press}</td>
                  <td>{a.category}</td>
                  <td className="num">{formatDate(a.published_at).slice(0, 10)}</td>
                  <td><span className={`bucket-badge b-${a.bucket}`}>{a.bucket}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && <p className="table-empty">검색 결과가 없습니다.</p>}
        </div>
      </main>
    </div>
  );
}

function Labeling({ meta, annotator, onChangeAnnotator, onEndSession }) {
  const [items, setItems] = useState(null);
  const [progress, setProgress] = useState(null);
  const [idx, setIdx] = useState(0);
  const [drafts, setDrafts] = useState({}); // article_id → labels (미저장 편집)
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null); // {message, retry}
  const [modal, setModal] = useState(null); // null | "empty" | "skip"
  const [skipReason, setSkipReason] = useState(meta.skip_reasons[0]);
  const [query, setQuery] = useState("");
  const [loadError, setLoadError] = useState(null);
  const searchRef = useRef(null);

  const noneLabel = meta.none_label;

  useEffect(() => {
    getQueue(annotator)
      .then((d) => {
        setItems(d.items);
        setProgress(d.progress);
        const firstPending = d.items.findIndex((it) => it.status === "pending");
        setIdx(firstPending === -1 ? 0 : firstPending);
      })
      .catch((e) => setLoadError(e.message));
  }, [annotator]);

  const current = items?.[idx];
  const selected = useMemo(() => {
    if (!current) return [];
    return drafts[current.article_id] ?? current.saved_labels ?? [];
  }, [current, drafts]);
  const isDirty = current ? current.article_id in drafts : false;

  const toggle = useCallback((label) => {
    if (!current) return;
    let next;
    if (selected.includes(label)) {
      next = selected.filter((l) => l !== label);
    } else if (label === noneLabel) {
      next = [noneLabel]; // '없음'은 단독 선택
    } else {
      next = [...selected.filter((l) => l !== noneLabel), label];
    }
    setDrafts((d) => ({ ...d, [current.article_id]: next }));
  }, [current, selected, noneLabel]);

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
      setProgress(res.progress);
      setItems((prev) => prev.map((it, i) => i !== idx ? it : {
        ...it,
        status: skip ? "skipped" : "done",
        saved_labels: skip ? [] : labels,
        is_skipped: !!skip,
        skip_reason: skip,
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
            <span className="annotator-name">{annotator}</span>
            <button className="link-btn" onClick={onChangeAnnotator}>변경</button>
            <button className="link-btn danger" onClick={onEndSession}>세션 종료</button>
          </div>
        </div>
      </header>

      <main className="content">
        {finished && (
          <div className="done-banner">모든 배정 건을 완료했습니다. ←/→ 로 지난 건을 다시 확인·수정할 수 있습니다.</div>
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
            {selected.length === 0 ? (
              <span className="summary-empty">선택된 감정 없음</span>
            ) : (
              selected.map((l) => (
                <button key={l} className="summary-chip" onClick={() => toggle(l)}
                  title="클릭하여 해제">{l} ✕</button>
              ))
            )}
          </div>
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

function Modal({ children, onClose }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}
