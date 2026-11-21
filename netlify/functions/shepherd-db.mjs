// Shepherd data API for cpic.info (workers only).
//
// Every request must carry a Netlify Identity sign-in token. Netlify checks
// the token before this code runs and passes the worker in
// context.clientContext.user. Sign-up on the site is invite only, so only
// workers the church has invited can get a token.
//
// Records are kept in a private Netlify Blobs store called "shepherd",
// one blob per collection: { "<id>": { ...record } }. Nothing here is ever
// written to the public website or to GitHub.
//
//   GET  -> { data: { newcomers:{}, members:{}, services:{}, reminders:{}, settings:{} } }
//   POST { op:"set"|"update"|"delete", col, id, data } -> { ok, doc }
//   POST { op:"import", data:{ <col>:{ <id>:{...} } } }  (only while the store is empty)

import { connectLambda, getStore } from "@netlify/blobs";

export const COLLECTIONS = ["newcomers", "members", "services", "reminders", "settings"];
const ID_RE = /^[A-Za-z0-9_.-]{1,120}$/;
const MAX_BODY = 400 * 1024;        // one change
const MAX_IMPORT = 8 * 1024 * 1024; // first-time import of all records

const isPlain = v => v !== null && typeof v === "object" && !Array.isArray(v);

// Same merge rule as the Claude version's update(): nested objects are merged,
// everything else (including null and arrays) replaces the old value.
export function deepMerge(target, patch) {
  const out = isPlain(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

const reply = (status, body) => ({
  statusCode: status,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
  },
  body: JSON.stringify(body),
});

// The request logic, separate from Netlify so it can be tested locally.
export async function run(store, user, method, body) {
  if (!user || !user.email) return reply(401, { error: "signin" });

  if (method === "GET") {
    const data = {};
    for (const c of COLLECTIONS) data[c] = (await store.get(c, { type: "json" })) || {};
    return reply(200, { data, email: user.email });
  }
  if (method !== "POST") return reply(405, { error: "method" });
  if (!isPlain(body)) return reply(400, { error: "body" });

  if (body.op === "import") {
    if (!isPlain(body.data)) return reply(400, { error: "data" });
    for (const c of COLLECTIONS) {
      const cur = await store.get(c, { type: "json" });
      if (cur && Object.keys(cur).length) return reply(409, { error: "not_empty" });
    }
    const counts = {};
    for (const c of COLLECTIONS) {
      const docs = isPlain(body.data[c]) ? body.data[c] : {};
      const clean = {};
      for (const [id, doc] of Object.entries(docs)) if (ID_RE.test(id) && isPlain(doc)) clean[id] = doc;
      await store.setJSON(c, clean);
      counts[c] = Object.keys(clean).length;
    }
    return reply(200, { ok: true, counts });
  }

  const { op, col, id, data } = body;
  if (!COLLECTIONS.includes(col)) return reply(400, { error: "collection" });
  if (typeof id !== "string" || !ID_RE.test(id)) return reply(400, { error: "id" });
  if (!["set", "update", "delete"].includes(op)) return reply(400, { error: "op" });
  if (op !== "delete" && !isPlain(data)) return reply(400, { error: "data" });

  // Read, change, and write back only if nobody else saved in between.
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await store.getWithMetadata(col, { type: "json" });
    const map = cur && isPlain(cur.data) ? { ...cur.data } : {};
    if (op === "delete") delete map[id];
    else if (op === "set") map[id] = data;
    else map[id] = deepMerge(map[id], data);
    const res = await store.setJSON(col, map, cur ? { onlyIfMatch: cur.etag } : { onlyIfNew: true });
    if (!res || res.modified !== false) return reply(200, { ok: true, doc: map[id] ?? null });
    await new Promise(r => setTimeout(r, 80 + Math.random() * 220));
  }
  return reply(503, { error: "busy" });
}

// Second lock: besides "Invite only" sign-up in Netlify, only accounts the
// church actually invited may open the records. Netlify gives this function a
// short-lived admin key for Identity, which lets it look up the account and
// see whether it was created from an invitation (invited_at is set).
const invitedCache = new Map(); // user id -> { ok, at }
async function wasInvited(identity, userId) {
  if (!identity || !identity.url || !identity.token || !userId) return null; // can't tell
  const hit = invitedCache.get(userId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.ok;
  try {
    const r = await fetch(`${identity.url}/admin/users/${encodeURIComponent(userId)}`, { headers: { Authorization: `Bearer ${identity.token}` } });
    if (!r.ok) return null;
    const u = await r.json();
    const ok = Boolean(u && u.invited_at);
    invitedCache.set(userId, { ok, at: Date.now() });
    return ok;
  } catch {
    return null;
  }
}

export const handler = async (event, context) => {
  const cc = (context && context.clientContext) || {};
  const user = cc.user;
  if (!user) return reply(401, { error: "signin" });
  if ((await wasInvited(cc.identity, user.sub)) === false) return reply(403, { error: "not_invited" });

  let body = null;
  if (event.httpMethod === "POST") {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "";
    if (raw.length > MAX_IMPORT) return reply(413, { error: "too_large" });
    try { body = JSON.parse(raw); } catch { return reply(400, { error: "json" }); }
    if (body && body.op !== "import" && raw.length > MAX_BODY) return reply(413, { error: "too_large" });
  }

  try {
    connectLambda(event);
    const store = getStore({ name: "shepherd", consistency: "strong" });
    return await run(store, user, event.httpMethod, body);
  } catch (e) {
    console.error("shepherd-db", e && e.message);
    return reply(500, { error: "server" });
  }
};
