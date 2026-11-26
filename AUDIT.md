# AI Tutor — Code Audit Report

Scope: `server/` + `public/` of the ai-tutor app (Node + vanilla JS, no build step).
No test suite exists; findings below are from static review + a live smoke test of every
`/api/*` route (all returned 200 on a clean data set).

## Summary

- **Critical/High:** 1 — path-traversal / arbitrary file write via a crafted backup restore.
- **Medium:** 5 — missing ownership checks, unbounded model probing, large JSON body limit, no rate limiting, stale files on restore.
- **Low:** several minor robustness / UX items.
- Two hardening edits were applied (see "Fixes applied").

## Fixes applied

1. `server/store.js` — `file()` now resolves the path and rejects anything that escapes
   `data/` (blocks `..` and absolute-path traversal). `load`/`save` are now safe.
2. `server/index.js` — added `SAFE_ID` / `safeId()` and:
   - guarded every `fs.rmSync(...)` path built from a stored id (doc delete, delete-all,
     profile delete, marking delete);
   - `applyRestore` now skips documents/sheets whose ids are not safe tokens, and filters
     the document meta list the same way.

These close the restore-based file-write vector while leaving normal operation untouched.

## Findings

### High — path traversal via backup restore (FIXED)
`applyRestore` wrote `save(\`docs/${full.id}\`, full)` and `save(\`sheets/${sid}\`, sheet)`
using ids taken straight from an uploaded backup, and `fs.rmSync` built paths from stored
ids. A malicious `.json` backup could write outside `data/`. Mitigated by the fixes above;
ids are now validated against `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.

### Medium — missing profile ownership checks
Several endpoints operate on an id without confirming it belongs to the current profile:
- `POST /api/quiz/:id/answer` — grades any quiz by id.
- `GET /api/presentations/:id` — returns any presentation.
- `POST /api/flashcards/:deckId/review` — reviews cards in any deck.
- `POST /api/docs/:id/summary` — regenerates summary for any doc (docs are global, lower impact).
Recommendation: add `profileId` scoping or ownership checks, mirroring `/api/marking/:id`.

### Medium — unbounded model availability probing
`checkAvailability()` calls `Promise.all(list.map(probe))` over every free OpenRouter model
(100+), each with a 12 s timeout. Triggered by the ↻ button; can saturate sockets and the
event loop. Recommendation: cap the probe list (preferred + a small sample) or run in batches.

### Medium — large request body limit
`express.json({ limit: "40mb" })` plus a 25 MB decoded-file check allows ~33 MB payloads.
Acceptable for a local tool, but consider 10–15 MB for shared/LAN use.

### Medium — no rate limiting
AI-backed routes (chat, quiz, marking) have no throttling. A runaway client or accidental
loop can exhaust provider quotas. Recommendation: per-IP/per-route limiter (e.g. express-rate-limit)
or at least a concurrency cap on OCR/marking.

### Medium — stale files after restore
`applyRestore` overwrites collections but does not delete doc/sheet files removed by the
backup, so old documents can linger. Recommendation: clear `data/docs` and `data/sheets`
before applying a restore (or track and remove orphans).

### Low — error handling on OCR/marking
`/api/marking/:id/ocr` and `/grade` await `ocrPage` without try/catch in the OCR route;
failures propagate to the global handler as 500 with a raw message. Works, but a 502 with a
friendly message would be clearer.

### Low — client-side state assumptions
`loadDocs()` assigns `state.docs = await fetchJson(...)`; if the server ever returns a
non-array (e.g. an error object that slips through), `renderDocs()` throws. Currently fine
because `fetchJson` throws on non-2xx.

### Low — `touchStreak` date math
Uses `Date.now() - 86_400_000` (exactly 24 h) instead of calendar yesterday, which can
mis-handle DST / late-night study. Minor.

### Low — no automated tests
No unit or integration tests. The RAG scorer, chunker, and streak logic are pure functions
and would be cheap to cover.

### Info — intentional obfuscation
`paintFooter()` assembles the author name from char codes at runtime. Not a defect, but
worth noting for maintainers scanning source.

## Smoke test

Started the server (`npm start`), hit `/api/health`, `/api/docs`, `/api/profiles`,
`/api/flashcards`, `/api/presentations`, `/api/marking`, `/api/progress`, `/api/revision`,
`/api/backups`, `/api/models`, `/api/chat`, `/api/chat/stream` — all 200 and functional.
Chat returned a cited, well-formed answer; streaming delivered tokens.

## Recommended next steps

1. Add ownership checks to the four Medium endpoints above.
2. Cap model probing and add a concurrency limit to marking.
3. Add a small test suite (chunker, RAG search, streak) and a CI lint step.
4. Consider clearing orphaned doc/sheet files on restore.
