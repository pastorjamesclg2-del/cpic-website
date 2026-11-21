// Uploaded files for the Media department tools (workers only): photos, logos,
// finished posters and clip parts. Kept in the private Netlify Blobs store
// "media-files", one blob per file, with a small index per app for usage.
//
//   GET    /_blob/<id>                         -> the file (signed-in workers only)
//   POST   /api/files?app=<app>[&id=<id>]      raw file body -> { id, url }
//          (id is only accepted for a first-time import of an existing file)
//   GET    /api/files?app=<app>                -> { usage: { files, bytes } }
//   DELETE /api/files?app=<app>&id=<id>        -> { ok }
//
// Each file must be under about 5.5 MB, the limit for one request. Sermon
// Clipper saves longer clips in several parts.

import { getStore } from "@netlify/blobs";
import { reply, requireWorker, MEDIA_APPS, isPlain, updateJSON } from "../lib/workers.mjs";

export const config = { path: ["/_blob/*", "/api/files"] };

const MAX_FILE = 5.5 * 1024 * 1024;
const FILE_ID = /^[a-f0-9]{16,64}$/;
const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");

export async function run(files, req, url) {
  // Serve one file
  if (url.pathname.startsWith("/_blob/")) {
    const id = url.pathname.slice(7).split("/")[0];
    if (!FILE_ID.test(id)) return reply(404, { error: "not_found" });
    const got = await files.getWithMetadata(id, { type: "arrayBuffer" });
    if (!got) return reply(404, { error: "not_found" });
    const m = got.metadata || {};
    return new Response(got.data, { status: 200, headers: { "Content-Type": m.type || "application/octet-stream", "Cache-Control": "private, max-age=31536000, immutable", "X-Robots-Tag": "noindex" } });
  }

  const app = url.searchParams.get("app");
  if (!MEDIA_APPS.includes(app)) return reply(400, { error: "app" });
  const indexKey = `index/${app}`;

  if (req.method === "GET") {
    const idx = (await files.get(indexKey, { type: "json" })) || {};
    const list = Object.values(idx);
    return reply(200, { usage: { files: list.length, bytes: list.reduce((a, f) => a + (f.size || 0), 0) } });
  }

  if (req.method === "POST") {
    const buf = await req.arrayBuffer();
    if (!buf.byteLength) return reply(400, { error: "empty" });
    if (buf.byteLength > MAX_FILE) return reply(413, { error: "too_large" });
    let id = url.searchParams.get("id");
    if (id) {
      if (!FILE_ID.test(id)) return reply(400, { error: "id" });
      if (await files.getMetadata(id)) return reply(200, { id, url: "/_blob/" + id, existed: true });
    } else id = newId();
    const type = (req.headers.get("content-type") || "application/octet-stream").split(";")[0].slice(0, 100);
    const name = decodeURIComponent(req.headers.get("x-file-name") || "").slice(0, 200);
    await files.set(id, buf, { metadata: { app, type, size: buf.byteLength, name, at: new Date().toISOString() } });
    await updateJSON(files, indexKey, cur => ({ ...(isPlain(cur) ? cur : {}), [id]: { size: buf.byteLength, type } }));
    return reply(200, { id, url: "/_blob/" + id });
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id || !FILE_ID.test(id)) return reply(400, { error: "id" });
    await files.delete(id);
    await updateJSON(files, indexKey, cur => { const m = { ...(isPlain(cur) ? cur : {}) }; delete m[id]; return m; });
    return reply(200, { ok: true });
  }
  return reply(405, { error: "method" });
}

export default async (req) => {
  const who = await requireWorker(req);
  if (who.error) return who.error;
  try {
    return await run(getStore({ name: "media-files", consistency: "strong" }), req, new URL(req.url));
  } catch (e) {
    console.error("media-files", e && e.message);
    return reply(500, { error: "server", detail: String((e && e.message) || e) });
  }
};
