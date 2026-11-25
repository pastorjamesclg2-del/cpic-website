// Ekklesia's live content, edited from Shepherd › Edits (workers only).
//
// Ekklesia (cpic.info) ships with a built-in copy of its sermons, events and
// church details (the snapshot in index.html). Changes made in Edits are kept
// here, in the Netlify Blobs store "site", and Ekklesia lays them over that
// copy when it loads: an edited item replaces the built-in one, a deleted item
// hides it, and newer built-in items still show.
//
//   GET    /api/site                     -> { sermons, events, church, deleted, at }   (public)
//   GET    /api/site?check=1             -> { ok, email, canEdit }                     (workers)
//   GET    /api/site?log=1               -> { log: [...] } recent changes              (workers)
//   POST   /api/site  { op:"put", col:"sermons"|"events", item:{ id, ... } }          (editors)
//   POST   /api/site  { op:"delete", col, id }                                         (editors)
//   POST   /api/site  { op:"church", church:{ ... } }                                  (editors)
//   POST   /api/site/poster              raw image -> { id, url }                      (editors)
//   GET    /api/site/poster/<id>         the image                                     (public)
//
// Editors are all invited workers, unless the SITE_EDITORS environment
// variable lists the email addresses allowed to edit (comma separated).

import { getStore } from "@netlify/blobs";
import { reply, requireWorker, ID_RE, isPlain, updateJSON } from "../lib/workers.mjs";

export const config = { path: ["/api/site", "/api/site/*"] };

const COLS = ["sermons", "events"];
const MAX_ITEM = 200 * 1024;
const MAX_CHURCH = 64 * 1024;
const MAX_IMAGE = 5.5 * 1024 * 1024;
const IMG_ID = /^[a-f0-9]{32}$/;
const IMG_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
const EMPTY = () => ({ sermons: {}, events: {}, church: {}, deleted: { sermons: {}, events: {} }, at: "" });

function editorsFrom(env) {
  const raw = String(env || "").trim();
  return raw ? raw.split(/[\s,;]+/).map(s => s.toLowerCase()).filter(Boolean) : null;
}
const canEdit = (user, env) => { const list = editorsFrom(env); return !list || list.includes(String(user.email || "").toLowerCase()); };

// Public shape: lists instead of maps.
export function publicShape(c) {
  const v = isPlain(c) ? c : EMPTY();
  return {
    sermons: Object.entries(v.sermons || {}).map(([id, x]) => ({ ...x, id })),
    events: Object.entries(v.events || {}).map(([id, x]) => ({ ...x, id })),
    church: v.church || {},
    deleted: v.deleted || { sermons: {}, events: {} },
    at: v.at || "",
  };
}

export async function run(store, req, url, user, editorsEnv) {
  const path = url.pathname.replace(/\/+$/, "");

  // Public poster image
  if (path.startsWith("/api/site/poster/") && req.method === "GET") {
    const id = path.slice("/api/site/poster/".length);
    if (!IMG_ID.test(id)) return reply(404, { error: "not_found" });
    const got = await store.getWithMetadata("poster/" + id, { type: "arrayBuffer" });
    if (!got) return reply(404, { error: "not_found" });
    return new Response(got.data, { status: 200, headers: { "Content-Type": (got.metadata || {}).type || "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" } });
  }

  // Public content
  if (path === "/api/site" && req.method === "GET" && !url.searchParams.has("check") && !url.searchParams.has("log")) {
    const c = await store.get("content", { type: "json" });
    return reply(200, publicShape(c), { "Cache-Control": "public, max-age=0, must-revalidate" });
  }

  // Everything below needs a signed-in, invited worker
  if (!user) return reply(401, { error: "signin" });
  const editor = canEdit(user, editorsEnv);

  if (path === "/api/site" && req.method === "GET") {
    if (url.searchParams.has("log")) return reply(200, { log: (await store.get("log", { type: "json" })) || [] });
    return reply(200, { ok: true, email: user.email, canEdit: editor });
  }
  if (!editor) return reply(403, { error: "not_editor" });

  // Upload a poster
  if (path === "/api/site/poster" && req.method === "POST") {
    const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!IMG_TYPES.includes(type)) return reply(415, { error: "type" });
    const buf = await req.arrayBuffer();
    if (!buf.byteLength) return reply(400, { error: "empty" });
    if (buf.byteLength > MAX_IMAGE) return reply(413, { error: "too_large" });
    const id = newId();
    await store.set("poster/" + id, buf, { metadata: { type, size: buf.byteLength, by: user.email, at: new Date().toISOString() } });
    return reply(200, { id, url: "/api/site/poster/" + id });
  }

  if (path !== "/api/site" || req.method !== "POST") return reply(405, { error: "method" });
  const raw = await req.text();
  if (raw.length > MAX_ITEM + 4096) return reply(413, { error: "too_large" });
  let body;
  try { body = JSON.parse(raw); } catch { return reply(400, { error: "json" }); }
  if (!isPlain(body)) return reply(400, { error: "body" });
  const now = new Date().toISOString();
  let entry;

  const change = cur => {
    const c = isPlain(cur) ? { ...EMPTY(), ...cur } : EMPTY();
    c.deleted = { sermons: { ...((c.deleted || {}).sermons || {}) }, events: { ...((c.deleted || {}).events || {}) } };
    if (body.op === "put") {
      const { id, ...rest } = body.item;
      c[body.col] = { ...(c[body.col] || {}), [id]: { ...rest, updatedAt: now } };
      delete c.deleted[body.col][id];
      entry = { op: "put", col: body.col, id, title: String(rest.title || "").slice(0, 120) };
    } else if (body.op === "delete") {
      const map = { ...(c[body.col] || {}) };
      const title = map[body.id] ? map[body.id].title : body.title;
      delete map[body.id];
      c[body.col] = map;
      c.deleted[body.col][body.id] = now;
      entry = { op: "delete", col: body.col, id: body.id, title: String(title || "").slice(0, 120) };
    } else {
      c.church = { ...body.church, updatedAt: now };
      entry = { op: "church" };
    }
    c.at = now;
    return c;
  };

  if (body.op === "put" || body.op === "delete") {
    if (!COLS.includes(body.col)) return reply(400, { error: "collection" });
    if (body.op === "put") {
      if (!isPlain(body.item) || typeof body.item.id !== "string" || !ID_RE.test(body.item.id)) return reply(400, { error: "item" });
      if (JSON.stringify(body.item).length > MAX_ITEM) return reply(413, { error: "too_large" });
    } else if (typeof body.id !== "string" || !ID_RE.test(body.id)) return reply(400, { error: "id" });
  } else if (body.op === "church") {
    if (!isPlain(body.church) || JSON.stringify(body.church).length > MAX_CHURCH) return reply(400, { error: "church" });
  } else return reply(400, { error: "op" });

  try {
    const c = await updateJSON(store, "content", change);
    await updateJSON(store, "log", cur => [{ ...entry, at: now, by: user.email }, ...(Array.isArray(cur) ? cur : [])].slice(0, 150)).catch(() => {});
    return reply(200, { ok: true, at: now, content: publicShape(c) });
  } catch (e) {
    if (e && e.busy) return reply(503, { error: "busy" });
    throw e;
  }
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const isPublic = req.method === "GET" && (path.startsWith("/api/site/poster/") || (path === "/api/site" && !url.searchParams.has("check") && !url.searchParams.has("log")));
  let user = null;
  if (!isPublic) {
    const who = await requireWorker(req);
    if (who.error) return who.error;
    user = who.user;
  }
  try {
    return await run(getStore({ name: "site", consistency: "strong" }), req, url, user, process.env.SITE_EDITORS);
  } catch (e) {
    console.error("site-content", e && e.message);
    return reply(500, { error: "server", detail: String((e && e.message) || e) });
  }
};
