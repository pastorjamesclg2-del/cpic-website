// Shared helpers for the workers-only functions on cpic.info.
//
// A worker proves who they are with their Netlify Identity sign-in token, sent
// as "Authorization: Bearer <token>" or, for files shown with <img>/<video>,
// in the "cpic_at" cookie that the sign-in page sets. The token is checked
// with Netlify Identity on this same site, which also tells us whether the
// account was created from an invitation. Only invited accounts get in.

export const reply = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...extra },
  });

const seen = new Map(); // token -> { user, at }

export function tokenFrom(req) {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(\S+)/);
  if (m) return m[1];
  const cookie = req.headers.get("cookie") || "";
  const c = cookie.match(/(?:^|;\s*)cpic_at=([^;]+)/);
  return c ? decodeURIComponent(c[1]) : null;
}

// Returns { id, email, invited } or null.
export async function whoIs(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  const hit = seen.get(token);
  if (hit && Date.now() - hit.at < 2 * 60 * 1000) return hit.user;
  const r = await fetch(new URL("/.netlify/identity/user", req.url), { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json();
  if (!u || !u.email) return null;
  const user = { id: u.id, sub: u.id, email: u.email, invited: Boolean(u.invited_at) };
  if (seen.size > 500) seen.clear();
  seen.set(token, { user, at: Date.now() });
  return user;
}

// Signed in and invited, or a ready-made refusal.
export async function requireWorker(req) {
  let user;
  try { user = await whoIs(req); }
  catch (e) { return { error: reply(503, { error: "identity", detail: String((e && e.message) || e) }) }; }
  if (!user) return { error: reply(401, { error: "signin" }) };
  if (!user.invited) return { error: reply(403, { error: "not_invited" }) };
  return { user };
}

export const MEDIA_APPS = ["posters", "clipper", "photodesk"];
export const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
export const ID_RE = /^[A-Za-z0-9_.-]{1,120}$/;
export const isPlain = v => v !== null && typeof v === "object" && !Array.isArray(v);

export function deepMerge(target, patch) {
  const out = isPlain(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

// Read-change-write on one JSON blob, retried if someone else saved in between.
export async function updateJSON(store, key, change) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const value = change(cur && cur.data !== undefined ? cur.data : null);
    const res = await store.setJSON(key, value, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (!res || res.modified !== false) return value;
    await new Promise(r => setTimeout(r, 80 + Math.random() * 220));
  }
  throw Object.assign(new Error("busy"), { busy: true });
}
