import "dotenv/config";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";

import * as ai from "./ai.js";
import { chunkText, search } from "./rag.js";
import { load, save, DATA_DIR } from "./store.js";
import { updateStreak, calendarYesterday } from "./streak.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 4343);

const app = express();
app.disable("x-powered-by");
// CORS for a separately hosted frontend (e.g. Cloudflare Pages).
const CORS_ORIGIN = process.env.CORS_ORIGIN || "";
if (CORS_ORIGIN) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (CORS_ORIGIN === "*" || CORS_ORIGIN.split(",").map((s) => s.trim()).includes(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
}
app.use(express.json({ limit: "40mb" })); // PDFs arrive as base64 data URLs

// Live data must never be served from the browser's cache (streak/revision/model checks).
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Async route errors must reach the error handler, not kill the process.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const route = { get: (p, fn) => app.get(p, wrap(fn)), post: (p, fn) => app.post(p, wrap(fn)), delete: (p, fn) => app.delete(p, wrap(fn)) };

// ── collections ─────────────────────────────────────────────────────────
// Docs live one-file-per-document (id, meta, chunks). The rest are small.
// Everything study-related is scoped to the current profile.

let profiles = load("profiles", []); // [{ id, name, at }]
if (!Array.isArray(profiles)) profiles = [];
if (!profiles.length) {
  profiles.push({ id: "p_default", name: "Student", at: Date.now() });
  save("profiles", profiles);
}

const mySettings = () => load("settings", {});
const curProfile = () => {
  const want = mySettings().profileId;
  return profiles.some((p) => p.id === want) ? want : profiles[0].id;
};
const profileName = () => profiles.find((p) => p.id === curProfile())?.name || "Student";

let chats = load("chats", []); // { id, profileId, docId, role, text, sources, at }
if (!Array.isArray(chats)) chats = [];
let quizzes = load("quizzes", []); // { id, profileId, docId, questions:[{q, options, answer, why}], results }
if (!Array.isArray(quizzes)) quizzes = [];
let presentations = load("presentations", []); // { id, profileId, topic, title, slides:[...], at }
if (!Array.isArray(presentations)) presentations = [];
let flashcards = load("flashcards", []); // decks { id, profileId, docId, docName, mode, cards:[{id,q,a,topic,due,days,reps,lapses}] }
if (!Array.isArray(flashcards)) flashcards = [];
let students = load("students", []); // class roster { id, profileId, name, pages, result, gradedAt, at }
if (!Array.isArray(students)) students = [];

// progress is stored per profile: { byProfile: { [profileId]: {answered, correct, byTopic, sessions, streak} } }
let progressStore = load("progress", null);
const freshProgress = () => ({
  answered: 0,
  correct: 0,
  byTopic: {}, // topic -> { answered, correct }
  sessions: [], // recent quiz sessions
  streak: { count: 0, best: 0, last: null, days: [] },
});
if (!progressStore || typeof progressStore !== "object" || !progressStore.byProfile) {
  // legacy single-profile shape → wrap it
  const legacy =
    progressStore && typeof progressStore === "object" && progressStore.byTopic
      ? progressStore
      : null;
  progressStore = { byProfile: {} };
  if (legacy) progressStore.byProfile[profiles[0].id] = { ...freshProgress(), ...legacy, streak: legacy.streak || freshProgress().streak };
  save("progress", progressStore);
}
const myProgress = () => {
  const pid = curProfile();
  if (!progressStore.byProfile[pid]) progressStore.byProfile[pid] = freshProgress();
  return progressStore.byProfile[pid];
};
const saveProgress = () => save("progress", progressStore);

// Migrate pre-profile records so they belong to the first profile.
for (const c of chats) if (!c.profileId) c.profileId = profiles[0].id;
for (const q of quizzes) if (!q.profileId) q.profileId = profiles[0].id;
for (const p of presentations) if (!p.profileId) p.profileId = profiles[0].id;
for (const d of flashcards) if (!d.profileId) d.profileId = profiles[0].id;
for (const s of students) if (!s.profileId) s.profileId = profiles[0].id;

function id(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
}

const listDocs = () => load("documents", []);
const saveDocs = (docs) => save("documents", docs);
const getDoc = (id) => listDocs().find((d) => d.id === id) || null;

// Storage ids must be simple, safe tokens — never paths or traversal.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function safeId(v) {
  return typeof v === "string" && SAFE_ID.test(v);
}

// ── activation / licensing ──────────────────────────────────────────────
// Optional device-bound, one-time activation keys with an expiry date.
// Enable with REQUIRE_ACTIVATION=true. Keys are signed with ACTIVATION_SECRET
// (keep the matching key generator private).

const ACTIVATION_REQUIRED = /^(1|true|yes|on)$/i.test(String(process.env.REQUIRE_ACTIVATION || ""));
const ACTIVATION_SECRET = String(process.env.ACTIVATION_SECRET || "ai-tutor-activation-secret-change-me");

function makeDeviceId() {
  const h = crypto.randomBytes(6).toString("hex").toUpperCase();
  return `DEV-${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
}

let deviceStore = load("device", null);
if (!deviceStore || typeof deviceStore.id !== "string" || !safeId(deviceStore.id)) {
  deviceStore = { id: makeDeviceId(), createdAt: Date.now() };
  save("device", deviceStore);
}
const DEVICE_ID = deviceStore.id;

let activationStore = load("activation", null);
if (!activationStore || typeof activationStore !== "object") activationStore = { usedNonces: [] };
if (!Array.isArray(activationStore.usedNonces)) activationStore.usedNonces = [];

function activationStatus() {
  const act =
    activationStore.active && activationStore.active.deviceId === DEVICE_ID
      ? activationStore.active
      : null;
  const expiresAt = act ? Number(act.expiresAt) || null : null;
  const expired = Boolean(expiresAt && Date.now() > expiresAt);
  return {
    required: ACTIVATION_REQUIRED,
    deviceId: DEVICE_ID,
    activated: Boolean(act && !expired),
    expiresAt,
    expired,
    daysLeft: expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 86_400_000)) : null,
  };
}

function verifyActivationKey(raw) {
  const m = /^AK1-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(raw || "").trim());
  if (!m) return { error: "That does not look like an activation key (expected AK1-…)." };

  const payload = m[1];
  const expected = crypto.createHmac("sha256", ACTIVATION_SECRET).update(payload).digest("base64url");
  const got = m[2];
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { error: "Invalid activation key." };
  }

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { error: "Invalid activation key." };
  }
  if (!data || data.v !== 1) return { error: "Unsupported activation key version." };
  if (String(data.d) !== DEVICE_ID) return { error: "This key was issued for a different device." };

  const expiresAt = Number(data.e);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return { error: "This activation key has expired." };
  }
  if (!data.n || activationStore.usedNonces.includes(data.n)) {
    return { error: "This activation key has already been used." };
  }
  return { data: { ...data, expiresAt } };
}

// ── helpers ─────────────────────────────────────────────────────────────

function docsForSearch(docId) {
  return listDocs()
    .filter((d) => !docId || d.id === docId)
    .map((d) => load(`docs/${d.id}`, d)); // full doc (with chunks); falls back to meta
}

function topicOf(doc) {
  // Rough topic = first heading-ish line of the doc name without extension.
  return String(doc.name || "General").replace(/\.[a-z0-9]+$/i, "").slice(0, 40);
}

function progressSummary() {
  const progress = myProgress();
  const acc = progress.answered ? Math.round((progress.correct / progress.answered) * 100) : null;
  const weak = Object.entries(progress.byTopic)
    .filter(([, s]) => s.answered >= 3 && s.correct / s.answered < 0.6)
    .map(([topic]) => topic)
    .slice(0, 5);
  return { accuracy: acc, answered: progress.answered, weakTopics: weak };
}

// ── answer language (Settings → Language) ───────────────────────────────

const LANGS = { en: "English", ur: "Urdu", hi: "Hindi" };

function langInstruction() {
  const lang = mySettings().lang || "en";
  if (lang === "ur")
    return "\nIMPORTANT: Write your whole response in URDU using the Urdu script (right-to-left, Nastaliq style). Keep scientific/technical terms in English inside parentheses where that helps.";
  if (lang === "hi")
    return "\nIMPORTANT: Write your whole response in HINDI using the Devanagari script. Keep scientific/technical terms in English inside parentheses where that helps.";
  return "";
}

/** Study activity today → keeps the daily streak alive. */
function touchStreak() {
  const p = myProgress();
  const today = new Date().toLocaleDateString("en-CA"); // local yyyy-mm-dd
  if (p.streak.last === today) return p.streak;
  const yesterday = calendarYesterday();
  p.streak = updateStreak(p.streak, today, yesterday);
  saveProgress();
  return p.streak;
}

// ── activation routes + gate ────────────────────────────────────────────

route.get("/api/activation/status", (_req, res) => res.json({ ok: true, ...activationStatus() }));

route.post("/api/activation", (req, res) => {
  const key = String(req.body?.key || "").trim();
  if (!key) return res.status(400).json({ error: "Paste an activation key." });
  const v = verifyActivationKey(key);
  if (v.error) return res.status(400).json({ error: v.error });

  activationStore.active = {
    deviceId: DEVICE_ID,
    keyId: v.data.n,
    activatedAt: Date.now(),
    expiresAt: v.data.expiresAt,
  };
  activationStore.usedNonces.push(v.data.n);
  activationStore.usedNonces = activationStore.usedNonces.slice(-500);
  save("activation", activationStore);
  res.json({ ok: true, ...activationStatus() });
});

// When activation is required, block all other API routes until a valid key
// is active. The static SPA still loads so the activation screen can appear.
app.use("/api", (req, res, next) => {
  if (!ACTIVATION_REQUIRED) return next();
  if (req.path === "/activation" || req.path === "/activation/status" || req.path === "/health") {
    return next();
  }
  const st = activationStatus();
  if (st.activated) return next();
  return res.status(403).json({
    error: st.expired ? "Activation expired. Enter a new key." : "Activation required.",
    code: "activation_required",
    deviceId: st.deviceId,
    expired: st.expired,
  });
});

// ── documents ───────────────────────────────────────────────────────────

route.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    ...ai.describe(),
    lang: mySettings().lang || "en",
    profile: profileName(),
    profiles: profiles.map(({ id, name }) => ({ id, name })),
  })
);

// ── model switching (all free OpenRouter models) ────────────────────────

let modelsCache = { at: 0, list: [] };

async function freeModelList() {
  if (modelsCache.list.length && Date.now() - modelsCache.at < 30 * 60 * 1000) {
    return modelsCache.list;
  }
  const r = await fetch("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(15_000),
  }).then((x) => x.json());
  const list = (r.data || [])
    .filter((m) => m.id.endsWith(":free"))
    .map((m) => m.id)
    .sort();
  if (list.length) modelsCache = { at: Date.now(), list };
  return list;
}

route.get("/api/models", async (req, res) => {
  try {
    if (req.query.refresh) modelsCache = { at: 0, list: [] }; // ↻ forces a fresh fetch
    const list = await freeModelList();
    res.json({ ok: true, models: list, current: ai.describe().model });
  } catch {
    res.json({ ok: true, models: [ai.describe().model], current: ai.describe().model });
  }
});

// ── live availability check (the ↻ button) ──────────────────────────────
// Probes every free model with a tiny request so rate-limited ones are visible.

const PREFERRED = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3.5-super-vl:free",
];

let availCache = { at: 0, result: null };
let availInflight = null;

async function checkAvailability() {
  const list = await freeModelList();

  // Cap the probe list to avoid saturating sockets/event loop: preferred models
  // plus a small sample of the rest.
  const probeList = [];
  for (const m of PREFERRED) if (list.includes(m) && !probeList.includes(m)) probeList.push(m);
  for (const m of list) {
    if (probeList.length >= 25) break;
    if (!probeList.includes(m)) probeList.push(m);
  }

  const probe = (model) =>
    fetch(`${ai.provider.base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(ai.provider.apiKey ? { Authorization: `Bearer ${ai.provider.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Hi" }], max_tokens: 5 }),
    })
      .then((r) => (r.ok ? "ok" : r.status === 429 ? "limited" : "err" + r.status))
      .catch(() => "timeout");

  const entries = await Promise.all(probeList.map(async (m) => [m, await probe(m)]));
  const map = Object.fromEntries(entries);
  const okModels = entries.filter(([, s]) => s === "ok").map(([m]) => m);
  const result = {
    map,
    best: PREFERRED.find((m) => map[m] === "ok") || okModels[0] || null,
    okCount: okModels.length,
    checkedAt: Date.now(),
  };
  availCache = { at: Date.now(), result };
  return result;
}

route.get("/api/models/check", async (_req, res) => {
  if (Date.now() - availCache.at < 3 * 60 * 1000 && availCache.result) {
    return res.json({ ok: true, ...availCache.result, current: ai.describe().model });
  }
  try {
    if (!availInflight) {
      availInflight = checkAvailability().finally(() => (availInflight = null));
    }
    const result = await availInflight;
    res.json({ ok: true, ...result, current: ai.describe().model });
  } catch (err) {
    res.status(502).json({ error: "Could not check models: " + err.message });
  }
});

route.post("/api/model", (req, res) => {
  const model = String(req.body?.model || "").trim();
  if (!/^[a-z0-9][a-z0-9._\/:-]*(:free)?$/i.test(model) || model.includes("..")) {
    return res.status(400).json({ error: "That does not look like a model id." });
  }
  const current = ai.setModel(model);
  res.json({ ok: true, model: current });
});

// fix spelling/typos in the Ask box
route.post("/api/spellcheck", async (req, res) => {
  const text = String(req.body?.text || "").trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: "Nothing to check." });
  try {
    const corrected = await ai.chat(
      [
        {
          role: "system",
          content:
            "You fix spelling and typing mistakes in the user's text. Keep the language and meaning. " +
            "Reply with ONLY the corrected text — no quotes, no explanations. " +
            "If it is already correct, reply with it unchanged.",
        },
        { role: "user", content: text },
      ],
      { temperature: 0 }
    );
    res.json({ ok: true, corrected: corrected.trim().replace(/^["']|["']$/g, "") });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

route.get("/api/docs", (_req, res) => {
  // self-heal: docs left without a summary (e.g. after a restore) get one generated
  const metas = listDocs();
  for (const meta of metas.slice(0, 3)) {
    if (!meta.summary && !summaryPending.has(meta.id)) {
      summaryPending.add(meta.id);
      generateSummary(meta.id).finally(() => summaryPending.delete(meta.id));
    }
  }
  res.json(
    metas.map(({ id, name, chars, chunkCount, createdAt, summary }) => ({
      id,
      name,
      chars,
      chunkCount,
      createdAt,
      ...(summary ? { summary } : {}),
    }))
  );
});

const summaryPending = new Set();

route.post("/api/docs", async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 120) || "Untitled";
  const dataUrl = String(req.body?.data || "");

  const m =
    /^data:((?:text\/plain)|(?:text\/markdown)|(?:application\/pdf)|(?:application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document));base64,([A-Za-z0-9+/=]+)$/.exec(
      dataUrl
    );
  if (!m) {
    return res.status(400).json({ error: "Send the file as a base64 data URL (pdf, docx, txt or md). Old .doc files must be saved as .docx first." });
  }

  const bytes = Buffer.from(m[2], "base64");
  if (!bytes.length) return res.status(400).json({ error: "That file is empty." });
  if (bytes.length > 25 * 1024 * 1024) {
    return res.status(413).json({ error: "File too large (25 MB max)." });
  }

  let text = "";
  try {
    if (m[1] === "application/pdf") {
      const out = await pdfParse(bytes);
      text = out.text || "";
    } else if (m[1].includes("wordprocessingml")) {
      const out = await mammoth.extractRawText({ buffer: bytes });
      text = out.value || "";
    } else {
      text = bytes.toString("utf8");
    }
  } catch (err) {
    return res.status(400).json({ error: "Could not read that file: " + err.message });
  }

  text = text.replace(/\u0000/g, "").trim();
  if (text.length < 40) {
    return res.status(400).json({
      error:
        "Almost no text found in that file. Scanned PDFs have no extractable text — try a text-based PDF.",
    });
  }

  const chunks = chunkText(text);
  const doc = {
    id: id("doc_"),
    name,
    chars: text.length,
    chunkCount: chunks.length,
    createdAt: Date.now(),
    chunks,
  };

  save(`docs/${doc.id}`, doc);
  const docs = listDocs();
  docs.push({
    id: doc.id,
    name: doc.name,
    chars: doc.chars,
    chunkCount: doc.chunkCount,
    createdAt: doc.createdAt,
  });
  saveDocs(docs);

  generateSummary(doc.id); // fire-and-forget — the summary card appears when ready

  res.json({ ok: true, doc: { id: doc.id, name: doc.name, chars: doc.chars, chunkCount: doc.chunkCount } });
});

// ── auto-summary + key points (generated after every upload) ────────────

async function generateSummary(docId) {
  try {
    const doc = getDoc(docId);
    if (!doc) return;
    const full = load(`docs/${doc.id}`, doc);
    const material = (full.chunks || []).slice(0, 8).join("\n\n").slice(0, 8000);
    const raw = await ai.chat(
      [
        { role: "system", content: "You summarise study material precisely. Output JSON only." + langInstruction() },
        {
          role: "user",
          content: `Summarise this material for a student.
Return STRICT JSON: {"summary":"3-5 sentences","points":["5-8 short key points"],"terms":[{"term":"...","def":"one line"}]}
Leave "terms" empty if there are no key terms.
MATERIAL:
${material}`,
        },
      ],
      { temperature: 0.3, json: true }
    );
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    const summary = {
      text: String(parsed.summary || "").slice(0, 1500),
      points: (Array.isArray(parsed.points) ? parsed.points : []).map(String).slice(0, 8),
      terms: (Array.isArray(parsed.terms) ? parsed.terms : [])
        .filter((t) => t && t.term)
        .map((t) => ({ term: String(t.term).slice(0, 60), def: String(t.def || "").slice(0, 200) }))
        .slice(0, 6),
      at: Date.now(),
    };
    if (!summary.text && !summary.points.length) return;
    const docs = listDocs();
    const meta = docs.find((d) => d.id === docId);
    if (!meta) return;
    meta.summary = summary;
    saveDocs(docs);
  } catch {
    /* best-effort — the retry button regenerates it */
  }
}

// (re)generate a summary on demand
route.post("/api/docs/:id/summary", async (req, res) => {
  const doc = getDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: "No such document." });
  await generateSummary(doc.id);
  const meta = listDocs().find((d) => d.id === doc.id);
  res.json({ ok: true, summary: meta?.summary || null });
});

route.delete("/api/docs/:id", (req, res) => {
  const docs = listDocs();
  const at = docs.findIndex((d) => d.id === req.params.id);
  if (at === -1) return res.status(404).json({ error: "No such document." });

  const [removed] = docs.splice(at, 1);
  saveDocs(docs);
  if (safeId(removed.id)) {
    try {
      fs.rmSync(path.join(DATA_DIR, "docs", `${removed.id}.json`), { force: true });
    } catch {
      /* already gone */
    }
  }
  res.json({ ok: true });
});

// delete every document (Settings → Data)
route.delete("/api/docs", (_req, res) => {
  const docs = listDocs();
  for (const d of docs) {
    if (!safeId(d.id)) continue;
    try {
      fs.rmSync(path.join(DATA_DIR, "docs", `${d.id}.json`), { force: true });
    } catch {
      /* already gone */
    }
  }
  saveDocs([]);
  res.json({ ok: true, removed: docs.length });
});

// ── video presentations ─────────────────────────────────────────────────

route.post("/api/present", async (req, res) => {
  const topic = String(req.body?.topic || "").trim().slice(0, 120);
  const docId = req.body?.docId || null;
  if (!topic && !docId) {
    return res.status(400).json({ error: "Type a topic or pick a document." });
  }

  let material = "";
  let docName = null;
  if (docId) {
    const doc = getDoc(docId);
    if (!doc) return res.status(400).json({ error: "No such document." });
    const full = load(`docs/${doc.id}`, doc);
    material = (full.chunks || []).slice(0, 10).join("\n\n").slice(0, 8000);
    docName = doc.name;
  }

  const prompt = `Create a narrated slide presentation teaching this subject.
Return STRICT JSON: {"title":"...","slides":[{"title":"...","points":["short bullet","short bullet"],"narration":"2-3 sentences a tutor would say aloud"}]}
Rules: 6-8 slides, simple language, one idea per slide, last slide is a short recap.
${langInstruction()}
${topic ? `TOPIC: ${topic}` : "TOPIC: the main subject of the material"}
${material ? `\nMATERIAL:\n${material}` : ""}`;

  try {
    const raw = await ai.chat(
      [
        { role: "system", content: "You create clear, engaging lesson slides. Output JSON only." },
        { role: "user", content: prompt },
      ],
      { temperature: 0.5, json: true }
    );

    const parsed = JSON.parse(raw);
    const slides = (parsed.slides || [])
      .filter((s) => s && s.title)
      .map((s) => ({
        title: String(s.title).slice(0, 140),
        points: Array.isArray(s.points) ? s.points.map((p) => String(p).slice(0, 160)).slice(0, 5) : [],
        narration: String(s.narration || ""),
      }));
    if (!slides.length) throw new Error("The model returned no slides.");

    const pres = {
      id: id("pr_"),
      profileId: curProfile(),
      topic: topic || docName || "Lesson",
      docName,
      title: String(parsed.title || topic || "Lesson").slice(0, 140),
      slides,
      at: Date.now(),
    };
    presentations.unshift(pres);
    presentations = presentations.slice(0, 40);
    save("presentations", presentations);
    res.json({ ok: true, presentation: pres });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

route.get("/api/presentations", (_req, res) => {
  const pid = curProfile();
  res.json(
    presentations
      .filter((p) => !p.profileId || p.profileId === pid)
      .map(({ id, topic, title, slides, at }) => ({
        id,
        topic,
        title,
        slideCount: slides.length,
        at,
      }))
  );
});

route.get("/api/presentations/:id", (req, res) => {
  const pid = curProfile();
  const p = presentations.find((x) => x.id === req.params.id && (!x.profileId || x.profileId === pid));
  if (!p) return res.status(404).json({ error: "No such presentation." });
  res.json(p);
});

// ── curriculum tracks ────────────────────────────────────────────────────
// Structured learning paths from basics to advanced, with on-demand lessons/quizzes.

const ROBOTICS_CURRICULUM = [
  { level: "Beginner", topics: ["What is a robot?", "Sensors basics", "Actuators & motors", "Simple circuits", "Scratch / block coding", "Line follower robot"] },
  { level: "Intermediate", topics: ["Arduino programming", "PWM & motor drivers", "Ultrasonic & IR sensors", "Servo control", "PID control basics", "Obstacle avoidance"] },
  { level: "Advanced", topics: ["Raspberry Pi & Linux", "Computer vision (OpenCV)", "ROS fundamentals", "Inverse kinematics", "SLAM basics", "Path planning"] },
  { level: "Expert", topics: ["ROS2 & Nav2", "Deep learning for robotics", "Reinforcement learning", "Multi-robot systems", "Human-robot interaction", "Capstone project"] },
];

const CURRICULUM_TRACKS = [
  { id: "robotics", name: "Robotics", icon: "🤖", levels: ROBOTICS_CURRICULUM },
  {
    id: "ai-data", name: "AI & Data Literacy", icon: "🧠",
    levels: [
      { level: "Beginner", topics: ["How AI works", "Everyday AI tools", "What is data?", "Reading simple charts", "AI safety basics"] },
      { level: "Intermediate", topics: ["Training vs inference", "Bias in data & models", "Prompting & verifying", "Correlation vs causation", "Privacy & consent"] },
      { level: "Advanced", topics: ["Model evaluation", "Hallucinations & limits", "Data storytelling", "AI in society", "Build a small data project"] },
    ],
  },
  {
    id: "computational-thinking", name: "Computational Thinking & Making", icon: "💻",
    levels: [
      { level: "Beginner", topics: ["Algorithms in daily life", "Sequencing & loops", "Block coding", "Intro to Python", "Debugging basics"] },
      { level: "Intermediate", topics: ["Functions & variables", "Data structures", "Physical computing", "3D design & printing", "Version control"] },
      { level: "Advanced", topics: ["APIs & automation", "IoT projects", "Simulation & digital twins", "Working with AI-generated code", "Portfolio project"] },
    ],
  },
  {
    id: "digital-safety", name: "Digital Safety & Cybersecurity", icon: "🛡️",
    levels: [
      { level: "Beginner", topics: ["Strong passwords", "Phishing & scams", "Two-factor authentication", "Safe browsing", "Digital footprint"] },
      { level: "Intermediate", topics: ["Device security", "Privacy settings", "Social engineering", "Deepfakes & impersonation", "Healthy tech habits"] },
      { level: "Advanced", topics: ["Threat modelling", "Encryption basics", "Incident response", "Cyber ethics & law", "Securing a small project"] },
    ],
  },
  {
    id: "media-literacy", name: "Media & Information Literacy", icon: "🔎",
    levels: [
      { level: "Beginner", topics: ["Fact vs opinion", "Checking a source", "Spotting clickbait", "Search operators", "Citing evidence"] },
      { level: "Intermediate", topics: ["Misinformation tactics", "AI-generated content", "Primary vs secondary sources", "Bias in media", "Cross-checking claims"] },
      { level: "Advanced", topics: ["Investigative research", "Statistical fallacies", "Media ownership & incentives", "Building a fact-check", "Debating with evidence"] },
    ],
  },
  {
    id: "human-skills", name: "Human Skills", icon: "🤝",
    levels: [
      { level: "Beginner", topics: ["Critical thinking", "Asking good questions", "Active listening", "Teamwork basics", "Giving feedback"] },
      { level: "Intermediate", topics: ["Problem framing", "Creative ideation", "Conflict resolution", "Presenting ideas", "Learning how to learn"] },
      { level: "Advanced", topics: ["Design thinking", "Leadership & delegation", "Negotiation", "Facilitating groups", "Leading a project"] },
    ],
  },
  {
    id: "ethics-citizenship", name: "Ethics & Global Citizenship", icon: "🌍",
    levels: [
      { level: "Beginner", topics: ["Right vs wrong online", "Respect & empathy", "Digital citizenship", "Cultural awareness", "Community rules"] },
      { level: "Intermediate", topics: ["AI ethics", "Fairness & accountability", "Human rights", "Civic literacy", "Sustainable choices"] },
      { level: "Advanced", topics: ["Technology policy", "Global inequalities", "Ethical design", "Social impact projects", "Debating trade-offs"] },
    ],
  },
  {
    id: "financial-literacy", name: "Financial Literacy", icon: "💰",
    levels: [
      { level: "Beginner", topics: ["Needs vs wants", "Budgeting", "Saving", "Smart spending", "Avoiding scams"] },
      { level: "Intermediate", topics: ["Interest & debt", "Banking & payments", "Investing basics", "Insurance", "Digital money safety"] },
      { level: "Advanced", topics: ["Risk & diversification", "Taxes", "Entrepreneurship", "Freelancing & pricing", "Long-term planning"] },
    ],
  },
  {
    id: "sustainability", name: "Sustainability & Systems Thinking", icon: "♻️",
    levels: [
      { level: "Beginner", topics: ["Climate basics", "Reduce, reuse, recycle", "Energy at home", "Water & waste", "Local ecosystems"] },
      { level: "Intermediate", topics: ["Feedback loops", "Circular economy", "Renewable energy", "Carbon footprints", "Sustainable design"] },
      { level: "Advanced", topics: ["Systems modelling", "Trade-offs & policy", "Climate adaptation", "Green technology", "Community project"] },
    ],
  },
  {
    id: "health-biotech", name: "Health & Biotech Literacy", icon: "🧬",
    levels: [
      { level: "Beginner", topics: ["Healthy habits", "Mental health basics", "Nutrition", "First aid", "Sleep & screens"] },
      { level: "Intermediate", topics: ["How the body works", "Genetics basics", "Vaccines & immunity", "Health misinformation", "Bioethics"] },
      { level: "Advanced", topics: ["Genomics", "Biotechnology applications", "Public health", "Medical AI", "Research ethics"] },
    ],
  },
  {
    id: "career-navigation", name: "Career Navigation", icon: "🧭",
    levels: [
      { level: "Beginner", topics: ["Knowing your strengths", "Exploring careers", "Goal setting", "Study habits", "Asking for help"] },
      { level: "Intermediate", topics: ["Building a portfolio", "Personal branding", "Micro-credentials", "Networking", "Interview basics"] },
      { level: "Advanced", topics: ["Working with automation", "Continuous upskilling", "Freelancing & remote work", "Career pivots", "Lifelong learning plan"] },
    ],
  },
];

const trackById = (trackId) => CURRICULUM_TRACKS.find((t) => t.id === trackId) || null;

route.get("/api/curriculum", (_req, res) => res.json({ ok: true, tracks: CURRICULUM_TRACKS }));

// Legacy alias used by earlier builds.
route.get("/api/robotics/curriculum", (_req, res) =>
  res.json({ ok: true, curriculum: trackById("robotics").levels })
);

async function generateCurriculumLesson(req, res, trackId) {
  const track = trackById(String(trackId || ""));
  if (!track) return res.status(400).json({ error: "Pick a curriculum track." });
  const level = String(req.body?.level || "Beginner").trim().slice(0, 40);
  const topic = String(req.body?.topic || "").trim().slice(0, 120);
  if (!topic) return res.status(400).json({ error: "Pick a topic." });

  const prompt = `Create a narrated slide presentation teaching this ${track.name} topic to a ${level} student.
Return STRICT JSON: {"title":"...","slides":[{"title":"...","points":["short bullet","short bullet"],"narration":"2-3 sentences a tutor would say aloud"}]}
Rules: 6-8 slides, simple language, one idea per slide, last slide is a short recap. Include a hands-on mini activity where appropriate.
${langInstruction()}
TRACK: ${track.name}
TOPIC: ${topic}
LEVEL: ${level}`;

  try {
    const raw = await ai.chat(
      [
        { role: "system", content: `You are an expert ${track.name} educator. Output JSON only.` },
        { role: "user", content: prompt },
      ],
      { temperature: 0.5, json: true }
    );
    const parsed = JSON.parse(raw);
    const slides = (parsed.slides || [])
      .filter((s) => s && s.title)
      .map((s) => ({
        title: String(s.title).slice(0, 140),
        points: Array.isArray(s.points) ? s.points.map((p) => String(p).slice(0, 160)).slice(0, 5) : [],
        narration: String(s.narration || ""),
      }));
    if (!slides.length) throw new Error("The model returned no slides.");

    const pres = {
      id: id("pr_"),
      profileId: curProfile(),
      topic: `${track.name}: ${topic}`,
      docName: null,
      title: String(parsed.title || topic).slice(0, 140),
      slides,
      trackId: track.id,
      trackName: track.name,
      level,
      at: Date.now(),
    };
    presentations.unshift(pres);
    presentations = presentations.slice(0, 40);
    save("presentations", presentations);
    res.json({ ok: true, presentation: pres });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
}

async function generateCurriculumQuiz(req, res, trackId) {
  const track = trackById(String(trackId || ""));
  if (!track) return res.status(400).json({ error: "Pick a curriculum track." });
  const level = String(req.body?.level || "Beginner").trim().slice(0, 40);
  const topic = String(req.body?.topic || "").trim().slice(0, 120);
  const count = Math.min(10, Math.max(3, Number(req.body?.count) || 5));
  if (!topic) return res.status(400).json({ error: "Pick a topic." });

  const prompt = `Create a ${count}-question multiple-choice quiz on this ${track.name} topic for a ${level} student.
Each question must be answerable from general knowledge of the topic.
Return STRICT JSON: {"questions":[{"q":"...","options":["a","b","c","d"],"answer":0,"why":"one line","topic":"2-4 words"}]}
${langInstruction()}
TRACK: ${track.name}
TOPIC: ${topic}
LEVEL: ${level}`;

  try {
    const raw = await ai.chat(
      [
        { role: "system", content: `You write clean exam-style ${track.name} quizzes. Output JSON only.` },
        { role: "user", content: prompt },
      ],
      { temperature: 0.6, json: true }
    );
    const parsed = JSON.parse(raw);
    const questions = (parsed.questions || [])
      .filter((q) => q && q.q && Array.isArray(q.options) && q.options.length >= 2)
      .map((q) => ({
        q: String(q.q),
        options: q.options.map(String).slice(0, 6),
        answer: Number(q.answer) || 0,
        why: String(q.why || ""),
        topic: String(q.topic || topic).slice(0, 40),
      }));
    if (!questions.length) throw new Error("The model returned no usable questions.");

    const quiz = {
      id: id("qz_"),
      profileId: curProfile(),
      docId: null,
      docName: `${track.name}: ${topic} (${level})`,
      questions,
      results: null,
      trackId: track.id,
      trackName: track.name,
      level,
      at: Date.now(),
    };
    quizzes.unshift(quiz);
    quizzes = quizzes.slice(0, 60);
    save("quizzes", quizzes);
    res.json({ ok: true, quiz });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
}

route.post("/api/curriculum/lesson", (req, res) => generateCurriculumLesson(req, res, req.body?.trackId));
route.post("/api/curriculum/quiz", (req, res) => generateCurriculumQuiz(req, res, req.body?.trackId));
route.post("/api/robotics/lesson", (req, res) => generateCurriculumLesson(req, res, "robotics"));
route.post("/api/robotics/quiz", (req, res) => generateCurriculumQuiz(req, res, "robotics"));

// ── profiles (each student keeps their own progress) ────────────────────

route.get("/api/profiles", (_req, res) => {
  res.json({ ok: true, profiles, current: curProfile() });
});

route.post("/api/profiles", (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: "Type a name for the profile." });
  if (profiles.length >= 8) return res.status(400).json({ error: "Up to 8 profiles." });
  const p = { id: id("p_"), name, at: Date.now() };
  profiles.push(p);
  save("profiles", profiles);
  res.json({ ok: true, profile: p, current: curProfile() });
});

route.post("/api/profiles/switch", (req, res) => {
  const want = String(req.body?.id || "");
  if (!profiles.some((p) => p.id === want)) return res.status(404).json({ error: "No such profile." });
  const s = mySettings();
  s.profileId = want;
  save("settings", s);
  res.json({ ok: true, current: want });
});

route.delete("/api/profiles/:id", (req, res) => {
  const pid = String(req.params.id);
  if (profiles.length <= 1) return res.status(400).json({ error: "The last profile cannot be deleted." });
  const at = profiles.findIndex((p) => p.id === pid);
  if (at === -1) return res.status(404).json({ error: "No such profile." });
  profiles.splice(at, 1);
  save("profiles", profiles);

  // drop that profile's study data
  chats = chats.filter((c) => c.profileId !== pid);
  quizzes = quizzes.filter((q) => q.profileId !== pid);
  presentations = presentations.filter((p) => p.profileId !== pid);
  flashcards = flashcards.filter((d) => d.profileId !== pid);
  for (const st of students.filter((s) => s.profileId === pid)) {
    if (!safeId(st.id)) continue;
    try {
      fs.rmSync(path.join(SHEETS_DIR, `${st.id}.json`), { force: true });
    } catch { /* best effort */ }
  }
  students = students.filter((s) => s.profileId !== pid);
  delete progressStore.byProfile[pid];
  save("chats", chats);
  save("quizzes", quizzes);
  save("presentations", presentations);
  save("flashcards", flashcards);
  save("students", students);
  saveProgress();

  if (!profiles.some((p) => p.id === mySettings().profileId)) {
    const s = mySettings();
    s.profileId = profiles[0].id;
    save("settings", s);
  }
  res.json({ ok: true, current: curProfile() });
});

// ── answer language ─────────────────────────────────────────────────────

route.post("/api/lang", (req, res) => {
  const lang = String(req.body?.lang || "en");
  if (!LANGS[lang]) return res.status(400).json({ error: "Unknown language." });
  const s = mySettings();
  s.lang = lang;
  save("settings", s);
  res.json({ ok: true, lang });
});

// ── flashcards (spaced-repetition review deck) ──────────────────────────

const dueCardsOf = (deck) => deck.cards.filter((c) => (c.due || 0) <= Date.now());

route.get("/api/flashcards", (_req, res) => {
  const pid = curProfile();
  const decks = flashcards
    .filter((d) => !d.profileId || d.profileId === pid)
    .map((d) => ({
      id: d.id,
      docName: d.docName,
      mode: d.mode,
      at: d.at,
      total: d.cards.length,
      due: dueCardsOf(d).length,
    }));
  res.json({ ok: true, decks, dueTotal: decks.reduce((n, d) => n + d.due, 0) });
});

// study payload: due cards across all decks, newest deck first
route.get("/api/flashcards/study", (_req, res) => {
  const pid = curProfile();
  const cards = [];
  for (const deck of [...flashcards].filter((d) => !d.profileId || d.profileId === pid).reverse()) {
    for (const c of dueCardsOf(deck)) {
      cards.push({ deckId: deck.id, cardId: c.id, q: c.q, a: c.a, topic: c.topic, docName: deck.docName });
    }
  }
  res.json({ ok: true, cards: cards.slice(0, 30), dueTotal: cards.length });
});

route.post("/api/flashcards", async (req, res) => {
  const docId = req.body?.docId || null;
  const fromWeak = Boolean(req.body?.fromWeak);
  const count = Math.min(20, Math.max(4, Number(req.body?.count) || 8));
  if (!docId && !fromWeak) return res.status(400).json({ error: "Pick a document or choose weak topics." });

  let material = "";
  let docName = null;
  let focus = "";
  if (docId) {
    const doc = getDoc(docId);
    if (!doc) return res.status(400).json({ error: "No such document." });
    const full = load(`docs/${doc.id}`, doc);
    material = (full.chunks || []).slice(0, 10).join("\n\n").slice(0, 8000);
    docName = doc.name;
  }
  if (fromWeak) {
    const weak = progressSummary().weakTopics;
    if (!weak.length) {
      return res.status(400).json({ error: "No weak topics yet — take a quiz first. (Cards on a document work right away.)" });
    }
    focus = weak.join(", ");
    const found = search(docsForSearch(docId), weak.join("; "), 8);
    if (found.length) material = found.map((s) => s.text).join("\n\n").slice(0, 8000);
  }
  if (!material) material = "(no material — write cards from general knowledge of the topics)";

  const prompt = `Create ${count} flashcards for spaced-repetition review.
Front (q): one clear question. Back (a): a short, complete answer (1-3 sentences).
${fromWeak ? `FOCUS on these weak topics: ${focus}` : "Cover the material evenly, easiest facts first."}
Return STRICT JSON: {"cards":[{"q":"...","a":"...","topic":"2-4 words"}]}
${langInstruction()}
MATERIAL:
${material}`;

  try {
    const raw = await ai.chat(
      [
        { role: "system", content: "You write precise study flashcards. Output JSON only." },
        { role: "user", content: prompt },
      ],
      { temperature: 0.5, json: true }
    );
    const parsed = JSON.parse(raw);
    const cards = (parsed.cards || [])
      .filter((c) => c && c.q && c.a)
      .map((c) => ({
        id: id("c_"),
        q: String(c.q).slice(0, 300),
        a: String(c.a).slice(0, 600),
        topic: String(c.topic || "General").slice(0, 40),
        due: Date.now(), // due immediately
        days: 0, // current interval in days
        reps: 0,
        lapses: 0,
      }));
    if (!cards.length) throw new Error("The model returned no usable cards.");

    const deck = {
      id: id("fc_"),
      profileId: curProfile(),
      docId: docId || null,
      docName: docName || "Weak topics",
      mode: fromWeak ? "weak" : "doc",
      cards,
      at: Date.now(),
    };
    flashcards.unshift(deck);
    flashcards = flashcards.slice(0, 20);
    save("flashcards", flashcards);
    res.json({ ok: true, deck });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// review grading — 0 again · 1 hard · 2 good · 3 easy (SM-2 style)
route.post("/api/flashcards/:deckId/review", (req, res) => {
  const pid = curProfile();
  const deck = flashcards.find((d) => d.id === req.params.deckId && (!d.profileId || d.profileId === pid));
  if (!deck) return res.status(404).json({ error: "No such deck." });
  const card = deck.cards.find((c) => c.id === req.body?.cardId);
  if (!card) return res.status(404).json({ error: "No such card." });

  const grade = Math.min(3, Math.max(0, Number(req.body?.grade)));
  if (grade === 0) {
    card.days = 0.007; // ~10 minutes
    card.reps = 0;
    card.lapses += 1;
  } else if (grade === 1) {
    card.days = Math.max(0.5, (card.days || 0) * 1.2);
    card.reps += 1;
  } else {
    card.days = card.days ? card.days * (grade === 3 ? 2.8 : 2.2) : grade === 3 ? 1.5 : 1;
    card.reps += 1;
  }
  card.due = Date.now() + card.days * 86_400_000;
  save("flashcards", flashcards);
  const streak = touchStreak();
  res.json({ ok: true, cardId: card.id, dueAt: card.due, days: card.days, streak });
});

route.delete("/api/flashcards/:id", (req, res) => {
  flashcards = flashcards.filter((d) => d.id !== req.params.id);
  save("flashcards", flashcards);
  res.json({ ok: true });
});

// ── today's revision plan (also feeds the daily reminder) ───────────────

route.get("/api/revision", (_req, res) => {
  const pid = curProfile();
  const due = flashcards
    .filter((d) => !d.profileId || d.profileId === pid)
    .reduce((n, d) => n + dueCardsOf(d).length, 0);
  const { weakTopics, accuracy } = progressSummary();
  res.json({
    ok: true,
    date: new Date().toLocaleDateString("en-CA"),
    dueCards: due,
    weakTopics,
    accuracy,
    goal: due
      ? `Review ${due} flashcard${due === 1 ? "" : "s"}`
      : weakTopics.length
        ? `Take a quiz on ${weakTopics[0]}`
        : "Take a quiz to find your weak spots",
  });
});

// ── backup / restore ────────────────────────────────────────────────────
// Saved copies live in data/backups/ as AiTutor<ddmmyyhhmmss>.json (newest 10 kept).

const BACKUPS_DIR = path.join(DATA_DIR, "backups");
const SAFE_NAME = /^[A-Za-z0-9._-]+\.json$/;

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    p(d.getDate()) + p(d.getMonth() + 1) + String(d.getFullYear()).slice(2) +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  );
}

function buildBackup() {
  const metas = listDocs();
  const docs = {};
  for (const meta of metas) {
    const full = load(`docs/${meta.id}`, null);
    if (full) docs[meta.id] = full;
  }
  return {
    app: "ai-tutor",
    version: 2,
    exportedAt: new Date().toISOString(),
    data: {
      documents: metas,
      docs,
      chats,
      quizzes,
      presentations,
      flashcards,
      students,
      sheets: Object.fromEntries(students.map((s) => [s.id, load(`sheets/${s.id}`, null)].filter(([, v]) => v))),
      progress: progressStore,
      profiles,
      settings: load("settings", {}),
    },
  };
}

function applyRestore(d) {
  // Clear orphaned doc/sheet files from a previous data set before applying.
  for (const dir of [path.join(DATA_DIR, "docs"), path.join(DATA_DIR, "sheets")]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        try { fs.rmSync(path.join(dir, f), { recursive: true, force: true }); } catch { /* best effort */ }
      }
    } catch { /* dir may not exist */ }
  }

  const metas = Array.isArray(d.documents) ? d.documents : [];
  const docs = d.docs && typeof d.docs === "object" ? d.docs : {};
  for (const full of Object.values(docs)) {
    if (full && full.id && safeId(full.id)) save(`docs/${full.id}`, full);
  }
  saveDocs(metas.filter((m) => m && safeId(m.id)));

  chats = Array.isArray(d.chats) ? d.chats : [];
  save("chats", chats);
  quizzes = Array.isArray(d.quizzes) ? d.quizzes : [];
  save("quizzes", quizzes);
  presentations = Array.isArray(d.presentations) ? d.presentations : [];
  save("presentations", presentations);
  flashcards = Array.isArray(d.flashcards) ? d.flashcards : [];
  save("flashcards", flashcards);
  students = Array.isArray(d.students) ? d.students : [];
  save("students", students);
  const sheetsIn = d.sheets && typeof d.sheets === "object" ? d.sheets : {};
  for (const [sid, sheet] of Object.entries(sheetsIn)) {
    if (sheet && safeId(sid)) save(`sheets/${sid}`, sheet);
  }

  // profiles — older backups may not have them
  if (Array.isArray(d.profiles) && d.profiles.length) {
    profiles = d.profiles;
    save("profiles", profiles);
  }

  // progress: per-profile shape; old single-profile backups are wrapped
  let ps = d.progress && typeof d.progress === "object" ? d.progress : null;
  if (!ps || typeof ps !== "object" || !ps.byProfile) {
    const legacy = ps && ps.byTopic ? ps : null;
    ps = { byProfile: {} };
    if (legacy) {
      ps.byProfile[profiles[0].id] = {
        ...freshProgress(),
        ...legacy,
        streak: legacy.streak || freshProgress().streak,
      };
    }
  }
  progressStore = ps;
  save("progress", progressStore);

  if (d.settings && typeof d.settings === "object" && d.settings.model) {
    save("settings", d.settings);
  }
  return {
    documents: metas.length,
    chats: chats.length,
    quizzes: quizzes.length,
    presentations: presentations.length,
    flashcards: flashcards.length,
  };
}

// download a backup (+ keep a saved copy on the server with ?save=1)
route.get("/api/backup", (req, res) => {
  const backup = buildBackup();
  if (req.query.save) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const name = `AiTutor${stamp()}.json`;
    fs.writeFileSync(path.join(BACKUPS_DIR, name), JSON.stringify(backup));
    res.setHeader("X-Backup-File", name);
    // prune: keep only the newest 10
    const files = fs
      .readdirSync(BACKUPS_DIR)
      .filter((f) => SAFE_NAME.test(f))
      .map((f) => ({ f, at: fs.statSync(path.join(BACKUPS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    while (files.length > 10) fs.rmSync(path.join(BACKUPS_DIR, files.pop().f), { force: true });
  }
  res.setHeader("Content-Disposition", `attachment; filename="AiTutor${stamp()}.json"`);
  res.json(backup);
});

// saved backups (Settings → Data)
route.get("/api/backups", (_req, res) => {
  try {
    const list = fs
      .readdirSync(BACKUPS_DIR)
      .filter((f) => SAFE_NAME.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(BACKUPS_DIR, f));
        return { file: f, at: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.at - a.at);
    res.json(list);
  } catch {
    res.json([]);
  }
});

// download one saved backup
route.get("/api/backups/:file", (req, res) => {
  const file = req.params.file;
  if (!SAFE_NAME.test(file)) return res.status(400).json({ error: "Bad backup name." });
  try {
    res.setHeader("Content-Disposition", `attachment; filename="${file}"`);
    res.sendFile(path.join(BACKUPS_DIR, file));
  } catch {
    res.status(404).json({ error: "No such backup." });
  }
});

// restore a saved backup by name (one click in Settings)
route.post("/api/backups/restore", (req, res) => {
  const file = String(req.body?.file || "");
  if (!SAFE_NAME.test(file)) return res.status(400).json({ error: "Bad backup name." });
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(BACKUPS_DIR, file), "utf8"));
  } catch {
    return res.status(400).json({ error: "Could not read that backup file." });
  }
  if (!parsed || parsed.app !== "ai-tutor" || !parsed.data || typeof parsed.data !== "object") {
    return res.status(400).json({ error: "That file is not an AI Tutor backup." });
  }
  res.json({ ok: true, counts: applyRestore(parsed.data) });
});

// restore from an uploaded backup file (the frontend sends its JSON)
route.post("/api/restore", (req, res) => {
  const b = req.body;
  if (!b || b.app !== "ai-tutor" || !b.data || typeof b.data !== "object") {
    return res.status(400).json({ error: "That file is not an AI Tutor backup." });
  }
  res.json({ ok: true, counts: applyRestore(b.data) });
});

// ── chat ────────────────────────────────────────────────────────────────

const SYSTEM = `You are a patient, encouraging tutor. Explain clearly, in short paragraphs.
When EXCERPTS from the student's documents are provided, ground your answer in them and cite
them inline like [1], [2] matching the numbered excerpts. If the excerpts do not contain the
answer, say so from the start and answer from general knowledge, clearly marked.
End longer answers with one short follow-up question that checks understanding.`;

// Shared context builder for both chat routes.
function buildChatContext(message, docId) {
  const found = search(docsForSearch(docId), message, 4);
  const pid = curProfile();
  const history = chats
    .filter((c) => (docId ? c.docId === docId : true))
    .filter((c) => !c.profileId || c.profileId === pid)
    .slice(-6)
    .map((c) => ({ role: c.role, content: c.text }));

  const excerptBlock = found.length
    ? found
        .map((s, i) => `[${i + 1}] (from ${s.docName})\n${s.text.slice(0, 1200)}`)
        .join("\n\n---\n\n")
    : "(no document excerpts matched — answer from general knowledge)";

  const prog = progressSummary();
  const context = [
    `Student progress: ${
      prog.accuracy === null
        ? "no quizzes yet"
        : `${prog.accuracy}% correct over ${prog.answered} answers`
    }${prog.weakTopics.length ? `. Struggling with: ${prog.weakTopics.join(", ")}` : ""}.`,
    "",
    "DOCUMENT EXCERPTS:",
    excerptBlock,
  ].join("\n");

  return { found, history, context };
}

function demoAnswerFor(found) {
  return (
    "Demo mode — no AI key is set yet.\n\n" +
    "I did find " + found.length + " relevant passage(s) in your documents" +
    (found.length ? ` (best match: “${found[0].text.slice(0, 80)}…”)` : "") +
    ". Add AI_API_KEY to .env (Gemini has a free tier), restart, and this same question " +
    "gets a real, cited answer."
  );
}

function saveChatPair(docId, message, answer, found) {
  chats.push(
    { id: id("m_"), profileId: curProfile(), docId, role: "user", text: message, at: Date.now() },
    {
      id: id("m_"),
      profileId: curProfile(),
      docId,
      role: "assistant",
      text: answer,
      sources: found.map(({ docId: d, docName, chunkIndex }) => ({ docId: d, docName, chunkIndex })),
      at: Date.now(),
    }
  );
  if (chats.length > 1500) chats = chats.slice(-1200);
  save("chats", chats);
}

route.post("/api/chat", async (req, res) => {
  const message = String(req.body?.message || "").trim().slice(0, 4000);
  const docId = req.body?.docId || null;
  if (!message) return res.status(400).json({ error: "Type a question first." });

  const { found, history, context } = buildChatContext(message, docId);

  if (!ai.configured) {
    return res.json({ ok: true, demo: true, answer: demoAnswerFor(found), sources: found });
  }

  try {
    const answer = await ai.chat(
      [
        { role: "system", content: SYSTEM + langInstruction() },
        { role: "system", content: context },
        ...history,
        { role: "user", content: message },
      ],
      { temperature: 0.4 }
    );

    saveChatPair(docId, message, answer, found);
    res.json({ ok: true, answer, sources: found });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// streaming chat: tokens flow to the browser as the AI writes them
route.post("/api/chat/stream", async (req, res) => {
  const message = String(req.body?.message || "").trim().slice(0, 4000);
  const docId = req.body?.docId || null;
  if (!message) return res.status(400).json({ error: "Type a question first." });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const { found, history, context } = buildChatContext(message, docId);
  send("sources", { sources: found });

  if (!ai.configured) {
    send("delta", { text: demoAnswerFor(found) });
    send("done", {});
    return res.end();
  }

  try {
    const upstream = await fetch(`${ai.provider.base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(ai.provider.apiKey ? { Authorization: `Bearer ${ai.provider.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: ai.currentModel(),
        temperature: 0.4,
        stream: true,
        messages: [
          { role: "system", content: SYSTEM + langInstruction() },
          { role: "system", content: context },
          ...history,
          { role: "user", content: message },
        ],
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const body = await upstream.text().catch(() => "");
      let hint = "";
      if (upstream.status === 429) hint = " — rate limited, wait a moment";
      throw new Error(`AI request failed (${upstream.status}${hint}): ${body.slice(0, 300)}`);
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let full = "";
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            send("delta", { text: delta });
          }
        } catch {
          /* partial line — ignore */
        }
      }
    }

    if (!full.trim()) throw new Error("AI returned an empty response.");

    saveChatPair(docId, message, full, found);
    send("done", {});
    res.end();
  } catch (err) {
    send("error", { error: err.message });
    res.end();
  }
});

// history; ?q= searches inside all of this profile's messages
route.get("/api/chat/history", (req, res) => {
  const docId = req.query.docId || null;
  const q = String(req.query.q || "").trim().toLowerCase();
  const pid = curProfile();
  let out = chats.filter((c) => (docId ? c.docId === docId : true)).filter((c) => !c.profileId || c.profileId === pid);
  if (q) out = out.filter((c) => (c.text || "").toLowerCase().includes(q));
  if (q) {
    // search matches the whole history; return the 40 most recent hits
    const hits = out.slice(-40);
    return res.json({ hits: hits.length, total: out.length, messages: hits });
  }
  res.json(out.slice(-60));
});

route.delete("/api/chat/history", (req, res) => {
  const pid = curProfile();
  chats = chats.filter((c) => c.profileId !== pid);
  save("chats", chats);
  res.json({ ok: true });
});

// ── quiz ────────────────────────────────────────────────────────────────

route.post("/api/quiz", async (req, res) => {
  const docId = req.body?.docId;
  const count = Math.min(10, Math.max(3, Number(req.body?.count) || 5));
  const doc = getDoc(docId);
  if (!doc) return res.status(400).json({ error: "Pick a document to quiz on." });

  const full = load(`docs/${doc.id}`, doc);
  const middle = full.chunks.slice(0, 12).join("\n\n").slice(0, 9000);

  const prompt = `Create a ${count}-question multiple-choice quiz from the material below.
Each question must be answerable from the material alone.
Return STRICT JSON: {"questions":[{"q":"...","options":["a","b","c","d"],"answer":0,"why":"one line","topic":"2-4 words"}]}
${langInstruction()}
MATERIAL:
${middle}`;

  try {
    const raw = await ai.chat(
      [
        { role: "system", content: "You write clean exam-style quizzes. Output JSON only." },
        { role: "user", content: prompt },
      ],
      { temperature: 0.6, json: true }
    );

    const parsed = JSON.parse(raw);
    const questions = (parsed.questions || [])
      .filter((q) => q && q.q && Array.isArray(q.options) && q.options.length >= 2)
      .map((q) => ({
        q: String(q.q),
        options: q.options.map(String).slice(0, 6),
        answer: Number(q.answer) || 0,
        why: String(q.why || ""),
        topic: String(q.topic || topicOf(doc)),
      }));
    if (!questions.length) throw new Error("The model returned no usable questions.");

    const quiz = { id: id("qz_"), profileId: curProfile(), docId: doc.id, docName: doc.name, questions, results: null, at: Date.now() };
    quizzes.unshift(quiz);
    quizzes = quizzes.slice(0, 60);
    save("quizzes", quizzes);
    res.json({ ok: true, quiz });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// quiz from a photo of handwritten notes (OCR → questions)
route.post("/api/quiz/notes", async (req, res) => {
  const dataUrl = String(req.body?.image || "");
  const count = Math.min(10, Math.max(3, Number(req.body?.count) || 5));

  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return res.status(400).json({ error: "Send a photo of the notes (png/jpg)." });
  if (m[2].length > 14 * 1024 * 1024) return res.status(413).json({ error: "Image too large (10 MB max)." });

  const content = [
    {
      type: "text",
      text: `1. Transcribe the handwritten notes in the image (OCR).
2. Write a ${count}-question multiple-choice quiz strictly from what the notes say.
Return STRICT JSON only (no markdown fences):
{"transcript":"...","questions":[{"q":"...","options":["a","b","c","d"],"answer":0,"why":"one line","topic":"2-4 words"}]}
If the notes are too short or unreadable, use "transcript" to say so and return an empty questions array.`,
    },
    { type: "image_url", image_url: { url: dataUrl } },
  ];

  let lastErr = "";
  for (const model of VL_MODELS) {
    try {
      const raw = await ai.chat(
        [
          { role: "system", content: "You transcribe handwriting accurately and write clean exam-style quizzes. Output JSON only." + langInstruction() },
          { role: "user", content },
        ],
        { temperature: 0.5, model }
      );
      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
      const questions = (parsed.questions || [])
        .filter((q) => q && q.q && Array.isArray(q.options) && q.options.length >= 2)
        .map((q) => ({
          q: String(q.q),
          options: q.options.map(String).slice(0, 6),
          answer: Number(q.answer) || 0,
          why: String(q.why || ""),
          topic: String(q.topic || "Notes"),
        }));
      if (!questions.length) throw new Error("Could not read enough from the photo to write questions.");

      const quiz = {
        id: id("qz_"),
        profileId: curProfile(),
        docId: null,
        docName: "Handwritten notes (photo)",
        questions,
        results: null,
        at: Date.now(),
        transcript: String(parsed.transcript || "").slice(0, 4000),
      };
      quizzes.unshift(quiz);
      quizzes = quizzes.slice(0, 60);
      save("quizzes", quizzes);
      return res.json({ ok: true, quiz, model });
    } catch (err) {
      lastErr = err.message;
    }
  }
  res.status(errStatus(lastErr) || 502).json({ error: lastErr });
});

route.post("/api/quiz/:id/answer", (req, res) => {
  const pid = curProfile();
  const quiz = quizzes.find((q) => q.id === req.params.id && (!q.profileId || q.profileId === pid));
  if (!quiz) return res.status(404).json({ error: "No such quiz." });
  if (quiz.results) return res.status(409).json({ error: "This quiz was already answered." });

  const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
  const perTopic = {};
  let correct = 0;

  const results = quiz.questions.map((q, i) => {
    const picked = Number(answers[i]);
    const ok = picked === q.answer;
    if (ok) correct += 1;
    const t = q.topic || "General";
    perTopic[t] = perTopic[t] || { answered: 0, correct: 0 };
    perTopic[t].answered += 1;
    if (ok) perTopic[t].correct += 1;
    return { picked, ok };
  });

  const progress = myProgress();
  progress.answered += quiz.questions.length;
  progress.correct += correct;
  for (const [topic, s] of Object.entries(perTopic)) {
    progress.byTopic[topic] = progress.byTopic[topic] || { answered: 0, correct: 0 };
    progress.byTopic[topic].answered += s.answered;
    progress.byTopic[topic].correct += s.correct;
  }
  progress.sessions.unshift({
    at: Date.now(),
    docName: quiz.docName,
    correct,
    total: quiz.questions.length,
  });
  progress.sessions = progress.sessions.slice(0, 30);
  const streak = touchStreak();
  saveProgress();

  quiz.results = { correct, total: quiz.questions.length, answers };
  save("quizzes", quizzes);

  res.json({ ok: true, results, correct, total: quiz.questions.length, why: quiz.questions.map((q) => q.why), streak });
});

route.get("/api/progress", (_req, res) => {
  const p = myProgress();
  res.json({
    ...p,
    accuracy: progressSummary().accuracy,
    profile: profileName(),
    last7: (p.streak.days || []).slice(-7),
  });
});

route.post("/api/progress/reset", (_req, res) => {
  progressStore.byProfile[curProfile()] = freshProgress();
  saveProgress();
  res.json({ ok: true });
});

// ── answer sheet checker (OCR + grading via a vision model) ─────────────
// A photo of a handwritten answer is transcribed and graded against the material.

const VL_MODELS = [
  "nvidia/nemotron-3.5-super-vl:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
];

route.post("/api/check-sheet", async (req, res) => {
  const dataUrl = String(req.body?.image || "");
  const question = String(req.body?.question || "").trim().slice(0, 500);
  const docId = req.body?.docId || null;

  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return res.status(400).json({ error: "Send a photo of the answer sheet (png/jpg)." });
  if (m[2].length > 14 * 1024 * 1024) return res.status(413).json({ error: "Image too large (10 MB max)." });

  let material = "";
  if (docId) {
    const doc = getDoc(docId);
    if (doc) material = (load(`docs/${doc.id}`, doc).chunks || []).slice(0, 8).join("\n\n").slice(0, 6000);
  }

  const prompt = `You are a strict but fair exam grader. The image contains a student's handwritten answer.
1. Transcribe the handwriting exactly as written (OCR).
2. Grade the answer out of 10 against the QUESTION and the MATERIAL below.
3. List what the student got right, and each mistake or missing point.
Return STRICT JSON only (no markdown fences):
{"transcript":"...","score":0,"max":10,"strengths":["..."],"mistakes":["..."],"idealAnswer":"..."}
${question ? `QUESTION: ${question}` : "QUESTION: (infer it from the answer sheet)"}
${material ? `\nMATERIAL:\n${material}` : "\n(No material — grade from general knowledge.)"}`;

  const content = [
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url: dataUrl } },
  ];

  let lastErr = "";
  for (const model of VL_MODELS) {
    try {
      const raw = await ai.chat(
        [
          { role: "system", content: "You transcribe handwriting accurately and grade answers. Output JSON only." },
          { role: "user", content },
        ],
        { temperature: 0.2, model }
      );
      const cleaned = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (typeof parsed.transcript !== "string") throw new Error("No transcript in response.");
      return res.json({
        ok: true,
        model,
        transcript: parsed.transcript,
        score: Math.max(0, Math.min(10, Number(parsed.score) || 0)),
        max: 10,
        strengths: (Array.isArray(parsed.strengths) ? parsed.strengths : []).map(String).slice(0, 6),
        mistakes: (Array.isArray(parsed.mistakes) ? parsed.mistakes : []).map(String).slice(0, 8),
        idealAnswer: String(parsed.idealAnswer || ""),
      });
    } catch (err) {
      lastErr = err.message;
    }
  }
  res.status(errStatus(lastErr) || 502).json({ error: lastErr });
});

function errStatus(msg) {
  if (/429/.test(msg)) return 429;
  if (/401|403/.test(msg)) return 401;
  return null;
}

// ── class marking (roster + handwritten answer sheets) ──────────────────
// The teacher adds students with any number of scanned sheet pages. Each page
// is transcribed (OCR via the vision-model chain, cached per page), then the
// combined transcript is graded question-by-question from the AI's own
// knowledge — no answer key required.

const SHEETS_DIR = path.join(DATA_DIR, "sheets");
const saveStudents = () => save("students", students);
const loadSheet = (sid) => load(`sheets/${sid}`, { pages: [] });

// Simple concurrency cap for OCR/vision calls.
let ocrInflight = 0;
const OCR_MAX = 2;
async function ocrSlot(fn) {
  while (ocrInflight >= OCR_MAX) await new Promise((r) => setTimeout(r, 50));
  ocrInflight++;
  try { return await fn(); } finally { ocrInflight--; }
}

function publicStudent(s) {
  // transcripts ride along so the UI can show what the AI actually read
  const sheet = loadSheet(s.id);
  return {
    id: s.id,
    name: s.name,
    pages: s.pages,
    result: s.result || null,
    gradedAt: s.gradedAt || null,
    at: s.at,
    transcripts: sheet.pages.map((p) => String(p.transcript || "").slice(0, 4000)),
  };
}

async function ocrPage(dataUrl, instruction) {
  const content = [
    { type: "text", text: instruction },
    { type: "image_url", image_url: { url: dataUrl } },
  ];
  let lastErr = "";
  for (const model of VL_MODELS) {
    try {
      const raw = await ai.chat(
        [
          { role: "system", content: "You transcribe handwriting accurately. Output text only." },
          { role: "user", content },
        ],
        { temperature: 0.1, model }
      );
      if (!raw || raw.replace(/\s/g, "").length < 8) throw new Error("Empty transcription.");
      return raw.trim();
    } catch (err) {
      lastErr = err.message;
    }
  }
  throw new Error(lastErr || "OCR failed.");
}

route.get("/api/marking", (_req, res) => {
  const pid = curProfile();
  res.json({ students: students.filter((s) => s.profileId === pid).map(publicStudent) });
});

route.post("/api/marking", (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 60);
  const incoming = Array.isArray(req.body?.pages) ? req.body.pages : [];
  if (!name) return res.status(400).json({ error: "Give the student a name." });

  const pages = [];
  for (const p of incoming) {
    const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(p || ""));
    if (m && m[2].length <= 14 * 1024 * 1024) pages.push({ image: m[0], transcript: "" });
  }
  if (!pages.length)
    return res.status(400).json({ error: "Attach at least one readable photo (png/jpg/webp, 10 MB max)." });

  const st = { id: id("st"), profileId: curProfile(), name, pages: pages.length, result: null, gradedAt: null, at: Date.now() };
  students.push(st);
  saveStudents();
  save(`sheets/${st.id}`, { pages });
  res.json({ ok: true, student: publicStudent(st) });
});

route.delete("/api/marking/:id", (req, res) => {
  const at = students.findIndex((s) => s.id === req.params.id && s.profileId === curProfile());
  if (at === -1) return res.status(404).json({ error: "No such student." });
  const [gone] = students.splice(at, 1);
  saveStudents();
  if (safeId(gone.id)) {
    try {
      fs.rmSync(path.join(SHEETS_DIR, `${gone.id}.json`), { force: true });
    } catch { /* best effort */ }
  }
  res.json({ ok: true });
});

// transcribe one page of a student's sheet (cached — repeat calls are instant)
route.post("/api/marking/:id/ocr", async (req, res) => {
  const st = students.find((s) => s.id === req.params.id && s.profileId === curProfile());
  if (!st) return res.status(404).json({ error: "No such student." });
  const sheet = loadSheet(st.id);
  const index = Math.max(0, Number(req.body?.index) || 0);
  const page = sheet.pages[index];
  if (!page) return res.status(400).json({ error: "No such page." });

  if (!page.transcript) {
    try {
      page.transcript = await ocrSlot(() => ocrPage(
        page.image,
        "Transcribe this handwritten answer-sheet page exactly as written, line by line. Keep the question numbers the student used. Output only the transcription."
      ));
      save(`sheets/${st.id}`, sheet);
    } catch (err) {
      return res.status(502).json({ error: `OCR failed on page ${index + 1}: ${err.message}` });
    }
  }
  res.json({ ok: true, index, transcript: page.transcript });
});

// grade the whole sheet, question by question
route.post("/api/marking/:id/grade", async (req, res) => {
  const st = students.find((s) => s.id === req.params.id && s.profileId === curProfile());
  if (!st) return res.status(404).json({ error: "No such student." });
  const perQ = Math.max(1, Math.min(100, Number(req.body?.perQ) || 5));
  const sheet = loadSheet(st.id);
  if (!sheet.pages.length) return res.status(400).json({ error: "This student has no sheets attached." });

  // usually the client already transcribed page by page (with progress);
  // this loop is the safety net for pages that were never read
  for (let i = 0; i < sheet.pages.length; i++) {
    if (sheet.pages[i].transcript) continue;
    try {
      sheet.pages[i].transcript = await ocrSlot(() => ocrPage(
        sheet.pages[i].image,
        "Transcribe this handwritten answer-sheet page exactly as written, line by line. Keep the question numbers the student used. Output only the transcription."
      ));
    } catch (err) {
      return res.status(502).json({ error: `OCR failed on page ${i + 1}: ${err.message}` });
    }
    save(`sheets/${st.id}`, sheet);
  }
  const transcript = sheet.pages.map((p) => p.transcript).join("\n\n---\n\n").trim();
  if (!transcript) return res.status(502).json({ error: "The sheets could not be read." });

  const prompt = `You are a strict but fair teacher marking a student's handwritten answer sheet.
Below is the OCR transcription of the sheet. It may contain several numbered questions with the student's answers.
1. Identify each question and the student's answer to it (use the question numbers from the sheet).
2. Grade each answer out of ${perQ} marks using your own subject knowledge. Judge the content, not handwriting or spelling (unless spelling is the subject).
3. Give one line of feedback per question, then overall strengths and mistakes.
Return STRICT JSON only (no markdown fences):
{"questions":[{"q":"the question","answer":"what the student wrote (short)","score":0,"max":${perQ},"feedback":"one line"}],"strengths":["..."],"mistakes":["..."],"summary":"one-line overall comment"}
TRANSCRIPTION:
${transcript.slice(0, 24000)}${langInstruction()}`;

  const raw = await ai.chat(
    [
      { role: "system", content: "You are an exam grader. Output JSON only." },
      { role: "user", content: prompt },
    ],
    { temperature: 0.2, json: true }
  );
  const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  const questions = (Array.isArray(parsed.questions) ? parsed.questions : [])
    .map((q) => ({
      q: String(q.q || "(question)").slice(0, 400),
      answer: String(q.answer || "").slice(0, 800),
      score: Math.max(0, Math.min(perQ, Math.round(Number(q.score) || 0))),
      max: perQ,
      feedback: String(q.feedback || "").slice(0, 400),
    }))
    .slice(0, 30);
  if (!questions.length) throw new Error("No graded questions in the response.");

  st.result = {
    questions,
    total: questions.reduce((n, q) => n + q.score, 0),
    max: questions.length * perQ,
    perQ,
    strengths: (Array.isArray(parsed.strengths) ? parsed.strengths : []).map(String).slice(0, 6),
    mistakes: (Array.isArray(parsed.mistakes) ? parsed.mistakes : []).map(String).slice(0, 8),
    summary: String(parsed.summary || "").slice(0, 500),
  };
  st.gradedAt = Date.now();
  saveStudents();
  res.json({ ok: true, student: publicStudent(st) });
});

// ── static SPA ──────────────────────────────────────────────────────────

app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"] }));
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

// JSON errors instead of HTML stack traces (and no process crashes).
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || err.statusCode || 500).json({ error: err.message || "Server error" });
});

const server = app.listen(PORT, () => {
  const d = ai.describe();
  console.log("");
  console.log(`  AI Tutor  http://localhost:${PORT}`);
  console.log(
    `  provider: ${d.provider} · model: ${d.model} · ${d.configured ? "ready" : "DEMO MODE (no key in .env)"}`
  );
  console.log("");
});

// A second copy is almost always an accident — say so plainly.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("");
    console.error(`  Port ${PORT} is already in use — the tutor is probably already running.`);
    console.error(`  Just open http://localhost:${PORT} in the browser.`);
    console.error("");
    console.error("  To restart it properly:   npm run restart");
    console.error("  To stop the old copy:     npm run stop");
    console.error("  To run a second copy:     set PORT=4344 (then npm start)");
    console.error("");
    process.exit(1);
  }
  throw err;
});
