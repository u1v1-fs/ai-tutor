import test from "node:test";
import assert from "node:assert/strict";
import { chunkText, search } from "../server/rag.js";
import { updateStreak, calendarYesterday } from "../server/streak.js";

test("chunkText returns [] for empty input", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   "), []);
  assert.deepEqual(chunkText(null), []);
});

test("chunkText splits long text into multiple chunks", () => {
  const text = "a".repeat(2000);
  const chunks = chunkText(text, { size: 900, overlap: 150 });
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= 900 + 50);
});

test("chunkText preserves content", () => {
  const text = "Hello world. This is a test. Another sentence here.";
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 1);
  assert.ok(chunks.join(" ").includes("Hello world"));
});

test("search returns relevant chunks sorted by score", () => {
  const docs = [
    { id: "d1", name: "Doc1", chunks: ["The quick brown fox jumps over the lazy dog.", "Unrelated content about cars."] },
  ];
  const hits = search(docs, "brown fox", 4);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].docId, "d1");
  assert.ok(hits[0].text.includes("fox"));
});

test("search returns [] for empty query", () => {
  const docs = [{ id: "d1", name: "Doc1", chunks: ["hello world"] }];
  assert.deepEqual(search(docs, ""), []);
  assert.deepEqual(search(docs, "the"), []); // stopword-only
});

test("updateStreak increments on consecutive day", () => {
  const s0 = { count: 3, best: 3, last: "2026-01-01", days: ["2026-01-01"] };
  const s1 = updateStreak(s0, "2026-01-02", "2026-01-01");
  assert.equal(s1.count, 4);
  assert.equal(s1.best, 4);
  assert.equal(s1.last, "2026-01-02");
});

test("updateStreak resets on gap", () => {
  const s0 = { count: 3, best: 5, last: "2026-01-01", days: ["2026-01-01"] };
  const s1 = updateStreak(s0, "2026-01-05", "2026-01-04");
  assert.equal(s1.count, 1);
  assert.equal(s1.best, 5);
});

test("updateStreak no-op on same day", () => {
  const s0 = { count: 3, best: 3, last: "2026-01-02", days: ["2026-01-02"] };
  const s1 = updateStreak(s0, "2026-01-02", "2026-01-01");
  assert.equal(s1.count, 3);
  assert.deepEqual(s1.days, ["2026-01-02"]);
});

test("calendarYesterday returns previous calendar day", () => {
  const d = new Date("2026-03-15T10:00:00");
  const y = calendarYesterday(d);
  assert.equal(y, "2026-03-14");
});
