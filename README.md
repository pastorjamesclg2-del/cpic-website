# CPIC website (cpic.info)

Christ Power International Church, Dubai.

## What's here

- `public/index.html`: **Ekklesia**, the public site. Its content (sermons, events, posters) lives in the one `<script id="snapshot">` block; updating Ekklesia means replacing only that block, which keeps the design. The page has Home (welcome, live status, this week, latest message, coming up, verse, new here), Sermons (reader with verse pop-ups, video, ticks, memory game, verse pictures), Events, Prayer and Follow.
  Prayer requests go by WhatsApp to Pastor James or Pastor Blessing James. The last tab, **Workers**, opens the workers' page.
- `public/workers/`: **CPIC Workers**, for invited workers only.
  - `index.html` lists everything: Shepherd and the Media department.
  - `auth.js` is the shared sign-in (Netlify Identity, invite only) used by every workers' page. It also connects each app to its private records, files and (once an AI key is added) Claude.
- `public/shepherd/`: **Shepherd** (Sunday attendance, newcomers, follow-up, groups, insights).
- `public/shepherd/edits/`: **Edits** (Shepherd's last tab). Workers change what everyone sees on cpic.info without touching this repository: sermons, events and their posters, the YouTube page each programme opens while it's live (Morning Glory has its own), the Follow page and the church WhatsApp number. There is a History of who changed what.
- `public/media/`: the **Media department**: `poster-studio/`, `sermon-clipper/` and `photo-desk/` (with its face-recognition `models/`).
- `netlify/functions/shepherd-db.mjs`: Shepherd's records (Netlify Blobs store `shepherd`).
- `netlify/functions/site-content.mjs`: Ekklesia's live content from Edits (Netlify Blobs store `site`). `GET /api/site` and `/api/site/poster/<id>` are public; changes need a signed-in invited worker. Ekklesia lays these changes over its built-in snapshot when it loads: an edited item replaces the built-in one, a deleted one is hidden, and a newer built-in item still wins.
- `netlify/functions/media-db.mjs`: the Media tools' records (store `media`).
- `netlify/functions/media-files.mjs`: the Media tools' uploaded files and finished posters (store `media-files`), served from `/_blob/<id>` to signed-in workers only.
- `netlify/edge-functions/ai.js`: `/api/ai`, Claude for the Media tools. Off until `ANTHROPIC_API_KEY` is set in Netlify.
- `netlify/lib/workers.mjs`: shared checks (signed in and invited).
- `public/manifest.webmanifest`, `public/sw.js` and the icons let people install Ekklesia as a phone app. Worker pages, files and records are never stored by the app on the phone.

**No personal records are ever kept in this repository.** It is public.

## Settings in Netlify (one-time)

- Identity: enabled, registration **Invite only**. Workers are invited by email from Netlify (Project configuration → Identity → Invite users). Invitation and password-reset links come back to cpic.info, which forwards them to `/workers/`.
- Netlify publishes the `public` folder and the functions in `netlify/functions` automatically whenever this repository changes (see `netlify.toml`).
- Optional: environment variable `SITE_EDITORS` (comma-separated emails) limits who can make changes in Edits. Without it, every invited worker can.
- Optional: environment variable `ANTHROPIC_API_KEY` (Project configuration → Environment variables) switches on the Claude features in the Media tools: style suggestions and poster checks in Poster Studio, clip picking and captions in Sermon Clipper, captions in Photo Desk. Usage is billed to that API key.
