/* CPIC Workers on cpic.info: sign-in and data connection for every workers' page.
 *
 * Shepherd, Poster Studio, Sermon Clipper and Photo Desk were first built inside
 * Claude, where they used claude.use("db"), "user", "downloads", "assets" and
 * "sample". This file provides the same things on the website, so the apps
 * themselves stay unchanged:
 *   - sign-in with Netlify Identity (invite only: no public sign-up), shared by
 *     all workers' pages, so one sign-in opens everything
 *   - "db": records, through /.netlify/functions/shepherd-db (Shepherd) or
 *     /.netlify/functions/media-db (Media tools)
 *   - "assets": uploaded files, through /api/files, shown from /_blob/<id>
 *   - "sample": Claude, through /api/ai, once the church adds an AI key
 *   - "downloads": files saved straight to the device
 * Which app this page is comes from <script src="/workers/auth.js" data-app="...">.
 */
(function () {
  "use strict";
  const SCRIPT = document.currentScript;
  const APP = (SCRIPT && SCRIPT.dataset.app) || "shepherd";
  const MEDIA = ["posters", "clipper", "photodesk"].includes(APP);
  const HUB = APP === "hub";
  const EDITS = APP === "edits"; // Shepherd › Edits: changes Ekklesia's sermons, events and links
  const NAMES = { shepherd: "Shepherd", posters: "Poster Studio", clipper: "Sermon Clipper", photodesk: "Photo Desk", hub: "CPIC Workers", edits: "Edits" };
  const TITLE = NAMES[APP] || "CPIC Workers";
  const IDENT = "/.netlify/identity";
  const API = APP === "shepherd" ? "/.netlify/functions/shepherd-db" : "/.netlify/functions/media-db?app=" + APP;
  const KEY = "cpic.shepherd.auth";
  const COLS = APP === "shepherd" ? ["newcomers", "members", "services", "reminders", "settings"] : [];
  const VIRTUAL = ["sermons", "events"]; // fed live from Ekklesia on the Media tools
  const POLL_MS = 30000;

  /* ---------- tokens ---------- */
  let tok = null;
  try { tok = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (_) { tok = null; }
  // The cookie lets <img>/<video> load private files from /_blob/ for signed-in workers.
  function cookie(t) {
    document.cookie = "cpic_at=" + (t ? encodeURIComponent(t.access_token) : "") + "; Path=/; SameSite=Strict" +
      (location.protocol === "https:" ? "; Secure" : "") + "; Max-Age=" + (t ? Math.max(60, Math.floor((t.exp - Date.now()) / 1000)) : 0);
  }
  function keep(t) {
    tok = t;
    try { t ? localStorage.setItem(KEY, JSON.stringify(t)) : localStorage.removeItem(KEY); } catch (_) {}
    cookie(t);
  }
  function fromResponse(j) {
    return { access_token: j.access_token, refresh_token: j.refresh_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  }
  async function form(path, params) {
    const r = await fetch(IDENT + path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error_description || j.msg || j.error || "Sign-in failed"), { status: r.status });
    return j;
  }
  async function jpost(path, body, bearer, method) {
    const h = { "Content-Type": "application/json" };
    if (bearer) h.Authorization = "Bearer " + bearer;
    const r = await fetch(IDENT + path, { method: method || "POST", headers: h, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error_description || j.msg || j.error || "Request failed"), { status: r.status });
    return j;
  }
  async function refresh() {
    if (!tok || !tok.refresh_token) throw Object.assign(new Error("signin"), { code: "revoked" });
    try { keep(fromResponse(await form("/token", { grant_type: "refresh_token", refresh_token: tok.refresh_token }))); }
    catch (e) { keep(null); throw Object.assign(new Error("signin"), { code: "revoked" }); }
  }
  async function accessToken() {
    if (!tok) throw Object.assign(new Error("signin"), { code: "revoked" });
    if (Date.now() > tok.exp - 60000) await refresh();
    return tok.access_token;
  }
  async function currentUser() {
    const t = await accessToken();
    const r = await fetch(IDENT + "/user", { headers: { Authorization: "Bearer " + t } });
    if (!r.ok) { keep(null); throw Object.assign(new Error("signin"), { code: "revoked" }); }
    return r.json();
  }

  /* ---------- links from invite and reset emails ---------- */
  // Netlify's emails link to cpic.info/#invite_token=... (the home page sends
  // those links here). Read the token now and clear it, before Shepherd's own
  // page routing uses the address bar.
  let pending = null;
  (function readHash() {
    const h = location.hash.replace(/^#\/?/, "");
    const m = h.match(/^(invite_token|recovery_token|confirmation_token)=([^&]+)/);
    const err = h.match(/(?:^|&)error_description=([^&]+)/);
    if (m) pending = { kind: m[1], token: decodeURIComponent(m[2]) };
    else if (err) pending = { kind: "error", msg: decodeURIComponent(err[1].replace(/\+/g, " ")) };
    if (m || err) history.replaceState(null, "", location.pathname + location.search);
  })();

  /* ---------- sign-in screen ---------- */
  const LOGO = () => { const l = document.querySelector("header .logo"); return l ? l.getAttribute("src") : "/icon-192.png"; };
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let gate = null, mode = "signin", note = "", busy = false, lastEmail = "";

  function css() {
    if (document.getElementById("gateCss")) return;
    const st = document.createElement("style"); st.id = "gateCss";
    st.textContent = `
/* CPIC Workers colours, light and navy, switching with the device's dark mode like Ekklesia */
:root{--cw-bg:#F3F4F8;--cw-surface:#FFFFFF;--cw-surface-2:#EBEDF4;--cw-ink:#141833;--cw-muted:#5D6382;--cw-line:#DCDFEA;--cw-accent:#1F2A7A;--cw-accent-ink:#FFFFFF;--cw-accent-soft:#E4E7F6;--cw-ok:#0E7C53;--cw-ok-soft:#DDF3E9;--cw-bad:#B42335;--cw-bad-soft:#F8DFE2}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--cw-bg:#0F1122;--cw-surface:#181B30;--cw-surface-2:#22263F;--cw-ink:#ECEEF8;--cw-muted:#9EA3C0;--cw-line:#2D3150;--cw-accent:#8C9CFF;--cw-accent-ink:#0F1122;--cw-accent-soft:#232A55;--cw-ok:#4CC995;--cw-ok-soft:#12352A;--cw-bad:#F27C8A;--cw-bad-soft:#3D1A21}}
:root[data-theme="dark"]{--cw-bg:#0F1122;--cw-surface:#181B30;--cw-surface-2:#22263F;--cw-ink:#ECEEF8;--cw-muted:#9EA3C0;--cw-line:#2D3150;--cw-accent:#8C9CFF;--cw-accent-ink:#0F1122;--cw-accent-soft:#232A55;--cw-ok:#4CC995;--cw-ok-soft:#12352A;--cw-bad:#F27C8A;--cw-bad-soft:#3D1A21}
#gate[hidden],#importBox[hidden]{display:none!important}
#gate{color:var(--cw-ink);position:fixed;inset:0;z-index:60;background:var(--cw-bg);overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:max(28px,env(safe-area-inset-top,0px)) 16px 40px}
#gate .card{width:100%;max-width:420px;background:var(--cw-surface);border:1px solid var(--cw-line);border-radius:16px;padding:24px 20px;display:flex;flex-direction:column;gap:14px;margin-top:6vh}
#gate .head{display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}
#gate .head img{height:46px;width:auto;background:#fff;border-radius:8px;padding:3px 6px;border:1px solid var(--cw-line)}
#gate h2{margin:0;font-family:var(--f-display,system-ui);font-size:22px}
#gate p{margin:0}
#gate .msg{border-radius:10px;padding:10px 12px;font-size:14px;background:var(--cw-accent-soft)}
#gate .msg.bad{background:var(--cw-bad-soft);color:var(--cw-bad)}
#gate .msg.ok{background:var(--cw-ok-soft);color:var(--cw-ok)}
#gate input[type=email],#gate input[type=password]{width:100%;border:1px solid var(--cw-line);background:var(--cw-bg);border-radius:10px;padding:10px 12px;min-height:44px;font:inherit;color:inherit}
#gate .links{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:14px}
#gate .links a,#gate .links button{color:var(--cw-accent);background:none;border:0;padding:0;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
#gate .btn{width:100%;appearance:none;border:1px solid var(--cw-accent);background:var(--cw-accent);color:var(--cw-accent-ink);border-radius:10px;padding:10px 14px;min-height:44px;font:inherit;font-weight:600;font-size:15px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
#gate .btn:hover{filter:brightness(1.08)}
#gate .btn:disabled{opacity:.6;cursor:default}
#gate .field{display:flex;flex-direction:column;gap:6px;min-width:0}
#gate label{font-size:13px;font-weight:600;color:var(--cw-ink)}
#gate form{display:flex;flex-direction:column;gap:14px}
.ws-bar{display:flex;align-items:center;gap:8px}
.ws-bar a,.ws-bar button{font-size:12.5px;font-weight:600;color:var(--cw-accent);background:var(--cw-surface);border:1px solid var(--cw-line);border-radius:8px;padding:4px 9px;cursor:pointer;text-decoration:none;white-space:nowrap;font-family:inherit}
.ws-float{position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:55;background:var(--cw-surface);border:1px solid var(--cw-line);border-radius:12px;padding:6px;box-shadow:0 8px 24px rgba(20,24,51,.15)}
#importBox{max-width:760px;margin:16px auto 0;padding:0 16px;font-family:Inter,system-ui,sans-serif;color:var(--cw-ink)}
#importBox .ib{background:var(--cw-surface);border:2px solid var(--cw-accent);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:10px}
#importBox h3{margin:0;font-size:17px}
#importBox p{margin:0;font-size:13.5px;color:var(--cw-muted)}
#importBox .ibrow{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
#importBox .ibbtn{display:inline-flex;align-items:center;min-height:40px;padding:8px 14px;border-radius:10px;background:var(--cw-accent);color:var(--cw-accent-ink);font-weight:600;font-size:14px;cursor:pointer}`;
    document.head.appendChild(st);
  }

  function showGate(m, n) {
    css(); mode = m || "signin"; note = n || "";
    if (!gate) { gate = document.createElement("div"); gate.id = "gate"; document.body.appendChild(gate); }
    gate.hidden = false; document.body.style.overflow = "hidden";
    drawGate();
  }
  function hideGate() { if (gate) gate.hidden = true; document.body.style.overflow = ""; }

  function drawGate() {
    const msg = note ? `<div class="msg ${/^ok:/.test(note) ? "ok" : /^bad:/.test(note) ? "bad" : ""}">${esc(note.replace(/^(ok|bad):/, ""))}</div>` : "";
    const head = (title, sub) => `<div class="head">${LOGO() ? `<img src="${esc(LOGO())}" alt="CPIC">` : ""}<h2>${title}</h2><p class="muted">${sub}</p></div>`;
    const back = `<div class="links"><a href="/">‹ Back to Ekklesia</a>${mode === "signin" ? `<button type="button" data-g="forgot">Forgot password?</button>` : `<button type="button" data-g="signin">Sign in instead</button>`}</div>`;
    let body = "";
    if (mode === "signin") body = head(esc(TITLE), "For CPIC workers only. Sign in with the email address the church invited.") + msg +
      `<form data-f="signin" class="field" style="gap:12px"><div class="field"><label for="gEmail">Email</label><input type="email" id="gEmail" autocomplete="username" required value="${esc(lastEmail)}"></div>
       <div class="field"><label for="gPass">Password</label><input type="password" id="gPass" autocomplete="current-password" required></div>
       <button class="btn primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Signing in…" : "Sign in"}</button></form>` + back +
      `<p class="small muted">New worker? Open the invitation email from CPIC and tap the link in it to create your password. There’s no public sign-up.</p>`;
    else if (mode === "invite") body = head("Welcome to CPIC Workers", "Create your password to finish setting up your worker account.") + msg +
      `<form data-f="invite" class="field" style="gap:12px"><div class="field"><label for="gNew">New password</label><input type="password" id="gNew" autocomplete="new-password" minlength="8" required><span class="hint">At least 8 characters.</span></div>
       <div class="field"><label for="gNew2">Type it again</label><input type="password" id="gNew2" autocomplete="new-password" minlength="8" required></div>
       <button class="btn primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Saving…" : "Create password and sign in"}</button></form>` + back;
    else if (mode === "recovery") body = head("Choose a new password", "You opened a password reset link.") + msg +
      `<form data-f="recovery" class="field" style="gap:12px"><div class="field"><label for="gNew">New password</label><input type="password" id="gNew" autocomplete="new-password" minlength="8" required><span class="hint">At least 8 characters.</span></div>
       <div class="field"><label for="gNew2">Type it again</label><input type="password" id="gNew2" autocomplete="new-password" minlength="8" required></div>
       <button class="btn primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Saving…" : "Save password and sign in"}</button></form>` + back;
    else if (mode === "forgot") body = head("Reset your password", "We’ll email you a link to choose a new password.") + msg +
      `<form data-f="forgot" class="field" style="gap:12px"><div class="field"><label for="gEmail">Email</label><input type="email" id="gEmail" autocomplete="username" required value="${esc(lastEmail)}"></div>
       <button class="btn primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Sending…" : "Send reset link"}</button></form>` + back;
    else body = head("One moment", "") + msg + back;
    gate.innerHTML = `<div class="card">${body}</div>`;
    const f = gate.querySelector(lastEmail && mode === "signin" ? "#gPass" : "input"); if (f && !busy) setTimeout(() => f.focus(), 0);
  }

  function friendly(e) {
    const m = String(e && e.message || "");
    if (/invalid_grant|No user found|Invalid Password|invalid login/i.test(m)) return "bad:That email and password don’t match. Check them, or tap “Forgot password?”.";
    if (/Email not confirmed/i.test(m)) return "bad:This email hasn’t been confirmed yet. Open the invitation email and tap its link first.";
    if (/expired|invalid.*token|not found/i.test(m)) return "bad:This link has expired or was already used. Ask Sam to send a new invitation, or use “Forgot password?”.";
    if (e && e.status === 404) return "bad:Worker sign-in isn’t switched on for this site yet. Ask Sam to turn on Identity in Netlify.";
    if (/Failed to fetch|NetworkError|^offline$/i.test(m)) return "bad:No connection. Check your internet and try again.";
    if (/^server:/.test(m)) return "bad:You’re signed in, but " + TITLE + " couldn’t load its records just now. Try again in a minute. If it keeps happening, tell Sam this: " + m.slice(7);
    return "bad:" + (m || "Something went wrong. Try again.");
  }

  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest("#gate [data-g]");
    if (b) { e.preventDefault(); showGate(b.dataset.g); }
  });
  document.addEventListener("submit", async e => {
    const f = e.target; if (!f.closest || !f.closest("#gate")) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (busy) return;
    const kind = f.dataset.f;
    // Read what was typed before the form is redrawn.
    const get = id => (document.getElementById(id) || {}).value || "";
    const val = { email: get("gEmail").trim(), pass: get("gPass"), n1: get("gNew"), n2: get("gNew2") };
    if (val.email) lastEmail = val.email;
    try {
      if ((kind === "invite" || kind === "recovery") && val.n1 !== val.n2) { note = "bad:The two passwords don’t match."; drawGate(); return; }
      busy = true; note = ""; drawGate();
      if (kind === "signin") {
        keep(fromResponse(await form("/token", { grant_type: "password", username: val.email, password: val.pass })));
      } else if (kind === "invite") {
        keep(fromResponse(await jpost("/verify", { token: pending && pending.token, type: "signup", password: val.n1 })));
        pending = null;
      } else if (kind === "recovery") {
        keep(fromResponse(await jpost("/verify", { token: pending && pending.token, type: "recovery" })));
        await jpost("/user", { password: val.n1 }, tok.access_token, "PUT");
        pending = null;
      } else if (kind === "forgot") {
        await jpost("/recover", { email: val.email });
        busy = false; showGate("signin", "ok:If that email belongs to a worker, a reset link is on its way. Check your inbox and spam folder.");
        return;
      }
      busy = false;
      await start();
    } catch (err) { busy = false; note = friendly(err); drawGate(); }
  }, true);

  /* ---------- records ---------- */
  let DATA = null, me = null, pollT = null, startedResolve, ready = new Promise(r => (startedResolve = r));
  const subs = new Set();
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const isPlain = v => v !== null && typeof v === "object" && !Array.isArray(v);
  function deepMerge(t, p) { const o = isPlain(t) ? { ...t } : {}; for (const [k, v] of Object.entries(p || {})) o[k] = isPlain(v) && isPlain(o[k]) ? deepMerge(o[k], v) : v; return o; }
  const newId = () => { const a = new Uint8Array(12); crypto.getRandomValues(a); return Array.from(a, b => ("0" + b.toString(16)).slice(-2)).join(""); };
  const err = (code, msg) => Object.assign(new Error(msg || code), { code });

  async function api(method, body) {
    let t;
    try { t = await accessToken(); } catch (e) { signedOut(); throw e; }
    let r;
    try { r = await fetch(API, { method, cache: "no-store", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); }
    catch (_) { throw err("unavailable", "offline"); }
    if (r.status === 401) { signedOut("bad:Your sign-in has ended. Please sign in again."); throw err("revoked"); }
    if (r.status === 403) { signedOut("bad:This account wasn’t invited by the church, so it can’t open the workers’ pages. Ask Sam to send you an invitation."); throw err("revoked"); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 413) throw err("quota_exceeded");
    if (r.status >= 500) throw err("unavailable", "server:" + (j.detail || j.error || r.status));
    if (!r.ok) throw err("invalid_argument", j.error);
    return j;
  }
  function fire(s) {
    if (!DATA) return;
    try {
      if (s.id == null) {
        const m = DATA[s.col] || {};
        s.cb({ docs: Object.keys(m).map(id => ({ id, exists: true, data: () => clone(m[id]) })), size: Object.keys(m).length, empty: !Object.keys(m).length, metadata: { fromCache: false } });
      } else {
        const v = (DATA[s.col] || {})[s.id];
        s.cb({ id: s.id, exists: v != null, data: () => clone(v), metadata: { fromCache: false } });
      }
    } catch (e) { console.error(e); }
  }
  const emit = () => subs.forEach(fire);
  let EKK = null;
  async function addEkklesia() {
    try {
      if (!EKK) {
        const html = await (await fetch("/", { cache: "no-store" })).text();
        const m = html.match(/<script type="application\/json" id="snapshot">([\s\S]*?)<\/script>/);
        EKK = m ? JSON.parse(m[1]) : {};
        try {
          const live = await (await fetch("/api/site", { cache: "no-store" })).json();
          for (const col of ["sermons", "events"]) {
            const map = new Map((EKK[col] || []).map(x => [x.id, x]));
            for (const x of live[col] || []) { const o = map.get(x.id); if (!o || String(x.updatedAt || "") >= String(o.updatedAt || "")) map.set(x.id, x); }
            for (const [id, at] of Object.entries((live.deleted || {})[col] || {})) { const o = map.get(id); if (o && String(at) >= String(o.updatedAt || "")) map.delete(id); }
            EKK[col] = [...map.values()];
          }
        } catch (_) {}
      }
      for (const [col, list] of [["sermons", EKK.sermons], ["events", EKK.events]]) {
        if (!Array.isArray(list)) continue;
        DATA[col] = DATA[col] || {};
        for (const x of list) { if (!x || !x.id) continue; const { id, ...rest } = x; DATA[col][id] = rest; }
      }
    } catch (_) {}
  }
  async function pull() {
    if (HUB || EDITS) { DATA = {}; return; }
    const j = await api("GET");
    DATA = j.data || {}; for (const c of COLS) DATA[c] = DATA[c] || {};
    if (MEDIA) await addEkklesia();
    emit(); importOffer();
  }
  function poll() {
    clearTimeout(pollT);
    pollT = setTimeout(async () => { if (document.visibilityState === "visible" && tok) { try { await pull(); } catch (_) {} } poll(); }, POLL_MS);
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && tok && DATA) pull().catch(() => {}); });

  function check(col) {
    const ok = COLS.length ? COLS.includes(col) : /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(String(col));
    if (!ok) throw err("invalid_argument", "Unknown list " + col);
  }
  async function write(op, col, id, data) {
    check(col);
    DATA[col] = DATA[col] || {};
    const before = clone((DATA[col] || {})[id]);
    if (op === "delete") delete DATA[col][id];
    else if (op === "set") DATA[col][id] = clone(data);
    else DATA[col][id] = deepMerge(DATA[col][id], clone(data));
    emit();
    try {
      const j = await api("POST", { op, col, id, data: op === "delete" ? undefined : clone(data) });
      if (op !== "delete" && j.doc) DATA[col][id] = j.doc;
    } catch (e) {
      if (before === undefined) delete DATA[col][id]; else DATA[col][id] = before;
      emit(); throw e;
    }
  }
  function docRef(col, id) {
    return {
      id,
      set: data => write("set", col, id, data),
      update: data => write("update", col, id, data),
      delete: () => write("delete", col, id),
      get: async () => { const v = (DATA[col] || {})[id]; return { id, exists: v != null, data: () => clone(v) }; },
      onSnapshot(cb, onErr) { const s = { col, id, cb, onErr }; subs.add(s); fire(s); return () => subs.delete(s); },
    };
  }
  const db = {
    collection(col) {
      check(col);
      const c = {
        doc: id => docRef(col, id || newId()),
        limit: () => c,
        orderBy: () => c,
        onSnapshot(cb, onErr) { const s = { col, id: null, cb, onErr }; subs.add(s); fire(s); return () => subs.delete(s); },
      };
      return c;
    },
    doc(path) { const [col, id] = String(path).split("/"); check(col); return docRef(col, id); },
  };
  const user = {
    id: async () => (me && me.id) || "",
    email: async () => (me && me.email) || "",
    canEdit: async () => true,
    can: async () => true,
  };
  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: /\.csv$/i.test(filename) ? "text/csv;charset=utf-8" : "application/octet-stream" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename || "export";
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    },
  };

  /* ---------- files (Media tools) ---------- */
  async function filesApi(method, qs, body, headers) {
    const t = await accessToken();
    let r;
    try { r = await fetch("/api/files?app=" + (MEDIA ? APP : "posters") + (qs || ""), { method, cache: "no-store", headers: { Authorization: "Bearer " + t, ...(headers || {}) }, body }); }
    catch (_) { throw err("unavailable", "offline"); }
    if (r.status === 401) { signedOut("bad:Your sign-in has ended. Please sign in again."); throw err("revoked"); }
    if (r.status === 403) { signedOut("bad:This account wasn’t invited by the church, so it can’t open the workers’ pages. Ask Sam to send you an invitation."); throw err("revoked"); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 413) throw err("quota_or_state", "This file is too big to save (the limit is about 5 MB).");
    if (!r.ok) throw err(r.status >= 500 ? "unavailable" : "invalid_argument", j.detail || j.error);
    return j;
  }
  const assets = {
    async upload(file, opts) {
      const j = await filesApi("POST", opts && opts.id ? "&id=" + encodeURIComponent(opts.id) : "", file,
        { "Content-Type": (file && file.type) || "application/octet-stream", "X-File-Name": encodeURIComponent((file && file.name) || "") });
      return { id: j.id, url: j.url };
    },
    list: () => filesApi("GET"),
    delete: id => filesApi("DELETE", "&id=" + encodeURIComponent(id)),
  };

  /* ---------- Claude (Media tools, once the church adds an AI key) ---------- */
  let AI = false;
  const b64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.onerror = rej; r.readAsDataURL(blob); });
  async function aiCall(prompt, opts, asJson) {
    const t = await accessToken();
    const images = [];
    for (const im of (opts && opts.images) || []) {
      if (im instanceof Blob) images.push({ type: im.type || "image/png", data: await b64(im) });
      else if (typeof im === "string" && /^data:image\//.test(im)) images.push({ type: im.slice(5, im.indexOf(";")), data: im.split(",")[1] });
    }
    let r;
    try { r = await fetch("/api/ai", { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: JSON.stringify({ prompt, images, tier: (opts && opts.modelTier) || "default", json: !!asJson }), signal: opts && opts.signal }); }
    catch (e) { if (e && e.name === "AbortError") throw err("cancelled"); throw err("unavailable"); }
    if (r.status === 429) throw err("rate_limited");
    if (r.status === 401 || r.status === 403 || r.status === 501) throw err("not_granted");
    if (!r.ok) throw err("unavailable");
    let text = "";
    if (r.body && r.body.getReader && opts && opts.onText) {
      const rd = r.body.getReader(), dec = new TextDecoder();
      for (;;) { const { done, value } = await rd.read(); if (done) break; text += dec.decode(value, { stream: true }); try { opts.onText(text); } catch (_) {} }
    } else text = await r.text();
    return text;
  }
  function sample(prompt, opts) { return aiCall(prompt, opts, false).then(text => ({ text })); }
  sample.json = async (prompt, opts) => {
    const t = (await aiCall(prompt, opts, true)).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { return JSON.parse(t); } catch (_) { const m = t.match(/[\[{][\s\S]*[\]}]/); if (m) { try { return JSON.parse(m[0]); } catch (_) {} } throw err("invalid_json"); }
  };
  sample.limits = async () => ({ images: true });

  // What the apps ask for. Each call waits here until a worker signs in.
  window.claude = {
    use: async name => {
      await ready;
      if (name === "db") return HUB ? null : db;
      if (name === "user") return user;
      if (name === "downloads") return downloads;
      if (name === "assets") return MEDIA ? assets : null;
      if (name === "sample") return MEDIA && AI ? sample : null;
      return null;
    },
  };

  /* ---------- one-time import from the Claude version ---------- */
  const IMPORT = {
    shepherd: { file: "cpic-shepherd-records.json", what: "everyone" },
    posters: { file: "cpic-poster-studio-records.json", what: "the briefs, photos and finished posters" },
    photodesk: { file: "cpic-photo-desk-records.json", what: "the team’s logo and watermark settings" },
  }[APP];
  function isEmpty() {
    if (!DATA) return false;
    const cols = COLS.length ? COLS : Object.keys(DATA).filter(c => !VIRTUAL.includes(c));
    return cols.every(c => !Object.keys(DATA[c] || {}).length);
  }
  function importOffer() {
    let box = document.getElementById("importBox");
    if (!IMPORT || !isEmpty()) { if (box) box.remove(); return; }
    if (box) return;
    box = document.createElement("div"); box.id = "importBox";
    box.innerHTML = `<div class="ib"><h3>Bring your records over</h3>
      <p>${esc(TITLE)} on cpic.info is empty. If you have the records file from the Claude version (${esc(IMPORT.file)}), choose it here to bring ${esc(IMPORT.what)} across. This only works once, while ${esc(TITLE)} is empty.</p>
      <div class="ibrow"><label class="ibbtn">Choose records file<input type="file" id="importFile" accept=".json,application/json" hidden></label><span id="importMsg" style="font-size:13px;color:var(--cw-muted)"></span></div></div>`;
    const main = document.querySelector("main");
    if (main) main.parentNode.insertBefore(box, main); else document.body.insertBefore(box, document.body.firstChild);
    box.querySelector("#importFile").addEventListener("change", async e => {
      const f = e.target.files && e.target.files[0]; const msg = box.querySelector("#importMsg"); if (!f) return;
      try {
        msg.textContent = "Reading the file…";
        const j = JSON.parse(await f.text());
        if (j.app && j.app !== APP) throw new Error("This records file is for a different tool.");
        const data = j && j.data ? j.data : j;
        if (!data || !Object.keys(data).some(c => data[c] && Object.keys(data[c]).length)) throw new Error("This file has no records in it.");
        const files = Object.entries(j.files || {});
        let n = 0;
        for (const [id, fl] of files) {
          msg.textContent = `Bringing files across… ${++n} of ${files.length}`;
          const bin = Uint8Array.from(atob(fl.b64), ch => ch.charCodeAt(0));
          await assets.upload(new File([bin], fl.name || id, { type: fl.type || "application/octet-stream" }), { id });
        }
        msg.textContent = "Bringing records across…";
        const r = await api("POST", { op: "import", data });
        const c = r.counts || {};
        await pull();
        const parts = Object.entries(c).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`);
        alert("Done. Brought across " + (parts.join(", ") || "the records") + (files.length ? ` and ${files.length} files` : "") + ".");
      } catch (x) { msg.textContent = x.code === "invalid_argument" ? TITLE + " already has records, so nothing was imported." : (x.message || "Could not import the file."); }
    });
  }

  /* ---------- header: back to Ekklesia, who's signed in, sign out ---------- */
  function headerBar() {
    if (document.getElementById("wsBar")) return;
    const top = APP === "shepherd" || HUB || EDITS ? document.querySelector("header .top-in") : null;
    const bar = document.createElement("div"); bar.className = "ws-bar" + (top ? "" : " ws-float"); bar.id = "wsBar";
    bar.innerHTML = (HUB ? `<a href="/" title="Back to the public site">‹ Ekklesia</a>` : EDITS ? `<a href="/shepherd/" title="Back to Shepherd">‹ Shepherd</a>` : `<a href="/workers/" title="All workers’ tools">‹ Workers</a>`) +
      `<button type="button" id="wsOut" title="${esc(me && me.email || "")}">Sign out</button>`;
    (top || document.body).appendChild(bar);
    bar.querySelector("#wsOut").addEventListener("click", () => {
      keep(null); try { sessionStorage.clear(); } catch (_) {}
      location.replace("/workers/");
    });
  }

  function signedOut(n) { keep(null); DATA = null; clearTimeout(pollT); showGate("signin", n || ""); }

  /* ---------- start ---------- */
  async function start() {
    try {
      me = await currentUser();
      if (HUB) await filesApi("GET");        // confirms the account was invited
      if (EDITS) {
        let r;
        try { r = await fetch("/api/site?check=1", { cache: "no-store", headers: { Authorization: "Bearer " + (await accessToken()) } }); }
        catch (_) { throw new Error("offline"); }
        if (r.status === 401) throw err("revoked");
        if (r.status === 403) { signedOut("bad:This account wasn’t invited by the church, so it can’t open the workers’ pages. Ask Sam to send you an invitation."); return; }
        if (!r.ok) throw new Error("server:" + r.status);
        EDIT = await r.json();
      }
      if (MEDIA) { try { AI = !!(await (await fetch("/api/ai", { cache: "no-store" })).json()).enabled; } catch (_) { AI = false; } }
      await pull();
      hideGate(); headerBar(); if (!HUB && !EDITS) poll();
      document.dispatchEvent(new CustomEvent("cpic:signedin", { detail: { email: me && me.email, canEdit: !!(EDIT && EDIT.canEdit) } }));
      startedResolve();
    } catch (e) {
      if (e && e.code === "revoked") showGate("signin", tok ? "" : note);
      else showGate("signin", friendly(e));
    }
  }

  function init() {
    if (pending && pending.kind === "invite_token") return showGate("invite");
    if (pending && pending.kind === "recovery_token") return showGate("recovery");
    if (pending && pending.kind === "confirmation_token") {
      showGate("wait", "Confirming your email…");
      return jpost("/verify", { token: pending.token, type: "signup" }).then(j => { keep(fromResponse(j)); pending = null; return start(); })
        .catch(e => showGate("signin", friendly(e)));
    }
    if (pending && pending.kind === "error") return showGate("signin", "bad:" + pending.msg);
    if (!tok) return showGate("signin");
    showGate("wait", "Opening " + TITLE + "…");
    start();
  }
  if (tok) cookie(tok);
  let EDIT = null;
  window.CPIC_WORKER = { signOut: () => { keep(null); location.replace("/workers/"); }, get email() { return me && me.email; },
    token: () => accessToken(), get canEdit() { return !!(EDIT && EDIT.canEdit); }, expired: () => signedOut("bad:Your sign-in has ended. Please sign in again.") };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
