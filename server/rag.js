// Chunk documents and find the passages that best match a question.
// Keyword scoring (no embeddings, no API cost) — right-sized for a personal
// library; swap in vector search later if the corpus grows big.

const STOP = new Set(
  ("a an and are as at be but by for from has have how i in is it its of on or that the " +
    "this to was were what when where which who why will with you your").split(" ")
);

export function chunkText(text, { size = 900, overlap = 150 } = {}) {
  const clean = String(text || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
  if (!clean) return [];

  // Prefer paragraph / sentence boundaries inside each window.
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const slice = clean.slice(start, end);
      const cut = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "), slice.lastIndexOf("? "));
      if (cut > size * 0.5) end = start + cut + 1;
    }
    const body = clean.slice(start, end).trim();
    if (body) chunks.push(body);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

function terms(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F\u0B80-\u0BFF\u4E00-\u9FFF]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Score every chunk against the question; return the top k. */
export function search(docs, query, k = 4) {
  const q = terms(query);
  if (!q.length) return [];

  const hits = [];
  for (const doc of docs) {
    (doc?.chunks || []).forEach((chunk, index) => {
      const lower = chunk.toLowerCase();
      let score = 0;
      for (const term of q) {
        // Count occurrences, with diminishing returns per term.
        let from = 0;
        let count = 0;
        while (count < 4) {
          const at = lower.indexOf(term, from);
          if (at === -1) break;
          count += 1;
          from = at + term.length;
        }
        if (count) score += 1 + Math.log2(count);
      }
      if (score > 0) hits.push({ doc, index, chunk, score });
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k).map((h) => ({
    docId: h.doc.id,
    docName: h.doc.name,
    chunkIndex: h.index,
    score: Number(h.score.toFixed(2)),
    text: h.chunk,
  }));
}
