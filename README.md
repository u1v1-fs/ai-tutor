# AI Tutor

Personal AI tutor — chat with your documents, get quizzed, track progress, with voice.
Node + vanilla JS, no build step. Any OpenAI-compatible provider (Gemini free tier,
Groq, OpenRouter, OpenAI, Ollama…).

## Run

```bash
npm install
copy .env.example .env     # then put an API key in AI_API_KEY
npm start
```

Open <http://localhost:4343>.

With no key it runs in **demo mode**: uploads, retrieval and the UI all work, but chat
answers explain how to add the key instead of asking the model.

## Use it

1. **Add PDF / Word / notes** — text-based PDFs, .docx (Word), .txt or .md. Chunks are indexed locally.
2. **Chat** — answers cite the passages they used. Pick one document in the sidebar or
   leave "Use all documents" checked. **＋ New chat** clears the history and starts fresh.
3. **Quiz me** — pick a document, generate 3–10 MCQs, answer, see explanations. Scores
   land in Progress.
4. **Present** — type a topic (or pick a document) and the AI writes a narrated slide
   deck: an auto-playing presentation with voice narration, play/pause, jump dots and
   fullscreen — like a video lesson. A "Find on YouTube" link is included.
5. **Progress** — accuracy, per-topic breakdown, weak topics (fed back into chat so the
   tutor focuses on them), recent sessions.
6. **Settings (⚙)** — accent colour themes, dark mode, show/hide (logo, model picker,
   sources, footer), speaking voice + speed, and Data tools: **Backup everything**
   (one JSON file with documents, chats, quizzes, presentations and progress),
   **Restore backup**, clear chat, delete all documents, reset progress.
7. **Voice** — toggle in the header; answers are spoken aloud. The 🎤 button takes a
   spoken question (Chrome/Edge).

## Switching providers

In `.env`:

```
AI_PROVIDER=gemini     # gemini | groq | openrouter | openai | github | ollama
AI_API_KEY=...
AI_MODEL=              # empty = provider default
```

Ollama needs no key: `ollama pull llama3.1`, set `AI_PROVIDER=ollama`.

## Activation keys (optional)

Protect the app with a device-bound, single-use key that expires on a set date.

1. In `.env`, set:
   ```
   REQUIRE_ACTIVATION=true
   ACTIVATION_SECRET=some-long-random-string
   ```
2. Restart the server. The app shows an **Activate AI Tutor** screen with the
   device's **Device ID**.
3. Open `tools/keygen.html` **locally in a browser** (do not host it). Enter the
   same secret, paste the Device ID, pick an expiry date, and generate a key.
4. Send the `AK1-…` key to the device. Paste it into the activation screen.

Each key is bound to one Device ID, works once, and stops working after its
expiry date. Used keys are recorded in `data/activation.json`; the Device ID is
stored in `data/device.json`. Back up `data/` if you want to keep the same
Device ID after a reinstall.

## Deploy (Cloudflare Pages + Render)

Frontend on Cloudflare Pages, backend on Render. Data lives on the backend's
persistent disk.

1. Push the repo to GitHub (do **not** commit `.env`, `data/` or `tools/`).
2. **Render** → New Web Service → connect the repo:
   - Build command: `npm install`
   - Start command: `npm start`
   - Add a **persistent disk** mounted at `/var/data`, and set `DATA_DIR=/var/data`
   - Env vars: `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`,
     `CORS_ORIGIN=https://your-project.pages.dev` (plus activation vars if used)
3. **Cloudflare Pages** → Connect to Git:
   - Framework preset: None, build command empty, output directory `public`
4. In `public/config.js` set `PRODUCTION_API_BASE` to the Render URL, commit and push.
5. Open the Pages URL and confirm chat/uploads work.

See `DEPLOY.md` for the full walkthrough and troubleshooting.

## Files

```
server/ai.js      provider presets + chat completion wrapper
server/rag.js     chunking + keyword retrieval (no external services)
server/store.js   JSON file persistence (data/)
server/index.js   HTTP API + static hosting
server/streak.js  pure streak/date helpers
public/           SPA (chat, quiz, progress, voice)
tools/keygen.html offline activation-key generator (keep private)
tests/            node:test unit tests
```

## Notes

- Scanned PDFs have no extractable text — the upload is rejected with an explanation.
- Everything is stored locally under `data/`; nothing leaves the machine except the
  prompts sent to the AI provider you configure.
