# AI Tutor — Deploy Guide (Cloudflare Pages + Render)

This is the recommended production setup:

- **Frontend** (the `public/` folder) → **Cloudflare Pages**
- **Backend** (the Node/Express API) → **Render** (Railway works the same way)
- **Data** (`data/` JSON, uploads, sheets, backups) → a **persistent disk** on the backend

Why split it? Cloudflare Pages is an excellent, free static host, but it cannot run
this Node backend (Express + `fs` + PDF/Word parsing + local JSON storage). So Pages
serves the UI and the UI calls the backend directly over HTTPS with CORS.

> ⚠️ Do **not** try to upload the backend to a Cloudflare Worker as-is. Workers have no
> persistent filesystem, so `data/` would be lost. A full Workers port is a rewrite.

---

## 0. What goes into GitHub

Create the repo **inside the `ai-tutor` folder** (the one containing `package.json`),
so `package.json` sits at the repository root.

**Commit these:**

```
package.json
package-lock.json
server/
public/
tests/
scripts/
README.md
DEPLOY.md
AUDIT.md
.env.example
.gitignore
```

**Never commit these:**

```
.env              # your real API key + activation secret
node_modules/     # reinstalled by the host
data/             # your private data (chats, docs, activation, device id)
tools/            # private activation-key generator
*.log
```

The `.gitignore` already excludes all of them. Double-check with:

```powershell
cd "C:\Users\Habib\Documents\ai-tutor\ai-tutor"
git status
```

If `.env`, `data/` or `tools/` show up, do **not** commit.

### Create and push the repo

```powershell
cd "C:\Users\Habib\Documents\ai-tutor\ai-tutor"
git init
git add .
git commit -m "AI Tutor: initial deploy"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/ai-tutor.git
git push -u origin main
```

(Or use GitHub Desktop: **Add local repository** → this folder → **Publish**.)

---

## 1. Deploy the backend on Render

### 1.1 Create the service

1. Sign in at <https://render.com>.
2. **New +** → **Web Service**.
3. Connect your GitHub account and pick the `ai-tutor` repo.
4. Fill in:

| Setting | Value |
|---|---|
| Name | `ai-tutor` (anything) |
| Region | closest to you |
| Branch | `main` |
| Root Directory | *(leave empty — repo root is the app)* |
| Runtime | `Node` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |

5. Choose an instance type. **You need a paid instance** (e.g. Starter) to attach a
   persistent disk. Render's **Free** tier has **no persistent disk** and its filesystem
   is wiped on every deploy/restart — your data would vanish.

### 1.2 Add a persistent disk (critical for data)

1. In the service, open **Disks** → **Add Disk**.
2. **Name:** `data`
3. **Mount Path:** `/var/data`
4. **Size:** 1 GB (grow later if needed).

The app reads its storage location from `DATA_DIR`, so you will point it at this mount
in the next step.

### 1.3 Environment variables

Open **Environment** and add:

| Key | Value |
|---|---|
| `AI_PROVIDER` | `gemini` / `openrouter` / `groq` / `openai` / `github` / `ollama` |
| `AI_API_KEY` | your provider key |
| `AI_MODEL` | provider model, or leave empty for default |
| `DATA_DIR` | `/var/data` |
| `CORS_ORIGIN` | `https://YOUR-PROJECT.pages.dev` (set after step 2) |
| `REQUIRE_ACTIVATION` | `true` or `false` (optional) |
| `ACTIVATION_SECRET` | long random string (only if activation is on) |

Notes:

- **Do not set `PORT`.** Render injects it; the app already reads `process.env.PORT`.
- `CORS_ORIGIN` must be the **exact** origin: `https`, no trailing slash. For a custom
  domain add it too, comma-separated:
  `https://ai-tutor.pages.dev,https://tutor.example.com`
- If you change `CORS_ORIGIN` later, Render redeploys automatically.

Click **Create Web Service** / **Deploy**. Wait for the log to show:

```
AI Tutor  http://localhost:10000
provider: ... · model: ... · ready
```

Copy the public URL, e.g. `https://ai-tutor-xxxx.onrender.com`.

Quick check in a browser:

```
https://ai-tutor-xxxx.onrender.com/api/health
```

You should get JSON with `"ok": true`.

---

## 2. Deploy the frontend on Cloudflare Pages

1. Go to <https://dash.cloudflare.com> → **Workers & Pages** → **Create** →
   **Pages** → **Connect to Git**.
2. Authorize GitHub and select the same `ai-tutor` repo.
3. Build settings:

| Setting | Value |
|---|---|
| Project name | `ai-tutor` (becomes `ai-tutor.pages.dev`) |
| Production branch | `main` |
| Framework preset | `None` |
| Build command | *(leave empty)* |
| Build output directory | `public` |

4. **Save and Deploy.** Pages uploads the `public/` folder as-is (there is no build step).

You'll get `https://ai-tutor.pages.dev` (or similar).

---

## 3. Connect the frontend to the backend

The UI reads its backend URL from `public/config.js`. Open it and set
`PRODUCTION_API_BASE` to your Render URL:

```js
const PRODUCTION_API_BASE = "https://ai-tutor-xxxx.onrender.com";
```

Local development keeps using `http://localhost:4343` automatically.

Commit and push:

```powershell
cd "C:\Users\Habib\Documents\ai-tutor\ai-tutor"
git add public/config.js
git commit -m "Point frontend at Render backend"
git push
```

Pages redeploys automatically. Then make sure Render's `CORS_ORIGIN` equals your Pages
URL exactly (no trailing slash) and redeploy if you changed it.

> If you later change `config.js`, also bump the cache name in `public/sw.js`
> (e.g. `ai-tutor-v7` → `ai-tutor-v8`) so the service worker fetches the new file.

---

## 4. Verify the deployment

Open the Pages URL and check each item:

1. **Header loads, no console errors.**
2. **`/api/health`** on the backend returns `ok: true`.
3. **Upload a small PDF/DOCX/TXT** → it indexes.
4. **Chat** → answers stream and cite the document.
5. **Quiz me** → generates questions; score appears in **Progress**.
6. **Present** → slide deck generates.
7. **Settings → Data → Backup everything** downloads a JSON (confirms storage works).
8. **Activation** (if enabled) → gate appears with a Device ID; a key from
   `tools/keygen.html` activates it.

If everything works, restart the Render service once and confirm your uploaded document
is still there. That proves the persistent disk + `DATA_DIR` are correct.

---

## 5. Migrating your existing local data

`data/` is not in Git, so a fresh deploy starts empty. Two options:

**A. Backup/Restore (easy)**
1. Locally, run the app and use **Settings → Data → Backup everything**.
2. On the hosted app, use **Settings → Data → Restore backup** and pick that file.

**B. Copy the folder (advanced, full fidelity)**
Use Render's **Shell** tab (paid plans) to copy files onto `/var/data`, or `scp`/`rsync`
if you use Railway. Keep the same `device.json` and `activation.json` if you rely on
activation keys.

---

## 6. Activation on a hosted backend — important caveat

The activation system is **device-bound**, where "device" = the **server instance**
(the Device ID lives in `data/device.json`). That means:

- One activation unlocks the **whole deployment**, not each visitor.
- Because `data/` is persistent, the Device ID survives restarts/redeploys.
- If the disk is wiped, a new Device ID is generated and old keys stop matching.
- Per-user licensing would need a different design (accounts + per-user records).

For a personal single-user app this is exactly what you want. For a public
multi-user app, treat activation as a deployment gate, not per-customer licensing.

---

## 7. Updating the app

```powershell
cd "C:\Users\Habib\Documents\ai-tutor\ai-tutor"
# make changes, test locally: npm test
git add .
git commit -m "describe change"
git push
```

Both Render and Pages redeploy from `main` automatically. Render keeps `/var/data`.
After a UI change, hard-refresh (Ctrl+Shift+R) or bump the `sw.js` cache name.

---

## 8. Backups

- **In-app:** Settings → Data → Backup everything (download JSON). Do this regularly.
- **Render disk:** paid plans can snapshot/attach disks; check Render's disk docs.
- **Railway:** volumes are backed by the platform; still keep JSON backups.
- Never rely on the free tier for data — it is ephemeral.

---

## 9. Troubleshooting

**CORS error in the browser console**
- `CORS_ORIGIN` must exactly match the Pages origin: `https`, no trailing slash,
  correct subdomain. Add a custom domain to the comma-separated list.
- Redeploy Render after changing it.

**`403 activation_required`**
- Expected when `REQUIRE_ACTIVATION=true` and the server isn't activated.
- Generate a key in `tools/keygen.html` with the same `ACTIVATION_SECRET`, using the
  Device ID shown in the app, then activate.

**Data disappears after a deploy/restart**
- No persistent disk attached, or `DATA_DIR` doesn't match the disk mount path.
- On Render the mount is `/var/data` and `DATA_DIR=/var/data`.

**First request is very slow / 502**
- Free instances sleep after inactivity and cold-start slowly. Use a paid instance, or
  accept the delay. Large PDFs and streaming chat can also hit timeouts on small plans.

**Mixed content / blocked requests**
- Pages is HTTPS, so the backend must be HTTPS. Render/Railway provide HTTPS URLs; do
  not point `config.js` at `http://`.

**Stale UI after an update**
- Service worker cached the old shell. Hard-refresh, or in DevTools → Application →
  Service Workers → **Unregister**, then reload. Bump `CACHE` in `sw.js` for releases.

**Build fails on Render**
- Commit `package-lock.json`. Ensure Node 20+ (`engines` in `package.json`), or set
  `NODE_VERSION=20` in the environment.

**Frontend loads but API calls go to the Pages domain**
- `PRODUCTION_API_BASE` in `public/config.js` is empty or wasn't redeployed. Set it to
  the Render URL, push, and hard-refresh.

---

## 10. Railway alternative (same idea)

1. **New Project → Deploy from GitHub repo** → pick `ai-tutor`.
2. Railway auto-detects Node and runs `npm install` + `npm start`.
3. **Volumes → Add Volume**, mount at `/data`.
4. Variables: same as Render, but `DATA_DIR=/data`.
5. Railway sets `PORT` automatically. Copy the public domain and use it as
   `PRODUCTION_API_BASE`, then set `CORS_ORIGIN` to the Pages URL.

---

## Other deployment options (brief)

- **Cloudflare Tunnel:** expose a local `npm start` via `cloudflared tunnel --url
  http://localhost:4343`. Fastest for personal use; data stays on your PC.
- **PWA on a phone:** point the phone at the hosted URL → Add to Home screen.
- **Termux (Android):** run the Node backend on the phone itself (no PC/cloud).
- **Electron/Tauri:** package as a desktop app.

None of these replace the Pages + Render setup above for a public, always-on URL.
