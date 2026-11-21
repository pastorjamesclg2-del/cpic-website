// Records for the Media department tools (workers only):
//   ?app=posters    Poster Studio
//   ?app=clipper    Sermon Clipper
//   ?app=photodesk  Photo Desk
//
// Kept in the private Netlify Blobs store "media", one blob per list:
// key "<app>/<list>" holding { "<id>": { ...record } }.
//
//   GET                                   -> { data: { <list>: {...} } }
//   POST { op:"set"|"update"|"delete", col, id, data } -> { ok, doc }
//   POST { op:"import", data:{ <list>:{...} } }  (only while the app is empty)

import { getStore } from "@netlify/blobs";
import { reply, requireWorker, MEDIA_APPS, NAME_RE, ID_RE, isPlain, deepMerge, updateJSON } from "../lib/workers.mjs";

const MAX_BODY = 1024 * 1024;
const MAX_IMPORT = 5.5 * 1024 * 1024;

export async function run(store, app, method, body) {
  const prefix = `${app}/`;
  if (method === "GET") {
    const { blobs } = await store.list({ prefix });
    const data = {};
    for (const b of blobs) {
      const col = b.key.slice(prefix.length);
      if (!NAME_RE.test(col)) continue;
      data[col] = (await store.get(b.key, { type: "json" })) || {};
    }
    return reply(200, { data });
  }
  if (method !== "POST") return reply(405, { error: "method" });
  if (!isPlain(body)) return reply(400, { error: "body" });

  if (body.op === "import") {
    if (!isPlain(body.data)) return reply(400, { error: "data" });
    const { blobs } = await store.list({ prefix });
    for (const b of blobs) { const cur = await store.get(b.key, { type: "json" }); if (cur && Object.keys(cur).length) return reply(409, { error: "not_empty" }); }
    const counts = {};
    for (const [col, docs] of Object.entries(body.data)) {
      if (!NAME_RE.test(col) || !isPlain(docs)) continue;
      const clean = {};
      for (const [id, doc] of Object.entries(docs)) if (ID_RE.test(id) && isPlain(doc)) clean[id] = doc;
      await store.setJSON(prefix + col, clean);
      counts[col] = Object.keys(clean).length;
    }
    return reply(200, { ok: true, counts });
  }

  const { op, col, id, data } = body;
  if (typeof col !== "string" || !NAME_RE.test(col)) return reply(400, { error: "collection" });
  if (typeof id !== "string" || !ID_RE.test(id)) return reply(400, { error: "id" });
  if (!["set", "update", "delete"].includes(op)) return reply(400, { error: "op" });
  if (op !== "delete" && !isPlain(data)) return reply(400, { error: "data" });
  try {
    const map = await updateJSON(store, prefix + col, cur => {
      const m = isPlain(cur) ? { ...cur } : {};
      if (op === "delete") delete m[id];
      else if (op === "set") m[id] = data;
      else m[id] = deepMerge(m[id], data);
      return m;
    });
    return reply(200, { ok: true, doc: map[id] ?? null });
  } catch (e) {
    if (e && e.busy) return reply(503, { error: "busy" });
    throw e;
  }
}

export default async (req) => {
  const app = new URL(req.url).searchParams.get("app");
  if (!MEDIA_APPS.includes(app)) return reply(400, { error: "app" });
  const who = await requireWorker(req);
  if (who.error) return who.error;

  let body = null;
  if (req.method === "POST") {
    const raw = await req.text();
    if (raw.length > MAX_IMPORT) return reply(413, { error: "too_large" });
    try { body = JSON.parse(raw); } catch { return reply(400, { error: "json" }); }
    if (body && body.op !== "import" && raw.length > MAX_BODY) return reply(413, { error: "too_large" });
  }
  try {
    return await run(getStore({ name: "media", consistency: "strong" }), app, req.method, body);
  } catch (e) {
    console.error("media-db", e && e.message);
    return reply(500, { error: "server", detail: String((e && e.message) || e) });
  }
};
