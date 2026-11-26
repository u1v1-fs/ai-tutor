// Runtime config for hosting the frontend separately from the backend
// (e.g. Cloudflare Pages). Loaded before app.js.
//
// When the frontend and backend are served together (npm start), leave this
// empty so requests go to the same origin.
//
// When the frontend is hosted on Cloudflare Pages, set PRODUCTION_API_BASE to
// your backend URL. Localhost automatically keeps using the local server.
const PRODUCTION_API_BASE = ""; // e.g. "https://ai-tutor-xxxx.onrender.com"

(function () {
  const isLocal =
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.protocol === "file:";
  window.API_BASE = isLocal ? "" : PRODUCTION_API_BASE;
})();
