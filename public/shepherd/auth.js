/* CPIC Shepherd on cpic.info: worker sign-in and data connection.
 *
 * Shepherd was first built inside Claude, where it used claude.use("db"),
 * claude.use("user") and claude.use("downloads"). This file provides the same
 * three things for the website, so the Shepherd app itself is unchanged:
 *   - sign-in with Netlify Identity (invite only: no public sign-up)
 *   - "db": the records, read and saved through /.netlify/functions/shepherd-db
 *   - "downloads": CSV exports saved straight to the device
 * Nothing loads until a worker has signed in. Sign-in tokens stay in this
 * browser only and are removed on sign out.
 */
(function () {
  "use strict";
  const IDENT = "/.netlify/identity";
  const API = "/.netlify/functions/shepherd-db";
  const KEY = "cpic.shepherd.auth";
  const COLS = ["newcomers", "members", "services", "reminders", "settings"];
  const POLL_MS = 30000;

  /* ---------- tokens ---------- */
  let tok = null;
  try { tok = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (_) { tok = null; }
  function keep(t) {
    tok = t;
    try { t ? localStorage.setItem(KEY, JSON.stringify(t)) : localStorage.removeItem(KEY); } catch (_) {}
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
  const LOGO = () => { const l = document.querySelector("header .logo"); return l ? l.getAttribute("src") : ""; };
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let gate = null, mode = "signin", note = "", busy = false, lastEmail = "";

  function css() {
    if (document.getElementById("gateCss")) return;
    const st = document.createElement("style"); st.id = "gateCss";
    st.textContent = `
#gate{position:fixed;inset:0;z-index:60;background:var(--bg,#F3F4F8);overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:max(28px,env(safe-area-inset-top,0px)) 16px 40px}
#gate .card{width:100%;max-width:420px;background:var(--surface,#fff);border:1px solid var(--line,#DCDFEA);border-radius:16px;padding:24px 20px;display:flex;flex-direction:column;gap:14px;margin-top:6vh}
#gate .head{display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}
#gate .head img{height:46px;width:auto;background:#fff;border-radius:8px;padding:3px 6px;border:1px solid var(--line,#DCDFEA)}
#gate h2{margin:0;font-family:var(--f-display,system-ui);font-size:22px}
#gate p{margin:0}
#gate .msg{border-radius:10px;padding:10px 12px;font-size:14px;background:var(--accent-soft,#E4E7F6)}
#gate .msg.bad{background:var(--bad-soft,#F8DFE2);color:var(--bad,#B42335)}
#gate .msg.ok{background:var(--ok-soft,#DDF3E9);color:var(--ok,#0E7C53)}
#gate input[type=email],#gate input[type=password]{width:100%;border:1px solid var(--line,#DCDFEA);background:var(--bg,#F3F4F8);border-radius:10px;padding:10px 12px;min-height:44px;font:inherit;color:inherit}
#gate .links{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:14px}
#gate .links a,#gate .links button{color:var(--accent,#1F2A7A);background:none;border:0;padding:0;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
#gate .btn{width:100%}
.ws-bar{display:flex;align-items:center;gap:8px}
.ws-bar a,.ws-bar button{font-size:12.5px;font-weight:600;color:var(--accent);background:none;border:1px solid var(--line);border-radius:8px;padding:4px 9px;cursor:pointer;text-decoration:none;white-space:nowrap}
#importBox{max-width:760px;margin:16px auto 0;padding:0 16px}
#importBox .section{border-color:var(--accent)}`;
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
    if (mode === "signin") body = head("Shepherd", "For CPIC workers only. Sign in with the email address the church invited.") + msg +
      `<form data-f="signin" class="field" style="gap:12px"><div class="field"><label for="gEmail">Email</label><input type="email" id="gEmail" autocomplete="username" required value="${esc(lastEmail)}"></div>
       <div class="field"><label for="gPass">Password</label><input type="password" id="gPass" autocomplete="current-password" required></div>
       <button class="btn primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Signing in…" : "Sign in"}</button></form>` + back +
      `<p class="small muted">New worker? Open the invitation email from CPIC and tap the link in it to create your password. There’s no public sign-up.</p>`;
    else if (mode === "invite") body = head("Welcome to Shepherd", "Create your password to finish setting up your worker account.") + msg +
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
    if (/Failed to fetch|NetworkError/i.test(m)) return "bad:No connection. Check your internet and try again.";
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
    const j = await r.json().catch(() => ({}));
    if (r.status === 413) throw err("quota_exceeded");
    if (r.status >= 500) throw err("unavailable");
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
  async function pull() {
    const j = await api("GET");
    DATA = j.data || {}; for (const c of COLS) DATA[c] = DATA[c] || {};
    emit(); importOffer();
  }
  function poll() {
    clearTimeout(pollT);
    pollT = setTimeout(async () => { if (document.visibilityState === "visible" && tok) { try { await pull(); } catch (_) {} } poll(); }, POLL_MS);
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && tok && DATA) pull().catch(() => {}); });

  function check(col) { if (!COLS.includes(col)) throw err("invalid_argument", "Unknown list " + col); }
  async function write(op, col, id, data) {
    check(col);
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
      return {
        doc: id => docRef(col, id || newId()),
        onSnapshot(cb, onErr) { const s = { col, id: null, cb, onErr }; subs.add(s); fire(s); return () => subs.delete(s); },
      };
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

  // What the Shepherd app asks for. It waits here until a worker signs in.
  window.claude = {
    use: async name => {
      await ready;
      if (name === "db") return db;
      if (name === "user") return user;
      if (name === "downloads") return downloads;
      return null;
    },
  };

  /* ---------- one-time import from the Claude version ---------- */
  function importOffer() {
    const empty = DATA && COLS.every(c => !Object.keys(DATA[c] || {}).length);
    let box = document.getElementById("importBox");
    if (!empty) { if (box) box.remove(); return; }
    if (box) return;
    box = document.createElement("div"); box.id = "importBox";
    box.innerHTML = `<section class="section"><h3>Bring your records over</h3>
      <p class="small muted" style="margin:0">Shepherd on cpic.info is empty. If you have the records file from the Claude version (cpic-shepherd-records.json), choose it here to bring everyone across. This only works once, while Shepherd is empty.</p>
      <div class="row"><label class="btn primary" style="cursor:pointer">Choose records file<input type="file" id="importFile" accept=".json,application/json" hidden></label><span class="small muted" id="importMsg"></span></div></section>`;
    const main = document.querySelector("main"); main.parentNode.insertBefore(box, main);
    box.querySelector("#importFile").addEventListener("change", async e => {
      const f = e.target.files && e.target.files[0]; const msg = box.querySelector("#importMsg"); if (!f) return;
      try {
        msg.textContent = "Reading the file…";
        const j = JSON.parse(await f.text()); const data = j && j.data ? j.data : j;
        if (!data || !COLS.some(c => data[c] && Object.keys(data[c]).length)) throw new Error("This file has no Shepherd records in it.");
        msg.textContent = "Bringing records across…";
        const r = await api("POST", { op: "import", data });
        const c = r.counts || {};
        await pull();
        alert(`Done. Brought across ${c.newcomers || 0} newcomers, ${c.members || 0} members and ${c.services || 0} services.`);
      } catch (x) { msg.textContent = x.code === "invalid_argument" ? "Shepherd already has records, so nothing was imported." : (x.message || "Could not import the file."); }
    });
  }

  /* ---------- header: back to Ekklesia, who's signed in, sign out ---------- */
  function headerBar() {
    const top = document.querySelector("header .top-in"); if (!top || document.getElementById("wsBar")) return;
    const bar = document.createElement("div"); bar.className = "ws-bar"; bar.id = "wsBar";
    bar.innerHTML = `<a href="/" title="Back to the public site">‹ Ekklesia</a><button type="button" id="wsOut" title="${esc(me && me.email || "")}">Sign out</button>`;
    top.appendChild(bar);
    bar.querySelector("#wsOut").addEventListener("click", () => {
      keep(null); try { sessionStorage.clear(); } catch (_) {}
      location.replace("/shepherd/");
    });
  }

  function signedOut(n) { keep(null); DATA = null; clearTimeout(pollT); showGate("signin", n || ""); }

  /* ---------- start ---------- */
  async function start() {
    try {
      me = await currentUser();
      await pull();
      hideGate(); headerBar(); poll();
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
    showGate("wait", "Opening Shepherd…");
    start();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
