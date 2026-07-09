export const EXPORT_COLUMNS = [
  "annotator_id", "article_id", "headline", "press", "category",
  "published_at", "bucket", "status", "labels", "is_skipped",
  "skip_reason", "saved_at",
];

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join("|") : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows, columns = EXPORT_COLUMNS) {
  const lines = [columns.join(",")];
  rows.forEach((row) => {
    lines.push(columns.map((col) => csvCell(row[col])).join(","));
  });
  return lines.join("\r\n");
}

export function downloadCsv(filename, rows, columns = EXPORT_COLUMNS) {
  // BOM: Excel에서 한글 깨짐 방지
  const blob = new Blob(["\uFEFF" + toCsv(rows, columns)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
