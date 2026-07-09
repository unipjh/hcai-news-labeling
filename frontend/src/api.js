import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  writeBatch,
  where,
} from "firebase/firestore";
import { db, ensureAuth } from "./firebase.js";
import { GROUPS, LABELS, MAX_LABELS, NONE_LABEL, SKIP_REASONS } from "./labels.js";

const LABEL_SET = new Set(LABELS);

function asError(error, fallback) {
  if (error?.code === "permission-denied") {
    return new Error(
      "접근 권한이 없습니다. 이미 다른 브라우저에서 선택된 작업자이거나 Firestore Rules 설정을 확인해야 합니다."
    );
  }
  return new Error(error?.message || fallback);
}

function assignmentId(annotatorId, articleId) {
  return `${annotatorId}_${articleId}`;
}

function validateAnnotatorName(name) {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 40) {
    throw new Error("작업자 이름은 1~40자로 입력해 주세요.");
  }
  if (trimmed.includes("/")) {
    throw new Error("작업자 이름에는 / 문자를 사용할 수 없습니다.");
  }
  return trimmed;
}

function shuffleForAnnotator(items, annotatorId) {
  const seedText = String(annotatorId);
  let seed = 0;
  for (let i = 0; i < seedText.length; i += 1) {
    seed = (seed * 31 + seedText.charCodeAt(i)) >>> 0;
  }
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(nextRand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function normalizeArticle(id, data) {
  return {
    article_id: data.article_id ?? Number(id),
    headline: data.headline ?? "",
    press: data.press ?? "",
    category: data.category ?? "",
    published_at: data.published_at ?? "",
    bucket: data.bucket ?? "",
    model_top5_labels: data.model_top5_labels ?? [],
    model_top5_probs: data.model_top5_probs ?? [],
  };
}


async function commitInBatches(writes, size = 450) {
  for (let start = 0; start < writes.length; start += size) {
    const batch = writeBatch(db);
    writes.slice(start, start + size).forEach((write) => write(batch));
    await batch.commit();
  }
}

function getProgressFromAssignments(assignments) {
  const total = assignments.length;
  const done = assignments.filter((a) => a.status === "done").length;
  const skipped = assignments.filter((a) => a.status === "skipped").length;
  return { total, done, skipped, pending: total - done - skipped };
}

async function claimAnnotator(annotatorId) {
  const user = await ensureAuth();
  const ref = doc(db, "annotatorAccess", annotatorId);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    if (snap.data().uid !== user.uid) {
      throw new Error("이 작업자 이름은 이미 다른 브라우저에서 사용 중입니다.");
    }
    return user;
  }
  await setDoc(ref, {
    annotator_id: annotatorId,
    uid: user.uid,
    claimed_at: serverTimestamp(),
  });
  return user;
}


export async function releaseAnnotator(annotatorId) {
  try {
    await ensureAuth();
    await deleteDoc(doc(db, "annotatorAccess", annotatorId));
    return { ok: true };
  } catch (error) {
    if (error?.code === "permission-denied") {
      throw new Error(
        "이 브라우저가 소유한 세션만 종료할 수 있습니다. 다른 주소/브라우저에서 만든 잠금이면 관리자 잠금 해제가 필요합니다."
      );
    }
    throw asError(error, "세션을 종료하지 못했습니다.");
  }
}

export async function getMeta() {
  return {
    groups: Object.entries(GROUPS).map(([name, labels]) => ({ name, labels })),
    none_label: NONE_LABEL,
    skip_reasons: SKIP_REASONS,
    flags: {
      sort_by_model: false,
      show_model_suggestions: false,
    },
  };
}

export async function getAnnotators() {
  try {
    await ensureAuth();
    const snap = await getDocs(collection(db, "annotators"));
    return snap.docs
      .map((d) => ({ annotator_id: d.id, name: d.data().name ?? d.id }))
      .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  } catch (error) {
    throw asError(error, "명단을 불러오지 못했습니다.");
  }
}


export async function createAnnotator(name) {
  try {
    const annotatorId = validateAnnotatorName(name);
    const existing = await getDoc(doc(db, "annotators", annotatorId));
    if (existing.exists()) {
      throw new Error("이미 있는 작업자 이름입니다.");
    }

    await claimAnnotator(annotatorId);
    const articles = await getArticles();
    const writes = [
      (batch) => batch.set(doc(db, "annotators", annotatorId), {
        annotator_id: annotatorId,
        name: annotatorId,
        created_at: serverTimestamp(),
      }),
      ...shuffleForAnnotator(articles, annotatorId).map((article, position) => {
        const id = assignmentId(annotatorId, article.article_id);
        return (batch) => batch.set(doc(db, "assignments", id), {
          assignment_id: id,
          article_id: article.article_id,
          annotator_id: annotatorId,
          position,
          status: "pending",
        });
      }),
    ];
    await commitInBatches(writes);
    return { annotator_id: annotatorId, name: annotatorId };
  } catch (error) {
    throw asError(error, "작업자를 추가하지 못했습니다.");
  }
}

export async function getArticles() {
  try {
    await ensureAuth();
    const snap = await getDocs(collection(db, "articles"));
    return snap.docs
      .map((d) => normalizeArticle(d.id, d.data()))
      .sort((a, b) => {
        const byDate = String(b.published_at).localeCompare(String(a.published_at));
        return byDate || Number(b.article_id) - Number(a.article_id);
      });
  } catch (error) {
    throw asError(error, "기사 목록을 불러오지 못했습니다.");
  }
}

export async function getQueue(annotatorId) {
  try {
    await claimAnnotator(annotatorId);
    const assignmentsQuery = query(
      collection(db, "assignments"),
      where("annotator_id", "==", annotatorId)
    );
    const annotationsQuery = query(
      collection(db, "annotations"),
      where("annotator_id", "==", annotatorId)
    );
    const [assignmentsSnap, annotationsSnap, articles] = await Promise.all([
      getDocs(assignmentsQuery),
      getDocs(annotationsQuery),
      getArticles(),
    ]);

    const articleById = new Map(articles.map((a) => [String(a.article_id), a]));
    const annotationByAssignment = new Map(
      annotationsSnap.docs.map((d) => [d.id, d.data()])
    );
    const assignments = assignmentsSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => Number(a.position) - Number(b.position));

    return {
      items: assignments
        .map((assignment) => {
          const article = articleById.get(String(assignment.article_id));
          if (!article) return null;
          const saved = annotationByAssignment.get(assignment.id);
          return {
            ...article,
            position: assignment.position,
            status: assignment.status ?? "pending",
            saved_labels: saved?.labels ?? null,
            is_skipped: !!saved?.is_skipped,
            skip_reason: saved?.skip_reason ?? null,
            saved_at: timestampToIso(saved?.updated_at),
          };
        })
        .filter(Boolean),
      progress: getProgressFromAssignments(assignments),
    };
  } catch (error) {
    throw asError(error, "큐를 불러오지 못했습니다.");
  }
}

export async function saveAnnotation(payload) {
  try {
    await claimAnnotator(payload.annotator_id);
    const labels = payload.is_skipped ? [] : payload.labels;
    const unknown = labels.filter((label) => !LABEL_SET.has(label));
    if (unknown.length > 0) throw new Error(`알 수 없는 라벨: ${unknown.join(", ")}`);
    if (!payload.is_skipped && labels.length === 0) {
      throw new Error(`라벨 없이 저장할 수 없습니다. 감정 없음은 '${NONE_LABEL}'로 저장하세요.`);
    }
    if (labels.includes(NONE_LABEL) && labels.length > 1) {
      throw new Error(`'${NONE_LABEL}'은 다른 라벨과 함께 저장할 수 없습니다.`);
    }
    if (labels.length > MAX_LABELS) {
      throw new Error(`라벨은 최대 ${MAX_LABELS}개까지 선택할 수 있습니다.`);
    }
    if (payload.is_skipped && !SKIP_REASONS.includes(payload.skip_reason)) {
      throw new Error("스킵 사유를 선택해 주세요.");
    }

    const id = assignmentId(payload.annotator_id, payload.article_id);
    const annotationRef = doc(db, "annotations", id);
    const assignmentRef = doc(db, "assignments", id);
    const batch = writeBatch(db);
    batch.set(annotationRef, {
      assignment_id: id,
      article_id: payload.article_id,
      annotator_id: payload.annotator_id,
      labels,
      is_skipped: !!payload.is_skipped,
      skip_reason: payload.is_skipped ? payload.skip_reason : null,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });
    batch.update(assignmentRef, {
      status: payload.is_skipped ? "skipped" : "done",
    });
    await batch.commit();
    return { ok: true, saved_at: new Date().toISOString() };
  } catch (error) {
    throw asError(error, "저장하지 못했습니다.");
  }
}

function timestampToIso(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  return String(value);
}

// 데이터 목록용: 기사별 저장된 라벨링 (article_id 문자열 → 라벨링 배열)
export async function getArticleAnnotations() {
  try {
    await ensureAuth();
    const snap = await getDocs(collection(db, "annotations"));
    const byArticle = new Map();
    snap.docs.forEach((d) => {
      const data = d.data();
      const key = String(data.article_id);
      const list = byArticle.get(key) ?? [];
      list.push({
        annotator_id: data.annotator_id,
        labels: data.labels ?? [],
        is_skipped: !!data.is_skipped,
        skip_reason: data.skip_reason ?? null,
        saved_at: timestampToIso(data.updated_at),
      });
      byArticle.set(key, list);
    });
    byArticle.forEach((list) =>
      list.sort((a, b) => a.annotator_id.localeCompare(b.annotator_id, "ko")));
    return byArticle;
  } catch (error) {
    throw asError(error, "저장된 라벨링을 불러오지 못했습니다.");
  }
}

// ── 관리자 기능 (앱 내 비밀번호 게이트 뒤에서만 노출) ──

export async function getAdminOverview() {
  try {
    await ensureAuth();
    const [annotatorsSnap, assignmentsSnap] = await Promise.all([
      getDocs(collection(db, "annotators")),
      getDocs(collection(db, "assignments")),
    ]);
    const statsById = new Map();
    assignmentsSnap.docs.forEach((d) => {
      const a = d.data();
      const stats = statsById.get(a.annotator_id) ?? { total: 0, done: 0, skipped: 0 };
      stats.total += 1;
      if (a.status === "done") stats.done += 1;
      else if (a.status === "skipped") stats.skipped += 1;
      statsById.set(a.annotator_id, stats);
    });
    const rows = await Promise.all(annotatorsSnap.docs.map(async (d) => {
      const lock = await getDoc(doc(db, "annotatorAccess", d.id));
      const stats = statsById.get(d.id) ?? { total: 0, done: 0, skipped: 0 };
      return {
        annotator_id: d.id,
        name: d.data().name ?? d.id,
        locked: lock.exists(),
        ...stats,
        pending: stats.total - stats.done - stats.skipped,
      };
    }));
    return rows.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  } catch (error) {
    throw asError(error, "작업자 현황을 불러오지 못했습니다.");
  }
}

export async function unlockAnnotatorLock(annotatorId) {
  try {
    await ensureAuth();
    await deleteDoc(doc(db, "annotatorAccess", annotatorId));
    return { ok: true };
  } catch (error) {
    throw asError(error, "잠금을 해제하지 못했습니다.");
  }
}

export async function deleteAnnotator(annotatorId) {
  try {
    await ensureAuth();
    const [assignmentsSnap, annotationsSnap] = await Promise.all([
      getDocs(query(collection(db, "assignments"), where("annotator_id", "==", annotatorId))),
      getDocs(query(collection(db, "annotations"), where("annotator_id", "==", annotatorId))),
    ]);
    const writes = [
      ...assignmentsSnap.docs.map((d) => (batch) => batch.delete(d.ref)),
      ...annotationsSnap.docs.map((d) => (batch) => batch.delete(d.ref)),
      (batch) => batch.delete(doc(db, "annotatorAccess", annotatorId)),
      (batch) => batch.delete(doc(db, "annotators", annotatorId)),
    ];
    await commitInBatches(writes);
    return { ok: true, deleted_annotations: annotationsSnap.size };
  } catch (error) {
    throw asError(error, "작업자를 삭제하지 못했습니다.");
  }
}

export async function getExportRows(annotatorId = null) {
  try {
    await ensureAuth();
    const annotationsQuery = annotatorId
      ? query(collection(db, "annotations"), where("annotator_id", "==", annotatorId))
      : collection(db, "annotations");
    const [annotationsSnap, articles] = await Promise.all([
      getDocs(annotationsQuery),
      getArticles(),
    ]);
    const articleById = new Map(articles.map((a) => [String(a.article_id), a]));
    return annotationsSnap.docs
      .map((d) => {
        const data = d.data();
        const article = articleById.get(String(data.article_id)) ?? {};
        return {
          annotator_id: data.annotator_id,
          article_id: data.article_id,
          headline: article.headline ?? "",
          press: article.press ?? "",
          category: article.category ?? "",
          published_at: article.published_at ?? "",
          bucket: article.bucket ?? "",
          status: data.is_skipped ? "skipped" : "done",
          labels: data.labels ?? [],
          is_skipped: !!data.is_skipped,
          skip_reason: data.skip_reason ?? "",
          saved_at: timestampToIso(data.updated_at),
        };
      })
      .sort((a, b) =>
        a.annotator_id.localeCompare(b.annotator_id, "ko") ||
        Number(a.article_id) - Number(b.article_id));
  } catch (error) {
    throw asError(error, "라벨링 결과를 불러오지 못했습니다.");
  }
}
