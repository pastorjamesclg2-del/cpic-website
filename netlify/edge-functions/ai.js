// Claude for the Media tools on cpic.info (workers only).
//
// Poster Studio, Sermon Clipper and Photo Desk ask Claude to suggest poster
// styles, check finished posters, pick sermon clips and write captions. On the
// website this goes through the Anthropic API with the church's own API key.
// Until the key is added in Netlify (environment variable ANTHROPIC_API_KEY),
// GET /api/ai answers {enabled:false} and the tools let people do those steps
// by hand. The answer is streamed, so long jobs don't time out.

const MODELS = { quick: "claude-haiku-5-5", default: "claude-sonnet-5-5", complex: "claude-sonnet-5-5" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export default async (req) => {
  const key = globalThis.Netlify && Netlify.env.get("ANTHROPIC_API_KEY");
  if (req.method === "GET") return json(200, { enabled: Boolean(key) });
  if (req.method !== "POST") return json(405, { error: "method" });
  if (!key) return json(501, { error: "not_enabled" });

  // Only invited workers
  const auth = req.headers.get("authorization") || "";
  if (!/^Bearer\s+\S+/.test(auth)) return json(401, { error: "signin" });
  const ur = await fetch(new URL("/.netlify/identity/user", req.url), { headers: { Authorization: auth } });
  if (!ur.ok) return json(401, { error: "signin" });
  const user = await ur.json();
  if (!user || !user.invited_at) return json(403, { error: "not_invited" });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "json" }); }
  const prompt = String(body.prompt || "").slice(0, 400000);
  if (!prompt) return json(400, { error: "prompt" });
  const content = [];
  for (const im of (Array.isArray(body.images) ? body.images : []).slice(0, 4)) {
    if (im && /^image\/(png|jpeg|webp|gif)$/.test(im.type) && typeof im.data === "string") content.push({ type: "image", source: { type: "base64", media_type: im.type, data: im.data } });
  }
  content.push({ type: "text", text: body.json ? prompt + "\n\nReply with valid JSON only, no code fences." : prompt });

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODELS[body.tier] || MODELS.default, max_tokens: 8000, stream: true, messages: [{ role: "user", content }] }),
  });
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return json(upstream.status === 429 ? 429 : 502, { error: upstream.status === 429 ? "rate_limited" : "upstream", detail: detail.slice(0, 300) });
  }

  // Pass the text through as it arrives.
  const enc = new TextEncoder(), dec = new TextDecoder();
  let buf = "";
  const stream = new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        try { const ev = JSON.parse(line.slice(5)); if (ev.type === "content_block_delta" && ev.delta && ev.delta.text) ctl.enqueue(enc.encode(ev.delta.text)); } catch {}
      }
    },
  });
  return new Response(upstream.body.pipeThrough(stream), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
};

export const config = { path: "/api/ai" };
