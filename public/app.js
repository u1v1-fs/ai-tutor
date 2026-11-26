/* AI Tutor front-end: no framework, no build step. */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  docs: [],
  docId: null, // null = all documents
  voice: localStorage.getItem("voice") === "1",
  quiz: null,
  busy: false,
  pres: null,
  presIndex: 0,
  presPlaying: false,
  presMuted: false,
  presTimer: null,
  sheetImage: null,
  notesImage: null,
  fcStudy: null, // { cards, index }
  markPages: null, // data URLs of the pending student's sheet photos
  markStudents: [], // roster as last rendered
  currTracks: null, // curriculum tracks from the server
  currTrackId: null, // selected track
};

/* ── preferences (saved per browser) ───────────────────────────────────── */

const ACCENTS = [
  { id: "indigo", color: "#4338ca" },
  { id: "violet", color: "#7c3aed" },
  { id: "blue", color: "#2563eb" },
  { id: "emerald", color: "#059669" },
  { id: "rose", color: "#e11d48" },
  { id: "amber", color: "#d97706" },
];

const prefs = (() => {
  const base = {
    accent: "indigo",
    dark: false,
    showLogo: true,
    showModel: true,
    showSources: true,
    showFooter: true,
    showRibbon: true,
    voice: "", // voiceURI; "" = system default
    rate: 1,
  };
  try {
    return Object.assign(base, JSON.parse(localStorage.getItem("prefs") || "{}"));
  } catch {
    return base;
  }
})();

function savePrefs() {
  localStorage.setItem("prefs", JSON.stringify(prefs));
  applyPrefs();
}

function applyPrefs() {
  document.body.dataset.accent = prefs.accent;
  document.body.classList.toggle("dark", prefs.dark);
  document.body.classList.toggle("hide-logo", !prefs.showLogo);
  document.body.classList.toggle("hide-model", !prefs.showModel);
  document.body.classList.toggle("hide-srcs", !prefs.showSources);
  document.body.classList.toggle("hide-foot", !prefs.showFooter);
  document.body.classList.toggle("hide-ribbon", !prefs.showRibbon);
}

/* ── boot ──────────────────────────────────────────────────────────────── */

init();

async function init() {
  applyPrefs();
  paintFooter();
  startBismillah();
  bindTabs();
  bindLibrary();
  bindChat();
  bindQuiz();
  bindSheet();
  bindNotesQuiz();
  bindMarking();
  bindFlashcards();
  bindProgress();
  bindModelPicker();
  bindRefresh();
  bindSettings();
  bindPresent();
  bindRobotics();
  bindActivation();
  updateVoiceButton();
  const act = await checkActivation();
  if (act && act.required && !act.activated) return; // gate is showing
  await Promise.all([loadHealth(), loadDocs(), loadHistory(), loadProgress()]);
  fireDailyReminder();
}

/* ── activation gate ───────────────────────────────────────────────────── */

async function checkActivation() {
  try {
    const st = await fetchJson("/api/activation/status");
    renderLicense(st);
    if (st.required && !st.activated) {
      showActivation(st);
      return st;
    }
    return st;
  } catch {
    return null;
  }
}

function renderLicense(st) {
  const idEl = $("#settingsDeviceId");
  if (!idEl || !st) return;
  idEl.textContent = st.deviceId || "—";
  const hint = $("#licenseHint");
  if (!hint) return;
  if (!st.required) {
    hint.className = "hint";
    hint.textContent = "Activation is not required on this server.";
  } else if (st.activated) {
    const until = st.expiresAt ? new Date(st.expiresAt).toLocaleDateString() : "—";
    hint.className = "hint ok";
    hint.textContent = `Activated · expires ${until} · ${st.daysLeft ?? 0} day(s) left.`;
  } else if (st.expired) {
    hint.className = "hint err";
    hint.textContent = "Activation expired — enter a new key.";
  } else {
    hint.className = "hint err";
    hint.textContent = "Not activated yet.";
  }
}

function showActivation(st) {
  const gate = $("#activationGate");
  if (!gate) return;
  gate.hidden = false;
  $("#deviceId").textContent = st?.deviceId || "—";
  const hint = $("#activationHint");
  if (st?.expired) {
    hint.className = "hint err";
    hint.textContent = "Your activation expired. Enter a new key to continue.";
  }
}

function bindActivation() {
  const copy = $("#copyDevice");
  if (copy) {
    copy.addEventListener("click", async () => {
      const text = $("#deviceId").textContent || "";
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1500);
      } catch {
        toast("Could not copy — select the Device ID manually.", true);
      }
    });
  }

  const copySettings = $("#copySettingsDevice");
  if (copySettings) {
    copySettings.addEventListener("click", async () => {
      const text = $("#settingsDeviceId").textContent || "";
      try {
        await navigator.clipboard.writeText(text);
        copySettings.textContent = "Copied";
        setTimeout(() => (copySettings.textContent = "Copy"), 1500);
      } catch {
        toast("Could not copy — select the Device ID manually.", true);
      }
    });
  }

  const btn = $("#activateBtn");
  if (btn) {
    btn.addEventListener("click", async () => {
      const key = $("#activationKey").value.trim();
      const hint = $("#activationHint");
      if (!key) {
        hint.className = "hint err";
        hint.textContent = "Paste the activation key first.";
        return;
      }
      btn.disabled = true;
      hint.className = "hint";
      hint.textContent = "Checking key…";
      try {
        await fetchJson("/api/activation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key }),
        });
        hint.className = "hint ok";
        hint.textContent = "Activated — reloading…";
        location.reload();
      } catch (err) {
        hint.className = "hint err";
        hint.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });
  }
}
/* ── footer (name is assembled at runtime, not present in the source) ──── */

function paintFooter() {
  // The name is assembled from char codes at runtime, so a plain-text scan
  // of the page source finds nothing.
  const name = [0x48, 0x61, 0x62, 0x69, 0x62].map((c) => String.fromCharCode(c)).join("");
  const el = document.getElementById("foot");
  el.innerHTML = "";
  el.append(
    Object.assign(document.createElement("span"), { className: "hl", textContent: name }),
    document.createTextNode(", Jazak Allahu Khayran")
  );
  el.insertBefore(document.createTextNode("Prepared by "), el.firstChild);
}

/* ── Bismillah ribbon: sprinkling sparks + periodic blast + CSS flash ──── */

function startBismillah() {
  const box = $("#bisParticles");
  if (!box) return;
  const GLYPHS = ["✦", "✧", "❁", "✶", "•"];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const hidden = () => document.hidden || document.body.classList.contains("hide-ribbon");

  // gentle golden dust sprinkling down
  setInterval(() => {
    if (hidden()) return;
    const s = document.createElement("span");
    s.className = "bis-spark";
    s.textContent = GLYPHS[(Math.random() * GLYPHS.length) | 0];
    s.style.left = rnd(2, 98) + "%";
    s.style.top = rnd(-15, 55) + "%";
    s.style.fontSize = rnd(7, 13) + "px";
    s.style.animationDuration = rnd(1.6, 3.4) + "s";
    box.append(s);
    s.addEventListener("animationend", () => s.remove());
  }, 240);

  // an occasional blast of sparks from the middle of the ribbon
  setInterval(() => {
    if (hidden()) return;
    for (let i = 0; i < 16; i++) {
      const s = document.createElement("span");
      s.className = "bis-burst";
      s.textContent = GLYPHS[(Math.random() * GLYPHS.length) | 0];
      const angle = (i / 16) * Math.PI * 2 + rnd(-0.15, 0.15);
      const dist = rnd(36, 84);
      s.style.left = "50%";
      s.style.top = "52%";
      s.style.fontSize = rnd(8, 12) + "px";
      s.style.setProperty("--dx", Math.cos(angle) * dist + "px");
      s.style.setProperty("--dy", Math.sin(angle) * dist * 0.5 + "px"); // flattened for the ribbon
      s.style.animationDuration = rnd(0.7, 1.3) + "s";
      box.append(s);
      s.addEventListener("animationend", () => s.remove());
    }
  }, 5000);
}

/* ── model picker ──────────────────────────────────────────────────────── */

function bindModelPicker() {
  $("#modelSel").addEventListener("change", async (e) => {
    const model = e.target.value;
    if (!model) return;
    try {
      const r = await fetchJson("/api/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      $("#providerPill").textContent = "openrouter · " + r.model.split("/").pop();
      toast("Model: " + r.model);
    } catch (err) {
      toast(err.message, true);
    }
  });
  loadModels();
}

async function loadModels(availability) {
  try {
    const r = await fetchJson("/api/models");
    const sel = $("#modelSel");
    sel.innerHTML = r.models
      .map((m) => {
        const s = availability?.[m];
        const mark = s === "ok" ? " ✓" : s === "limited" ? " ⏳" : s ? " ⛔" : "";
        return `<option value="${esc(m)}"${m === r.current ? " selected" : ""}>${esc(m.replace(":free", " · free"))}${mark}</option>`;
      })
      .join("");
  } catch {
    /* offline */
  }
}

/* ── tabs ──────────────────────────────────────────────────────────────── */

function bindTabs() {
  $$(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      $$(".tab").forEach((t) => t.classList.toggle("on", t === tab));
      $$(".view").forEach((v) => v.classList.toggle("on", v.id === "view-" + tab.dataset.tab));
      if (tab.dataset.tab === "progress") loadProgress();
      if (tab.dataset.tab === "review") loadDecks();
      if (tab.dataset.tab === "marking") loadMarking();
      if (tab.dataset.tab === "library") loadDocs();
    })
  );
}

/* ── health / provider pill ────────────────────────────────────────────── */

async function loadHealth() {
  try {
    const h = await fetchJson("/api/health");
    const pill = $("#providerPill");
    if (h.configured) {
      pill.className = "pill ok";
      pill.textContent = `${h.provider} · ${h.model}`;
      pill.title = h.profile ? `Profile: ${h.profile}` : "";
    } else {
      pill.className = "pill warn";
      pill.textContent = "demo mode — no key";
    }
    if (h.lang) $("#langSel").value = h.lang;
  } catch {
    $("#providerPill").textContent = "server offline";
  }
}

/* ── library ───────────────────────────────────────────────────────────── */

function bindLibrary() {
  $("#fileInput").addEventListener("change", onUpload);
  $("#scopeAll").addEventListener("change", (e) => {
    state.docId = e.target.checked ? null : state.docId;
    renderDocs();
  });
}

async function loadDocs() {
  try {
    const d = await fetchJson("/api/docs");
    state.docs = Array.isArray(d) ? d : [];
  } catch {
    state.docs = [];
  }
  renderDocs();
}

function renderDocs() {
  const ul = $("#docList");
  ul.innerHTML = "";
  for (const d of state.docs) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="name" title="${esc(d.name)}">${esc(d.name)}</span>`;
    if (state.docId === d.id) {
      li.insertAdjacentHTML("beforeend", `<span class="sel">ACTIVE</span>`);
    }
    li.querySelector(".name").addEventListener("click", () => {
      state.docId = state.docId === d.id ? null : d.id;
      $("#scopeAll").checked = state.docId === null;
      renderDocs();
      loadHistory();
    });
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "×";
    del.title = "Delete";
    del.addEventListener("click", () => deleteDoc(d.id));
    li.append(del);
    ul.append(li);
  }

  const sel = $("#quizDoc");
  sel.innerHTML = state.docs.length
    ? state.docs.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("")
    : `<option value="">— add a document first —</option>`;

  const pres = $("#presDoc");
  pres.innerHTML =
    `<option value="">— topic only, no document —</option>` +
    state.docs.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("");

  const fc = $("#fcDoc");
  if (fc) {
    fc.innerHTML =
      `<option value="">— weak topics only —</option>` +
      state.docs.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("");
  }

  renderSummaryCard();
}

/* ── auto-summary card (Library sidebar) ───────────────────────────────── */

function renderSummaryCard() {
  const box = $("#summaryCard");
  if (!box) return;
  const doc = state.docs.find((d) => d.id === state.docId) || state.docs[state.docs.length - 1];
  if (!doc) {
    box.hidden = false;
    box.innerHTML = `<h3>Summary</h3><p class="mini">Add a document on the left, then click it — its summary, key points and terms appear here.</p>`;
    return;
  }
  box.hidden = false;
  if (!doc.summary) {
    // generation is fire-and-forget on the server — poll a few times, then offer a retry
    const tries = Number(box.dataset.tries || 0);
    box.innerHTML =
      `<h3>Summary</h3><p class="mini">Writing a summary of “${esc(doc.name)}”… it will appear here shortly.</p>` +
      (tries >= 6 ? `<button class="bk-btn" id="sumRetry" type="button">↻ Try summary again</button>` : "");
    if (tries < 6) {
      box.dataset.tries = tries + 1;
      setTimeout(() => loadDocs(), 8000);
    }
    box.querySelector("#sumRetry")?.addEventListener("click", async () => {
      box.dataset.tries = 0;
      await fetchJson(`/api/docs/${doc.id}/summary`, { method: "POST" }).catch(() => {});
      loadDocs();
    });
    return;
  }
  box.dataset.tries = 0;
  const s = doc.summary;
  box.innerHTML =
    `<h3>Summary · ${esc(doc.name)}</h3><p>${esc(s.text)}</p>` +
    (s.points?.length
      ? `<b>Key points</b><ul>${s.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`
      : "") +
    (s.terms?.length
      ? `<b>Key terms</b><p class="terms">${s.terms.map((t) => `<span title="${esc(t.def)}">${esc(t.term)}</span>`).join("")}</p>`
      : "");
}

async function onUpload(e) {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;

  const hint = $("#uploadHint");
  hint.className = "hint";
  hint.textContent = `Reading ${file.name}…`;

  const buf = await file.arrayBuffer();
  const b64 = arrayBufferToBase64(buf);
  const mime = /\.pdf$/i.test(file.name)
    ? "application/pdf"
    : /\.docx$/i.test(file.name)
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : /\.md$/i.test(file.name)
        ? "text/markdown"
        : "text/plain";

  try {
    const r = await fetchJson("/api/docs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, data: `data:${mime};base64,${b64}` }),
    });
    hint.className = "hint ok";
    hint.textContent = `${r.doc.name}: ${r.doc.chunkCount} passages indexed.`;
    await loadDocs();
  } catch (err) {
    hint.className = "hint err";
    hint.textContent = err.message;
  }
}

async function deleteDoc(id) {
  if (!confirm("Delete this document?")) return;
  try {
    await fetchJson("/api/docs/" + id, { method: "DELETE" });
    if (state.docId === id) state.docId = null;
    $("#scopeAll").checked = true;
    await loadDocs();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ── chat ──────────────────────────────────────────────────────────────── */

function bindChat() {
  $("#askForm").addEventListener("submit", onAsk);
  $("#voiceBtn").addEventListener("click", toggleVoice);
  $("#micBtn").addEventListener("click", onMic);
  $("#newChat").addEventListener("click", onNewChat);
  $("#spellBtn").addEventListener("click", onSpellFix);

  // search inside chat history (debounced)
  let t = null;
  $("#chatSearch").addEventListener("input", (e) => {
    clearTimeout(t);
    t = setTimeout(() => loadHistory(e.target.value), 300);
  });
}

/** AI-assisted spelling fix for the Ask box (native right-click squiggles are on too). */
async function onSpellFix() {
  const input = $("#askInput");
  const text = input.value.trim();
  if (!text) return;

  const btn = $("#spellBtn");
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const r = await fetchJson("/api/spellcheck", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (r.corrected && r.corrected !== text) {
      input.value = r.corrected;
      input.focus();
      input.setSelectionRange(r.corrected.length, r.corrected.length);
      toast("Fixed: " + r.corrected);
    } else {
      toast("Spelling looks good ✓");
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "✓";
  }
}

async function onNewChat() {
  if (!confirm("Start a new chat? The current history will be cleared.")) return;
  try {
    await fetchJson("/api/chat/history", { method: "DELETE" });
    await loadHistory();
    $("#askInput").focus();
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadHistory(q) {
  try {
    const term = (q ?? $("#chatSearch")?.value ?? "").trim();
    const params = [];
    if (state.docId) params.push("docId=" + encodeURIComponent(state.docId));
    if (term) params.push("q=" + encodeURIComponent(term));
    const r = await fetchJson("/api/chat/history" + (params.length ? "?" + params.join("&") : ""));
    const history = Array.isArray(r) ? r : r.messages || [];
    const log = $("#chatLog");
    log.innerHTML = "";
    for (const m of history) log.append(msgEl(m));
    if (!history.length) {
      log.innerHTML = term
        ? `<div class="empty">No messages match “${esc(term)}”.</div>`
        : `<div class="empty">Upload notes or a PDF, then ask anything about them.<br /><small>Answers cite the passages they came from.</small></div>`;
    }
    log.scrollTop = log.scrollHeight;
  } catch {
    /* offline */
  }
}

async function onAsk(e) {
  e.preventDefault();
  if (state.busy) return;
  const input = $("#askInput");
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  const log = $("#chatLog");
  log.querySelector(".empty")?.remove();
  log.append(msgEl({ role: "user", text }));

  const pending = msgEl({ role: "assistant", text: "", pending: true });
  pending.innerHTML = `<div class="typing">Thinking…</div><div class="progress"><div class="fill"></div></div>`;
  log.append(pending);
  log.scrollTop = log.scrollHeight;

  state.busy = true;
  try {
    const res = await fetch(apiUrl("/api/chat/stream"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, docId: state.docId }),
    });
    if (!res.ok || !res.body) throw new Error("Streaming failed (" + res.status + ")");

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", full = "", sources = null, errMsg = null, streaming = false, event = "message";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith("event:")) { event = t.slice(6).trim(); continue; }
        if (!t.startsWith("data:")) continue;
        let data;
        try { data = JSON.parse(t.slice(5).trim()); } catch { continue; }
        if (event === "sources") sources = data.sources;
        else if (event === "delta") {
          if (!streaming) {
            streaming = true;
            pending.innerHTML = `<span class="txt"></span>`;
          }
          full += data.text;
          pending.querySelector(".txt").textContent = full;
          log.scrollTop = log.scrollHeight;
        } else if (event === "error") errMsg = data.error;
        event = "message";
      }
    }

    pending.remove();
    if (errMsg) throw new Error(errMsg);
    if (!full.trim()) throw new Error("AI returned an empty response.");

    const msg = msgEl({ role: "assistant", text: full, sources });
    log.append(msg);
    log.scrollTop = log.scrollHeight;
    if (state.voice) speak(full);
  } catch (err) {
    // streaming hiccup → fall back to the plain route so the answer still arrives
    pending.remove();
    try {
      const r = await fetchJson("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, docId: state.docId }),
      });
      const msg = msgEl({ role: "assistant", text: r.answer, sources: r.sources, demo: r.demo });
      log.append(msg);
    } catch (err2) {
      log.append(msgEl({ role: "assistant", text: "⚠ " + (err2.message || err.message) }));
    }
    log.scrollTop = log.scrollHeight;
  } finally {
    state.busy = false;
  }
}

function msgEl(m) {
  const div = document.createElement("div");
  div.className = "msg " + (m.role === "user" ? "user" : "bot") + (m.pending ? " pending" : "");
  div.textContent = m.text;
  if (m.sources?.length) {
    const srcs = document.createElement("div");
    srcs.className = "srcs";
    srcs.textContent = "Sources: " + [...new Set(m.sources.map((s) => s.docName))].join(", ");
    div.append(srcs);
  }
  return div;
}

/* ── settings ──────────────────────────────────────────────────────────── */

function bindSettings() {
  $("#settingsBtn").addEventListener("click", openSettings);
  $("#settingsClose").addEventListener("click", closeSettings);
  $("#settingsModal").addEventListener("click", (e) => {
    if (e.target.dataset.close !== undefined) closeSettings();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#settingsModal").hidden) closeSettings();
  });

  const wrap = $("#accentSwatches");
  for (const a of ACCENTS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.dataset.id = a.id;
    b.title = a.id[0].toUpperCase() + a.id.slice(1);
    b.style.background = a.color;
    b.addEventListener("click", () => {
      prefs.accent = a.id;
      savePrefs();
      markSwatch();
    });
    wrap.append(b);
  }
  markSwatch();

  $("#darkMode").addEventListener("change", (e) => { prefs.dark = e.target.checked; savePrefs(); });
  $("#showLogo").addEventListener("change", (e) => { prefs.showLogo = e.target.checked; savePrefs(); });
  $("#showModel").addEventListener("change", (e) => { prefs.showModel = e.target.checked; savePrefs(); });
  $("#showSources").addEventListener("change", (e) => { prefs.showSources = e.target.checked; savePrefs(); });
  $("#showFooter").addEventListener("change", (e) => { prefs.showFooter = e.target.checked; savePrefs(); });
  $("#showRibbon").addEventListener("change", (e) => { prefs.showRibbon = e.target.checked; savePrefs(); });

  // daily revision reminder (browser notification, once per day)
  $("#remindOn").addEventListener("change", async (e) => {
    prefs.remind = e.target.checked;
    savePrefs();
    if (prefs.remind && "Notification" in window && Notification.permission !== "granted") {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
    }
    if (prefs.remind) {
      localStorage.removeItem("lastRemind");
      fireDailyReminder();
      toast("Daily reminder on — we'll nudge you once a day.");
    } else {
      toast("Daily reminder off.");
    }
  });

  // answer language
  $("#langSel").addEventListener("change", async (e) => {
    try {
      await fetchJson("/api/lang", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang: e.target.value }),
      });
      const names = { en: "English", ur: "Urdu", hi: "Hindi" };
      toast("Answers will now be in " + names[e.target.value] + ".");
    } catch (err) {
      toast(err.message, true);
    }
  });

  // profiles
  $("#addProfileBtn").addEventListener("click", async () => {
    const name = $("#newProfileName").value.trim();
    if (!name) return;
    try {
      await fetchJson("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      $("#newProfileName").value = "";
      loadProfiles();
    } catch (err) {
      $("#profileHint").className = "hint err";
      $("#profileHint").textContent = err.message;
    }
  });

  $("#voiceRate").addEventListener("input", (e) => {
    prefs.rate = Number(e.target.value) || 1;
    $("#rateVal").textContent = prefs.rate + "×";
    savePrefs();
  });
  $("#voiceTest").addEventListener("click", () => speak("Voice is ready. Let us begin the lesson."));

  // ── data: backup / restore / cleanup ──────────────────────────────────
  const dataHint = (text, isErr = false) => {
    $("#dataHint").className = "hint" + (isErr ? " err" : " ok");
    $("#dataHint").textContent = text;
  };

  $("#backupBtn").addEventListener("click", async () => {
    try {
      const res = await fetch(apiUrl("/api/backup?save=1")); // also keeps a copy in Settings
      if (!res.ok) throw new Error("Backup failed (" + res.status + ")");
      const name = res.headers.get("X-Backup-File") || `AiTutor${stamp()}.json`;
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
      dataHint(`Saved as ${name} (also downloaded).`);
      loadBackupList();
    } catch (err) {
      dataHint(err.message, true);
    }
  });

  $("#restoreBtn").addEventListener("click", () => $("#restoreInput").click());
  $("#restoreInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      if (!confirm("Restore this backup? Current data will be replaced.")) return;
      const r = await fetchJson("/api/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(backup),
      });
      dataHint(`Restored: ${r.counts.documents} documents, ${r.counts.chats} messages, ${r.counts.quizzes} quizzes. Reloading…`);
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      dataHint(err.message, true);
    }
  });

  $("#clearChatBtn").addEventListener("click", async () => {
    if (!confirm("Clear the entire chat history?")) return;
    await fetchJson("/api/chat/history", { method: "DELETE" });
    await loadHistory();
    dataHint("Chat history cleared.");
  });

  $("#deleteDocsBtn").addEventListener("click", async () => {
    if (!confirm("Delete ALL documents? This cannot be undone (unless you have a backup).")) return;
    const r = await fetchJson("/api/docs", { method: "DELETE" });
    state.docId = null;
    $("#scopeAll").checked = true;
    await loadDocs();
    dataHint(`Deleted ${r.removed} document${r.removed === 1 ? "" : "s"}.`);
  });

  $("#resetProgressBtn").addEventListener("click", async () => {
    if (!confirm("Reset all quiz progress?")) return;
    await fetchJson("/api/progress/reset", { method: "POST" });
    await loadProgress();
    dataHint("Progress reset.");
  });

  if ("speechSynthesis" in window) {
    loadVoices();
    speechSynthesis.addEventListener("voiceschanged", loadVoices);
  }
}

function markSwatch() {
  $$(".swatch").forEach((s) => s.classList.toggle("on", s.dataset.id === prefs.accent));
}

function openSettings() {
  $("#darkMode").checked = prefs.dark;
  $("#showLogo").checked = prefs.showLogo;
  $("#showModel").checked = prefs.showModel;
  $("#showSources").checked = prefs.showSources;
  $("#showFooter").checked = prefs.showFooter;
  $("#showRibbon").checked = prefs.showRibbon;
  $("#remindOn").checked = Boolean(prefs.remind);
  $("#voiceRate").value = prefs.rate;
  $("#rateVal").textContent = prefs.rate + "×";
  loadVoices();
  markSwatch();
  loadProfiles();
  $("#backupList").innerHTML = `<li style="border:0;color:var(--muted)">Loading…</li>`;
  $("#settingsModal").hidden = false;
  loadBackupList();
}

/* ── student profiles ──────────────────────────────────────────────────── */

async function loadProfiles() {
  try {
    const r = await fetchJson("/api/profiles");
    $("#profileList").innerHTML = r.profiles
      .map(
        (p) =>
          `<li class="${p.id === r.current ? "on" : ""}">` +
          `<span class="p-name">👤 ${esc(p.name)}${p.id === r.current ? " <small>(current)</small>" : ""}</span>` +
          `<span class="p-actions">` +
          (p.id === r.current
            ? `<span class="mini">active</span>`
            : `<button class="bk-btn" type="button" data-switch="${esc(p.id)}">Use</button>`) +
          (r.profiles.length > 1 ? `<button class="del" data-delp="${esc(p.id)}" title="Delete profile">×</button>` : "") +
          `</span></li>`
      )
      .join("");

    $$("#profileList [data-switch]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (!confirm("Switch profile? This profile's chats, quizzes and progress will load after a reload.")) return;
        await fetchJson("/api/profiles/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: btn.dataset.switch }),
        });
        location.reload();
      })
    );
    $$("#profileList [data-delp]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this profile and ALL of its data? This cannot be undone.")) return;
        await fetchJson("/api/profiles/" + btn.dataset.delp, { method: "DELETE" });
        loadProfiles();
        $("#profileHint").className = "hint ok";
        $("#profileHint").textContent = "Profile deleted.";
      })
    );
  } catch {
    /* offline */
  }
}

function closeSettings() {
  $("#settingsModal").hidden = true;
  if ("speechSynthesis" in window) speechSynthesis.cancel(); // stop a test mid-sentence
}

function loadVoices() {
  if (!("speechSynthesis" in window)) return;
  const sel = $("#voiceSel");
  const voices = speechSynthesis.getVoices();
  sel.innerHTML =
    `<option value="">System default</option>` +
    voices
      .map(
        (v) =>
          `<option value="${esc(v.voiceURI)}"${v.voiceURI === prefs.voice ? " selected" : ""}>` +
          `${esc(v.name)} (${esc(v.lang)})</option>`
      )
      .join("");
  sel.onchange = (e) => {
    prefs.voice = e.target.value;
    savePrefs();
  };
}

/* ── voice ─────────────────────────────────────────────────────────────── */

function toggleVoice() {
  state.voice = !state.voice;
  localStorage.setItem("voice", state.voice ? "1" : "0");
  updateVoiceButton();
  if (!state.voice) speechSynthesis.cancel();
}

function updateVoiceButton() {
  const b = $("#voiceBtn");
  b.textContent = state.voice ? "🔊 Voice on" : "🔇 Voice off";
  b.classList.toggle("primary", state.voice);
  b.classList.toggle("ghost", !state.voice);
}

function speak(text) {
  if (!("speechSynthesis" in window)) {
    $("#voiceHint").textContent = "This browser cannot speak.";
    return;
  }
  speechSynthesis.cancel();

  // Strip symbols the voice would otherwise read out loud (#, *, -, [1] …).
  const clean = cleanForSpeech(text).slice(0, 600);
  const u = new SpeechSynthesisUtterance(clean);
  u.rate = prefs.rate || 1;
  if (prefs.voice) {
    const v = speechSynthesis.getVoices().find((x) => x.voiceURI === prefs.voice);
    if (v) u.voice = v;
  }
  speechSynthesis.speak(u);
}

/** Markdown / symbol noise -> plain spoken sentences. */
function cleanForSpeech(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")          // code blocks
    .replace(/`([^`]*)`/g, "$1")              // `inline code` -> its text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")  // [label](url) -> label
    .replace(/\[(?:\d+)\]/g, "")              // citations [1]
    .replace(/^#{1,6}\s*/gm, "")              // headings: ##
    .replace(/^\s*[-–—*•]\s+/gm, "")          // bullet dashes
    .replace(/^\s*>\s?/gm, "")                // blockquotes
    .replace(/^---+\s*$/gm, "")               // horizontal rules
    .replace(/\*\*([^*]+)\*\*/g, "$1")        // **bold**
    .replace(/__([^_]+)__/g, "$1")            // __bold__
    .replace(/\*([^*\n]+)\*/g, "$1")          // *italic*
    .replace(/_([^_\n]+)_/g, "$1")            // _italic_
    .replace(/[|~^]+/g, " ")                  // table pipes etc.
    .replace(/(\w)-(\w)/g, "$1 $2")           // light-dependent -> "light dependent"
    .replace(/[-–—]+/g, ", ")                 // dashes -> a spoken pause
    .replace(/\s*#+\s*/g, " ")                // leftover hashes
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, ". ")                 // paragraph break -> sentence gap
    .replace(/\n/g, " ")
    .replace(/\s*,\s*\./g, ".")               // stray ", ."
    .replace(/\.{2,}/g, ".")                  // ".." after a sentence end
    .replace(/\s+\./g, ".")                   // "word ." -> "word."
    .replace(/\s+,/g, ",")
    .trim();
}

function onMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $("#micBtn");
  if (!SR) {
    $("#voiceHint").textContent = "Voice input needs Chrome or Edge.";
    return;
  }
  const rec = new SR();
  rec.lang = "en-IN";
  btn.classList.add("mic-on");
  $("#voiceHint").textContent = "Listening…";
  rec.onresult = (e) => {
    $("#askInput").value = e.results[0][0].transcript;
    $("#voiceHint").textContent = "";
  };
  rec.onend = () => btn.classList.remove("mic-on");
  rec.onerror = () => {
    btn.classList.remove("mic-on");
    $("#voiceHint").textContent = "Could not hear you — try again.";
  };
  rec.start();
}

/* ── progress bars for slow AI tasks ───────────────────────────────────── */

/** Wraps a slow promise with a creeping progress bar + elapsed timer in a hint element. */
function runWithProgress(hintEl, label, expectedMs, task) {
  hintEl.className = "hint";
  hintEl.innerHTML =
    `<span class="p-label">${esc(label)}</span>` +
    `<span class="p-eta">0s</span>` +
    `<div class="progress"><div class="fill"></div></div>`;
  const fill = hintEl.querySelector(".fill");
  const eta = hintEl.querySelector(".p-eta");
  const t0 = Date.now();

  const tick = setInterval(() => {
    const el = Date.now() - t0;
    // climbs quickly to ~60%, then eases toward 92% until the real result lands
    const frac = 1 - Math.exp(-el / (expectedMs * 0.45));
    fill.style.width = Math.min(92, Math.round(frac * 100)) + "%";
    eta.textContent = Math.round(el / 1000) + "s";
  }, 150);

  return task.finally(() => {
    clearInterval(tick);
    fill.style.width = "100%";
  });
}

/* ── quiz ──────────────────────────────────────────────────────────────── */

function bindQuiz() {
  $("#quizForm").addEventListener("submit", onGenerateQuiz);
}

/* ── answer sheet checker (photo → OCR → grade) ────────────────────────── */

function bindSheet() {
  const input = $("#sheetInput");
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      state.sheetImage = reader.result; // data URL
      const hint = $("#sheetHint");
      hint.className = "hint ok";
      hint.textContent = `📷 ${file.name} ready — add the question (optional) and press Grade.`;
    };
    reader.readAsDataURL(file);
  });

  $("#sheetForm").addEventListener("submit", onCheckSheet);
}

async function onCheckSheet(e) {
  e.preventDefault();
  if (state.busy) return;

  const hint = $("#sheetHint");
  const result = $("#sheetResult");
  if (!state.sheetImage) {
    hint.className = "hint err";
    hint.textContent = "Choose a photo of the answer sheet first.";
    return;
  }

  state.busy = true;
  result.innerHTML = "";

  try {
    await runWithProgress(
      hint,
      "Reading handwriting and grading…",
      30000,
      fetchJson("/api/check-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: state.sheetImage,
          question: $("#sheetQuestion").value.trim(),
          docId: state.docId,
        }),
      }).then((r) => {
        hint.className = "hint ok";
        hint.textContent = `Graded with ${r.model.split("/").pop()}.`;
        renderSheetResult(r);
        if (state.voice) speak(`Score ${r.score} out of ${r.max}. ${r.strengths[0] || ""}`);
      })
    );
  } catch (err) {
    hint.className = "hint err";
    hint.textContent = err.message;
  } finally {
    state.busy = false;
  }
}

function renderSheetResult(r) {
  const box = $("#sheetResult");
  const pct = Math.round((r.score / r.max) * 100);
  const face = pct >= 80 ? "🌟" : pct >= 50 ? "👍" : "📚";

  box.innerHTML = `
    <div class="sheet-card">
      <div class="sheet-score">
        <span class="sheet-face">${face}</span>
        <b>${r.score}<small>/${r.max}</small></b>
        <span class="sheet-pct">${pct}%</span>
      </div>
      <div class="sheet-grid">
        <div>
          <h4>✓ What was right</h4>
          <ul>${r.strengths.map((s) => `<li>${esc(s)}</li>`).join("") || "<li class='none'>—</li>"}</ul>
        </div>
        <div>
          <h4>✗ Mistakes / missing</h4>
          <ul>${r.mistakes.map((s) => `<li>${esc(s)}</li>`).join("") || "<li class='none'>—</li>"}</ul>
        </div>
      </div>
      ${r.idealAnswer ? `<h4>💡 Ideal answer</h4><p class="sheet-ideal">${esc(r.idealAnswer)}</p>` : ""}
      <details><summary>What we read from the sheet (OCR transcript)</summary>
        <p class="sheet-transcript">${esc(r.transcript)}</p>
      </details>
    </div>`;
}

/* ── marking: class roster + handwritten answer sheets ─────────────────── */

function bindMarking() {
  $("#markFiles").addEventListener("change", () => {
    const files = [...$("#markFiles").files];
    if (!files.length) return;
    const hint = $("#markHint");
    hint.className = "hint";
    hint.textContent = `Reading ${files.length} photo${files.length > 1 ? "s" : ""}…`;
    Promise.all(files.map(fileToDataUrl)).then((pages) => {
      state.markPages = pages;
      hint.className = "hint ok";
      hint.textContent = `${pages.length} photo${pages.length > 1 ? "s" : ""} ready — name the student and press “Add student”.`;
    });
    $("#markFiles").value = ""; // allow re-picking the same file later
  });

  $("#markForm").addEventListener("submit", onAddStudent);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error(`Could not read ${file.name}`));
    r.readAsDataURL(file);
  });
}

async function onAddStudent(e) {
  e.preventDefault();
  if (state.busy) return;
  const name = $("#markName").value.trim();
  const hint = $("#markHint");
  if (!name) {
    hint.className = "hint err";
    hint.textContent = "Give the student a name first.";
    return;
  }
  if (!state.markPages?.length) {
    hint.className = "hint err";
    hint.textContent = "Attach the photo(s) of their answer sheet.";
    return;
  }

  state.busy = true;
  try {
    await fetchJson("/api/marking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, pages: state.markPages }),
    });
    state.markPages = null;
    $("#markName").value = "";
    hint.className = "hint ok";
    hint.textContent = `${name} added — press “Grade” to read and mark their sheet.`;
    loadMarking();
  } catch (err) {
    hint.className = "hint err";
    hint.textContent = err.message;
  } finally {
    state.busy = false;
  }
}

async function loadMarking() {
  try {
    const r = await fetchJson("/api/marking");
    state.markStudents = r.students;
    renderMarking(r.students);
  } catch {
    /* offline */
  }
}

function renderMarking(students) {
  const box = $("#markList");
  if (!students.length) {
    box.innerHTML = `<li style="border:0;color:var(--muted)">No students yet — add the first one above.</li>`;
    return;
  }
  box.innerHTML = students
    .map(
      (s) => `
    <li class="mark-row" data-id="${esc(s.id)}">
      <div class="mark-head">
        <span class="mark-name">📝 ${esc(s.name)}</span>
        <span class="mini">${s.pages} page${s.pages > 1 ? "s" : ""}</span>
        ${s.result ? `<span class="mark-score">${s.result.total}/${s.result.max}</span>` : `<span class="mini">not graded</span>`}
        <span class="p-actions">
          <button class="bk-btn" data-grade type="button">${s.result ? "↻ Re-grade" : "Grade"}</button>
          ${s.result ? `<button class="bk-btn" data-result type="button">Result</button>` : ""}
          <button class="del" data-del type="button" title="Remove student">×</button>
        </span>
      </div>
      <p class="hint mark-hint"></p>
      <div class="mark-result" hidden></div>
    </li>`
    )
    .join("");

  $$("#markList .mark-row").forEach((row) => {
    const sid = row.dataset.id;
    row.querySelector("[data-grade]").addEventListener("click", () => gradeStudent(row, sid));
    row.querySelector("[data-del]").addEventListener("click", async () => {
      if (!confirm("Remove this student and their sheets?")) return;
      await fetchJson("/api/marking/" + sid, { method: "DELETE" }).catch(() => {});
      loadMarking();
    });
    row.querySelector("[data-result]").addEventListener("click", () => {
      const card = row.querySelector(".mark-result");
      if (card.hidden) {
        renderMarkResult(card, state.markStudents.find((x) => x.id === sid));
        card.hidden = false;
      } else {
        card.hidden = true;
      }
    });
  });
}

async function gradeStudent(row, sid) {
  if (state.busy) return;
  const s = state.markStudents.find((x) => x.id === sid);
  if (!s) return;
  const hint = row.querySelector(".mark-hint");
  const btn = row.querySelector("[data-grade]");
  state.busy = true;
  btn.disabled = true;
  try {
    // 1. OCR page by page (cached on the server → real per-page progress)
    for (let i = 0; i < s.pages; i++) {
      await runWithProgress(
        hint,
        `Reading page ${i + 1} of ${s.pages}…`,
        25000,
        fetchJson(`/api/marking/${sid}/ocr`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ index: i }),
        })
      );
    }
    // 2. mark every question found in the transcript
    const graded = await runWithProgress(
      hint,
      `Marking ${s.name}'s answers…`,
      30000,
      fetchJson(`/api/marking/${sid}/grade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ perQ: Number($("#markPerQ").value) || 5 }),
      })
    );
    const idx = state.markStudents.findIndex((x) => x.id === sid);
    if (idx > -1) state.markStudents[idx] = graded.student;
    hint.className = "hint ok";
    hint.textContent = `Marked: ${graded.student.result.total}/${graded.student.result.max}.`;
    // refresh the chips, then open the result card
    loadMarking();
    $(`#markList .mark-row[data-id="${sid}"] [data-result]`)?.click();
  } catch (err) {
    hint.className = "hint err";
    hint.textContent = err.message;
  } finally {
    state.busy = false;
    btn.disabled = false;
  }
}

function renderMarkResult(card, s) {
  const r = s?.result;
  if (!r) {
    card.innerHTML = `<p class="mini">Not graded yet.</p>`;
    return;
  }
  const pct = Math.round((r.total / Math.max(1, r.max)) * 100);
  const face = pct >= 80 ? "🌟" : pct >= 50 ? "👍" : "📚";
  card.innerHTML = `
    <div class="sheet-card">
      <div class="sheet-score">
        <span class="sheet-face">${face}</span>
        <b>${r.total}<small>/${r.max}</small></b>
        <span class="sheet-pct">${pct}%</span>
      </div>
      ${r.summary ? `<p class="mini">${esc(r.summary)}</p>` : ""}
      <div class="mark-questions">
        ${r.questions
          .map(
            (q, i) => `
        <div class="mark-q">
          <div class="mark-q-head"><b>Q${i + 1}.</b><span>${esc(q.q)}</span><span class="mark-q-marks">${q.score}/${q.max}</span></div>
          ${q.answer ? `<p class="mini">Wrote: ${esc(q.answer)}</p>` : ""}
          ${q.feedback ? `<p class="mark-q-fb">${esc(q.feedback)}</p>` : ""}
        </div>`
          )
          .join("")}
      </div>
      <div class="sheet-grid">
        <div>
          <h4>✓ Strengths</h4>
          <ul>${(r.strengths || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li class='none'>—</li>"}</ul>
        </div>
        <div>
          <h4>✗ Mistakes</h4>
          <ul>${(r.mistakes || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li class='none'>—</li>"}</ul>
        </div>
      </div>
      <details><summary>What the AI read (OCR transcript)</summary>
        ${(s.transcripts || []).map((t, i) => `<p class="sheet-transcript"><b>Page ${i + 1}</b><br/>${esc(t || "(not read yet)")}</p>`).join("")}
      </details>
    </div>`;
}

/* ── quiz from handwritten notes (OCR) ─────────────────────────────────── */

function bindNotesQuiz() {
  $("#notesInput").addEventListener("change", () => {
    const file = $("#notesInput").files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      state.notesImage = reader.result;
      const hint = $("#notesHint");
      hint.className = "hint ok";
      hint.textContent = `📷 ${file.name} ready — press “Make quiz”.`;
    };
    reader.readAsDataURL(file);
  });

  $("#notesForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (state.busy) return;
    const hint = $("#notesHint");
    if (!state.notesImage) {
      hint.className = "hint err";
      hint.textContent = "Choose a photo of the notes first.";
      return;
    }
    state.busy = true;
    try {
      await runWithProgress(
        hint,
        "Reading notes and writing questions…",
        35000,
        fetchJson("/api/quiz/notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image: state.notesImage,
            count: Number($("#notesCount").value),
          }),
        }).then((r) => {
          hint.className = "hint ok";
          hint.textContent = `Quiz made from your notes (read by ${r.model.split("/").pop()}).`;
          state.quiz = r.quiz;
          renderQuiz();
        })
      );
    } catch (err) {
      hint.className = "hint err";
      hint.textContent = err.message;
    } finally {
      state.busy = false;
    }
  });
}

/* ── flashcards (spaced repetition) ────────────────────────────────────── */

function bindFlashcards() {
  $("#fcForm").addEventListener("submit", onGenerateCards);
  document.addEventListener("keydown", (e) => {
    if (!state.fcStudy || $("#view-review").classList.contains("on") === false) return;
    if (e.key === " " && $("#fcStudy .fc-card")) {
      e.preventDefault();
      flipCard();
    }
    if (["1", "2", "3", "4"].includes(e.key)) gradeCard(Number(e.key) - 1);
  });
}

async function onGenerateCards(e) {
  e.preventDefault();
  if (state.busy) return;
  const hint = $("#fcHint");
  const docId = $("#fcDoc").value || null;
  const fromWeak = $("#fcWeak").checked;
  if (!docId && !fromWeak) {
    hint.className = "hint err";
    hint.textContent = "Pick a document, or tick “Focus on weak topics”.";
    return;
  }

  state.busy = true;
  try {
    await runWithProgress(
      hint,
      "Writing flashcards…",
      30000,
      fetchJson("/api/flashcards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId, fromWeak, count: Number($("#fcCount").value) }),
      }).then((r) => {
        hint.className = "hint ok";
        hint.textContent = `${r.deck.cards.length} cards from ${r.deck.docName}. Press a card to flip it.`;
        loadDecks();
        startStudy();
      })
    );
  } catch (err) {
    hint.className = "hint err";
    hint.textContent = err.message;
  } finally {
    state.busy = false;
  }
}

async function loadDecks() {
  try {
    const r = await fetchJson("/api/flashcards");
    $("#deckList").innerHTML =
      r.decks
        .map(
          (d) =>
            `<li><span>🗂 ${esc(d.docName)}${d.mode === "weak" ? " (weak topics)" : ""}</span>` +
            `<span class="ok">${d.due} due</span><span>${d.total} cards</span>` +
            `<button class="del" data-del="${esc(d.id)}" title="Delete deck">×</button></li>`
        )
        .join("") || `<li style="border:0;color:var(--muted)">No decks yet — generate your first set above.</li>`;

    $$("#deckList [data-del]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this deck?")) return;
        await fetchJson("/api/flashcards/" + btn.dataset.del, { method: "DELETE" });
        loadDecks();
        startStudy();
      })
    );

    if (r.dueTotal > 0) startStudy();
    else $("#fcStudy").innerHTML = "";
  } catch {
    /* offline */
  }
}

async function startStudy() {
  try {
    const r = await fetchJson("/api/flashcards/study");
    state.fcStudy = { cards: r.cards, index: 0 };
    if (!r.cards.length) {
      $("#fcStudy").innerHTML = r.dueTotal
        ? `<div class="fc-done">🎉 All caught up — no cards due right now.</div>`
        : "";
      return;
    }
    renderCard();
  } catch {
    /* offline */
  }
}

function renderCard() {
  const s = state.fcStudy;
  const box = $("#fcStudy");
  if (!s || s.index >= s.cards.length) {
    box.innerHTML = `<div class="fc-done">🎉 Session complete — ${s ? s.cards.length : 0} cards reviewed. Come back later!</div>`;
    state.fcStudy = null;
    loadDecks();
    return;
  }
  const c = s.cards[s.index];
  box.innerHTML = `
    <div class="fc-wrap">
      <div class="fc-meta">Card ${s.index + 1} of ${s.cards.length} · ${esc(c.topic)} · ${esc(c.docName)}</div>
      <div class="fc-card" id="fcCard" title="Click to flip">
        <div class="fc-face fc-front"><p>${esc(c.q)}</p></div>
        <div class="fc-face fc-back"><p>${esc(c.a)}</p></div>
      </div>
      <div class="fc-grades" hidden id="fcGrades">
        <button class="btn" type="button" data-g="0">😖 Again</button>
        <button class="btn" type="button" data-g="1">🤔 Hard</button>
        <button class="btn primary" type="button" data-g="2">🙂 Good</button>
        <button class="btn" type="button" data-g="3">😎 Easy</button>
      </div>
      <p class="mini">Click the card to flip · keys 1–4 grade · space flips</p>
    </div>`;

  $("#fcCard").addEventListener("click", flipCard);
  $$("#fcGrades button").forEach((b) => b.addEventListener("click", () => gradeCard(Number(b.dataset.g))));
}

function flipCard() {
  const card = $("#fcCard");
  if (!card) return;
  const flipped = card.classList.toggle("flipped");
  $("#fcGrades").hidden = !flipped;
  if (flipped && state.voice) speak(state.fcStudy.cards[state.fcStudy.index].a);
}

async function gradeCard(grade) {
  const s = state.fcStudy;
  if (!s || !$("#fcCard")?.classList.contains("flipped")) return;
  const c = s.cards[s.index];
  try {
    await fetchJson(`/api/flashcards/${c.deckId}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: c.cardId, grade }),
    });
    s.index += 1;
    renderCard();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ── daily revision reminder ───────────────────────────────────────────── */

async function fireDailyReminder() {
  if (!prefs.remind) return;
  const today = new Date().toLocaleDateString("en-CA");
  if (localStorage.getItem("lastRemind") === today) return;
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      const rev = await fetchJson("/api/revision");
      new Notification("AI Tutor — daily revision", {
        body: `${rev.goal}${rev.weakTopics?.length ? " · Weak: " + rev.weakTopics.join(", ") : ""}`,
      });
      localStorage.setItem("lastRemind", today);
    }
  } catch {
    /* reminders are best-effort */
  }
}

async function onGenerateQuiz(e) {
  e.preventDefault();
  if (state.busy) return;
  const docId = $("#quizDoc").value;
  if (!docId) {
    $("#quizHint").className = "hint err";
    $("#quizHint").textContent = "Add a document first.";
    return;
  }

  const hint = $("#quizHint");
  state.busy = true;

  try {
    await runWithProgress(
      hint,
      "Writing questions…",
      35000,
      fetchJson("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docId, count: Number($("#quizCount").value) }),
      }).then((r) => {
        state.quiz = r.quiz;
        hint.className = "hint ok";
        hint.textContent = `${r.quiz.questions.length} questions from ${r.quiz.docName}.`;
        renderQuiz();
      })
    );
  } catch (err) {
    hint.className = "hint err";
    hint.textContent = err.message;
  } finally {
    state.busy = false;
  }
}

function renderQuiz() {
  const quiz = state.quiz;
  const area = $("#quizArea");
  if (!quiz || quiz.results) {
    if (quiz?.results) area.innerHTML = `<div class="qz"><h3>Score: ${quiz.results.correct}/${quiz.results.total}</h3></div>`;
    return;
  }

  area.innerHTML = "";
  const box = document.createElement("div");
  box.className = "qz";
  box.innerHTML = `<h3>Quiz · ${esc(quiz.docName)}</h3>`;

  quiz.questions.forEach((q, qi) => {
    const qDiv = document.createElement("div");
    qDiv.innerHTML = `<div class="q">${qi + 1}. ${esc(q.q)}</div>`;
    q.options.forEach((opt, oi) => {
      const label = document.createElement("label");
      label.className = "opt";
      label.innerHTML = `<input type="radio" name="q${qi}" value="${oi}" /> <span>${esc(opt)}</span>`;
      qDiv.append(label);
    });
    const why = document.createElement("p");
    why.className = "why";
    why.hidden = true;
    qDiv.append(why);
    box.append(qDiv);
  });

  const submit = document.createElement("button");
  submit.className = "btn primary";
  submit.type = "button";
  submit.textContent = "Submit answers";
  submit.style.marginTop = "14px";
  submit.addEventListener("click", () => onSubmitQuiz(quiz, box));
  box.append(submit);
  area.append(box);
  box.scrollIntoView({ behavior: "smooth" });
}

async function onSubmitQuiz(quiz, box) {
  const answers = quiz.questions.map((_, qi) => {
    const picked = box.querySelector(`input[name="q${qi}"]:checked`);
    return picked ? Number(picked.value) : -1;
  });
  if (answers.some((a) => a === -1)) {
    $("#quizHint").className = "hint err";
    $("#quizHint").textContent = "Answer every question first.";
    return;
  }

  try {
    const r = await fetchJson(`/api/quiz/${quiz.id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    });

    quiz.results = { correct: r.correct, total: r.total };
    quiz.questions.forEach((q, qi) => {
      q.options.forEach((_, oi) => {
        const label = box.querySelectorAll("label.opt")[oi];
        if (oi === q.answer) label.classList.add("ok");
        else if (oi === answers[qi]) label.classList.add("bad");
        label.querySelector("input").disabled = true;
      });
      const why = box.querySelectorAll(".why")[qi];
      why.hidden = false;
      why.textContent = q.why ? "Why: " + q.why : "";
    });

    box.querySelector("button").remove();
    const head = box.querySelector("h3");
    head.textContent = `Score: ${r.correct}/${r.total} ` + (r.correct === r.total ? "🎉" : "— keep going!");

    $("#quizHint").className = "hint ok";
    $("#quizHint").textContent = "Progress updated.";
    if (state.voice) speak(`You scored ${r.correct} out of ${r.total}.`);
    loadProgress();
  } catch (err) {
    $("#quizHint").className = "hint err";
    $("#quizHint").textContent = err.message;
  }
}

/* ── video presentations ───────────────────────────────────────────────── */

function bindPresent() {
  $("#presForm").addEventListener("submit", onGeneratePres);
  loadPresentations();
}

const TRACK_BLURBS = {
  robotics: "Build, program and control robots — from first circuits to ROS2 and capstone projects.",
  "ai-data": "Understand how AI works, use it safely, and turn data into clear insights.",
  "computational-thinking": "Solve problems with algorithms, code, and physical making.",
  "digital-safety": "Protect accounts, devices and privacy; recognise scams and deepfakes.",
  "media-literacy": "Check sources, spot misinformation, and research with evidence.",
  "human-skills": "Think critically, communicate clearly, collaborate and keep learning.",
  "ethics-citizenship": "Make fair, responsible choices as a digital citizen and global citizen.",
  "financial-literacy": "Budget, save, understand debt and plan for long-term financial health.",
  sustainability: "Understand climate, energy and systems — and design sustainable solutions.",
  "health-biotech": "Build health literacy and explore genetics, biotech and medical ethics.",
  "career-navigation": "Discover strengths, build a portfolio and prepare for a changing world of work.",
};

async function bindRobotics() {
  $("#robLessonBtn").addEventListener("click", onRobLesson);
  $("#robQuizBtn").addEventListener("click", onRobQuiz);
  $("#robLevel").addEventListener("change", updateCurriculumTopics);

  try {
    const r = await fetchJson("/api/curriculum");
    state.currTracks = Array.isArray(r.tracks) ? r.tracks : [];
    const menu = $("#trackMenu");
    menu.innerHTML = state.currTracks
      .map(
        (t) =>
          `<button class="track-btn" type="button" data-track="${esc(t.id)}">` +
          `<span class="ico" aria-hidden="true">${t.icon || "📘"}</span>` +
          `<span>${esc(t.name)}</span></button>`
      )
      .join("");
    $$("#trackMenu .track-btn").forEach((b) =>
      b.addEventListener("click", () => selectCurriculumTrack(b.dataset.track))
    );
    const start = state.currTracks.find((t) => t.id === "robotics") || state.currTracks[0];
    if (start) selectCurriculumTrack(start.id);
  } catch (err) {
    $("#robHint").className = "hint err";
    $("#robHint").textContent = err.message;
  }
}

function selectCurriculumTrack(trackId) {
  const track = (state.currTracks || []).find((t) => t.id === trackId);
  if (!track) return;
  state.currTrackId = track.id;
  $$("#trackMenu .track-btn").forEach((b) => b.classList.toggle("on", b.dataset.track === track.id));
  $("#trackTitle").textContent = `${track.icon || ""} ${track.name}`.trim();
  $("#trackBlurb").textContent = TRACK_BLURBS[track.id] || "Pick a level and topic, then generate a lesson or quiz.";
  const levelSel = $("#robLevel");
  levelSel.innerHTML = (track.levels || [])
    .map((l) => `<option value="${esc(l.level)}">${esc(l.level)}</option>`)
    .join("");
  updateCurriculumTopics();
}

function updateCurriculumTopics() {
  const track = (state.currTracks || []).find((t) => t.id === state.currTrackId);
  const entry = (track?.levels || []).find((l) => l.level === $("#robLevel").value);
  $("#robTopic").innerHTML = (entry?.topics || [])
    .map((t) => `<option value="${esc(t)}">${esc(t)}</option>`)
    .join("");
}

function switchView(tab) {
  $$(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === tab));
  $$(".view").forEach((v) => v.classList.toggle("on", v.id === "view-" + tab));
}

async function onRobLesson() {
  if (state.busy) return;
  const trackId = state.currTrackId;
  const level = $("#robLevel").value;
  const topic = $("#robTopic").value;
  const hint = $("#robHint");
  state.busy = true;
  try {
    await runWithProgress(
      hint,
      "Writing lesson…",
      50000,
      fetchJson("/api/curriculum/lesson", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId, level, topic }),
      }).then((r) => {
        hint.className = "hint ok";
        hint.textContent = `${r.presentation.slides.length} slides on “${r.presentation.title}”.`;
        state.pres = r.presentation;
        state.presIndex = 0;
        state.presPlaying = false;
        switchView("present");
        renderPlayer();
        loadPresentations();
      })
    );
  } catch (err) {
    hint.className = "hint err";
    hint.textContent = err.message;
  } finally {
    state.busy = false;
  }
}

async function onRobQuiz() {
  if (state.busy) return;
  const trackId = state.currTrackId;
  const level = $("#robLevel").value;
  const topic = $("#robTopic").value;
  const hint = $("#robHint");
  state.busy = true;
  try {
    await runWithProgress(
      hint,
      "Writing quiz…",
      40000,
      fetchJson("/api/curriculum/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId, level, topic, count: 5 }),
      }).then((r) => {
        hint.className = "hint ok";
        hint.textContent = `${r.quiz.questions.length} questions ready.`;
        state.quiz = r.quiz;
        state.quizIndex = 0;
        state.quizAnswers = [];
        switchView("quiz");
        renderQuiz();
      })
    );
  } catch (err) {
    hint.className = "hint err";
    hint.textContent = err.message;
  } finally {
    state.busy = false;
  }
}

async function onGeneratePres(e) {
  e.preventDefault();
  if (state.busy) return;
  const topic = $("#presTopic").value.trim();
  const docId = $("#presDoc").value || null;
  if (!topic && !docId) {
    $("#presHint").className = "hint err";
    $("#presHint").textContent = "Type a topic or pick a document.";
    return;
  }

  const hint = $("#presHint");
  state.busy = true;

  try {
    await runWithProgress(
      hint,
      "Writing slides…",
      40000,
      fetchJson("/api/present", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, docId }),
      }).then((r) => {
        hint.className = "hint ok";
        hint.textContent = `${r.presentation.slides.length} slides on “${r.presentation.title}”.`;
        state.pres = r.presentation;
        state.presIndex = 0;
        state.presPlaying = false;
        renderPlayer();
        loadPresentations();
      })
    );
  } catch (err) {
    hint.className = "hint err";
    hint.textContent = err.message;
  } finally {
    state.busy = false;
  }
}

async function loadPresentations() {
  try {
    const list = await fetchJson("/api/presentations");
    $("#presList").innerHTML = list
      .slice(0, 8)
      .map(
        (p) =>
          `<li class="pres-item" data-id="${esc(p.id)}"><span>🎬 ${esc(p.title)}</span>` +
          `<span class="ok">${p.slideCount} slides</span>` +
          `<span>${new Date(p.at).toLocaleDateString()}</span></li>`
      )
      .join("") || `<li style="border:0;color:var(--muted)">No presentations yet.</li>`;

    $$("#presList .pres-item").forEach((li) =>
      li.addEventListener("click", async () => {
        try {
          state.pres = await fetchJson("/api/presentations/" + li.dataset.id);
          state.presIndex = 0;
          state.presPlaying = false;
          renderPlayer();
        } catch (err) {
          toast(err.message, true);
        }
      })
    );
  } catch {
    /* offline */
  }
}

function stopNarration() {
  if (state.presTimer) clearTimeout(state.presTimer);
  state.presTimer = null;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

function renderPlayer() {
  const pres = state.pres;
  const stage = $("#stage");
  if (!pres) {
    stage.innerHTML = "";
    return;
  }

  stage.innerHTML = `
    <div class="player" id="player">
      <div class="player-top">
        <b>${esc(pres.title)}</b>
        <a class="btn ghost sm" target="_blank" rel="noopener"
           href="https://www.youtube.com/results?search_query=${encodeURIComponent(pres.topic + " full lesson")}">▶ Find on YouTube</a>
      </div>
      <div class="slide">
        <h3 class="slide-title"></h3>
        <div class="points"></div>
        <p class="narr-caption"></p>
      </div>
      <div class="controls">
        <button class="btn" id="presPrev" type="button">⏮</button>
        <button class="btn" id="presPlay" type="button">▶ Play</button>
        <button class="btn" id="presNext" type="button">⏭</button>
        <button class="btn" id="presMute" type="button">🔊</button>
        <button class="btn" id="presFull" type="button">⛶ Fullscreen</button>
        <span class="slide-count"></span>
        <div class="dots"></div>
      </div>
    </div>`;

  $("#presPrev").addEventListener("click", () => goSlide(state.presIndex - 1));
  $("#presNext").addEventListener("click", () => goSlide(state.presIndex + 1));
  $("#presPlay").addEventListener("click", togglePlay);
  $("#presMute").addEventListener("click", () => {
    state.presMuted = !state.presMuted;
    $("#presMute").textContent = state.presMuted ? "🔇" : "🔊";
    if (!state.presMuted && state.presPlaying) showSlide(state.presIndex, true); // re-narrate current
  });
  $("#presFull").addEventListener("click", () => {
    const el = $("#player");
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.();
  });

  const dots = $("#player .dots");
  pres.slides.forEach((_, i) => {
    const d = document.createElement("button");
    d.type = "button";
    d.addEventListener("click", () => goSlide(i));
    dots.append(d);
  });

  goSlide(0);
}

function goSlide(i) {
  stopNarration();
  state.presPlaying = false;
  $("#presPlay").textContent = "▶ Play";
  showSlide(Math.max(0, Math.min(state.pres.slides.length - 1, i)), false);
}

function togglePlay() {
  if (state.presPlaying) {
    stopNarration();
    state.presPlaying = false;
    $("#presPlay").textContent = "▶ Play";
  } else {
    state.presPlaying = true;
    $("#presPlay").textContent = "⏸ Pause";
    showSlide(state.presIndex, true);
  }
}

function showSlide(i, narrate) {
  const pres = state.pres;
  if (!pres) return;
  state.presIndex = i;
  const slide = pres.slides[i];

  $("#player .slide-title").textContent = slide.title;
  $("#player .points").innerHTML = slide.points.map((p) => `<div>${esc(p)}</div>`).join("");
  $("#player .narr-caption").textContent = slide.narration || "";
  $("#player .slide-count").textContent = `${i + 1} / ${pres.slides.length}`;

  $$("#player .dots button").forEach((d, di) => d.classList.toggle("on", di === i));

  if (!narrate) return;

  const done = () => {
    if (!state.presPlaying) return;
    if (i + 1 < pres.slides.length) showSlide(i + 1, true);
    else {
      state.presPlaying = false;
      $("#presPlay").textContent = "▶ Play";
    }
  };

  const text = (slide.narration || slide.title).slice(0, 700);
  if (state.presMuted || !("speechSynthesis" in window)) {
    // silence: advance on an estimated reading pace (~150 wpm)
    const words = text.split(/\s+/).length;
    state.presTimer = setTimeout(done, Math.max(3500, words * 400));
    return;
  }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(cleanForSpeech(text));
  u.rate = prefs.rate || 1;
  if (prefs.voice) {
    const v = speechSynthesis.getVoices().find((x) => x.voiceURI === prefs.voice);
    if (v) u.voice = v;
  }
  u.onend = done;
  u.onerror = done;
  speechSynthesis.speak(u);
}

/* ── progress ──────────────────────────────────────────────────────────── */

function bindProgress() {
  $("#resetProgress").addEventListener("click", async () => {
    if (!confirm("Reset all progress?")) return;
    await fetchJson("/api/progress/reset", { method: "POST" });
    loadProgress();
  });
  $("#exportBtn").addEventListener("click", exportReport);
}

async function loadProgress() {
  try {
    const [p, rev] = await Promise.all([fetchJson("/api/progress"), fetchJson("/api/revision").catch(() => null)]);
    $("#pAcc").textContent = p.accuracy === null ? "—" : p.accuracy + "%";
    $("#pAns").textContent = p.answered;
    $("#pQuiz").textContent = p.sessions.length;
    $("#pStreak").textContent = "🔥 " + (p.streak?.count || 0);
    $("#pStreak").title = p.streak?.best ? `Best streak: ${p.streak.best} days` : "Study (quiz or cards) every day to grow the streak";

    const rows = Object.entries(p.byTopic || {})
      .sort((a, b) => b[1].answered - a[1].answered)
      .map(([topic, s]) => {
        const pct = Math.round((s.correct / s.answered) * 100);
        return `<tr><td>${esc(topic)}</td><td>${s.correct}/${s.answered}</td><td>${pct}%</td></tr>`;
      });
    $("#topicTable").innerHTML =
      `<tr><th>Topic</th><th>Score</th><th>Accuracy</th></tr>` +
      (rows.join("") || `<tr><td colspan="3" style="color:var(--muted)">Take a quiz to see topics here.</td></tr>`);

    $("#sessionList").innerHTML = (p.sessions || [])
      .slice(0, 8)
      .map(
        (s) =>
          `<li><span>${esc(s.docName)}</span><span class="ok">${s.correct}/${s.total}</span>` +
          `<span>${new Date(s.at).toLocaleDateString()}</span></li>`
      ).join("") || `<li style="border:0;color:var(--muted)">Nothing yet.</li>`;

    renderBadges(p);
    renderRevision(rev);
  } catch {
    /* offline */
  }
}

/* ── badges + today's revision ─────────────────────────────────────────── */

function renderBadges(p) {
  const got = [];
  const perfect = (p.sessions || []).some((s) => s.total >= 3 && s.correct === s.total);
  const mastered = Object.entries(p.byTopic || {}).some(([, s]) => s.answered >= 5 && s.correct === s.answered);
  if ((p.answered || 0) >= 1) got.push(["🌱", "First quiz"]);
  if ((p.answered || 0) >= 100) got.push(["💯", "100 answers"]);
  if (perfect) got.push(["🎯", "Perfect session"]);
  if (mastered) got.push(["🏆", "Mastered a topic"]);
  if ((p.streak?.count || 0) >= 3) got.push(["🔥", "3-day streak"]);
  if ((p.streak?.count || 0) >= 7) got.push(["⚡", "7-day streak"]);
  if ((p.streak?.count || 0) >= 30) got.push(["👑", "30-day streak"]);
  if ((p.quizzesDone || (p.sessions || []).length) >= 5) got.push(["📚", "Quizzer"]);

  $("#badges").innerHTML =
    got.map(([e, t]) => `<span class="badge" title="${esc(t)}">${e} ${esc(t)}</span>`).join("") ||
    `<span class="mini">Take a quiz to start earning badges.</span>`;
}

function renderRevision(rev) {
  const box = $("#revisionCard");
  if (!rev) {
    box.innerHTML = `<span class="mini">Revision plan unavailable right now.</span>`;
    return;
  }
  box.innerHTML =
    `<b>${esc(rev.goal)}</b>` +
    (rev.weakTopics?.length
      ? `<p class="mini">Weak topics: ${rev.weakTopics.map(esc).join(", ")}</p>`
      : "") +
    `<div class="data-actions">
       <button class="btn ghost" type="button" onclick="document.querySelector('[data-tab=review]').click()">🗂 Review flashcards</button>
       <button class="btn ghost" type="button" onclick="document.querySelector('[data-tab=quiz]').click()">📝 Take a quiz</button>
     </div>`;
}

/* ── printable PDF report ──────────────────────────────────────────────── */

async function exportReport() {
  try {
    const [p, history] = await Promise.all([
      fetchJson("/api/progress"),
      fetchJson("/api/chat/history").catch(() => []),
    ]);
    const msgs = Array.isArray(history) ? history : history.messages || [];
    const when = new Date().toLocaleString();
    const rows = Object.entries(p.byTopic || {})
      .sort((a, b) => b[1].answered - a[1].answered)
      .map(([topic, s]) => `<tr><td>${esc(topic)}</td><td>${s.correct}/${s.answered}</td><td>${Math.round((s.correct / s.answered) * 100)}%</td></tr>`)
      .join("");

    $("#printReport").innerHTML = `
      <div class="rp-head">
        <h1>Study report — ${esc(p.profile || "Student")}</h1>
        <p>AI Tutor · ${esc(when)}</p>
      </div>
      <table class="rp-stats">
        <tr><th>Accuracy</th><th>Answers</th><th>Quizzes</th><th>Day streak</th></tr>
        <tr><td>${p.accuracy === null ? "—" : p.accuracy + "%"}</td><td>${p.answered}</td><td>${p.sessions.length}</td><td>${p.streak?.count || 0} (best ${p.streak?.best || 0})</td></tr>
      </table>
      ${rows ? `<h2>Topics</h2><table class="rp-topics"><tr><th>Topic</th><th>Score</th><th>Accuracy</th></tr>${rows}</table>` : ""}
      ${(p.sessions || []).length ? `<h2>Quiz sessions</h2><ul>${p.sessions.slice(0, 10).map((s) => `<li>${esc(s.docName)} — ${s.correct}/${s.total} (${new Date(s.at).toLocaleDateString()})</li>`).join("")}</ul>` : ""}
      <h2>Chat transcript (recent)</h2>
      ${msgs.slice(-30).map((m) => `<p class="rp-msg"><b>${m.role === "user" ? "Student" : "Tutor"}:</b> ${esc((m.text || "").slice(0, 600))}</p>`).join("") || "<p>No chat yet.</p>"}
      <p class="rp-foot">Generated by AI Tutor — prepared for ${esc(p.profile || "the student")}'s revision.</p>`;

    $("#printReport").hidden = false;
    document.body.classList.add("printing");
    window.print();
  } catch (err) {
    toast(err.message, true);
  } finally {
    document.body.classList.remove("printing");
    $("#printReport").hidden = true;
  }
}

/* ── refresh: which free models are available right now? ───────────────── */

function bindRefresh() {
  $("#refreshBtn").addEventListener("click", onRefreshModels);
}

async function onRefreshModels() {
  const btn = $("#refreshBtn");
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add("spin");
  toast("Checking free models…");
  try {
    await fetchJson("/api/models?refresh=1"); // fresh model list
    const c = await fetchJson("/api/models/check"); // probe each one live
    await loadModels(c.map); // dropdown now shows ✓ / ⏳ markers

    const status = c.map[c.current];
    if (status === "ok") {
      toast(`Current model is working ✓ — ${c.okCount} free models available now`);
    } else if (c.best) {
      const r = await fetchJson("/api/model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: c.best }),
      });
      $("#modelSel").value = r.model;
      $("#providerPill").textContent = "openrouter · " + r.model.split("/").pop();
      toast(`Switched to best available: ${r.model}`);
    } else {
      toast("All free models are rate-limited right now — try again in a minute.", true);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.classList.remove("spin");
  }
}

/* ── saved backups (Settings → Data) ───────────────────────────────────── */

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    p(d.getDate()) + p(d.getMonth() + 1) + String(d.getFullYear()).slice(2) +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  );
}

function loadBackupList() {
  const hint = $("#dataHint");
  fetchJson("/api/backups")
    .then((list) => {
      $("#backupList").innerHTML =
        list
          .map(
            (b) =>
              `<li><span class="bk-name">📦 ${esc(b.file)}</span>` +
              `<span>${new Date(b.at).toLocaleString()}</span>` +
              `<span class="bk-actions">` +
              `<a class="bk-btn" href="/api/backups/${esc(b.file)}" download title="Download">⬇</a>` +
              `<button class="bk-btn restore" type="button" data-file="${esc(b.file)}">Restore</button>` +
              `</span></li>`
          )
          .join("") ||
        `<li style="border:0;color:var(--muted)">No saved backups yet — click “Backup everything”.</li>`;

      $$("#backupList .restore").forEach((btn) =>
        btn.addEventListener("click", async () => {
          if (!confirm(`Restore ${btn.dataset.file}? Current data will be replaced.`)) return;
          try {
            await fetchJson("/api/backups/restore", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ file: btn.dataset.file }),
            });
            hint.className = "hint ok";
            hint.textContent = "Restored. Reloading…";
            setTimeout(() => location.reload(), 1000);
          } catch (err) {
            hint.className = "hint err";
            hint.textContent = err.message;
          }
        })
      );
    })
    .catch(() => {});
}

/* ── utilities ─────────────────────────────────────────────────────────── */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function apiUrl(path) {
  const base = (window.API_BASE || "").replace(/\/+$/, "");
  return base + (path.startsWith("/") ? path : "/" + path);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(apiUrl(url), options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.code === "activation_required") {
      showActivation({ deviceId: data.deviceId, required: true, activated: false, expired: data.expired });
    }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function toast(text, isErr = false) {
  const el = document.createElement("div");
  el.textContent = text;
  el.style.cssText = `position:fixed;bottom:18px;left:50%;transform:translateX(-50%);
    background:${isErr ? "#d92d20" : "#17233d"};color:#fff;padding:10px 18px;border-radius:999px;
    font-size:13px;z-index:99;`;
  document.body.append(el);
  setTimeout(() => el.remove(), 2600);
}
