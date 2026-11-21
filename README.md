# CPIC website (cpic.info)

Christ Power International Church, Dubai.

## What's here

- `public/index.html`: **Ekklesia**, the public site (sermon notes, events and posters, prayer requests by WhatsApp to Pastor James or Pastor Blessing James). Its last tab, **Workers**, opens Shepherd.
- `public/shepherd/`: **Shepherd**, the workers-only portal (Sunday attendance, newcomers, follow-up, groups, insights).
  - `index.html` is the Shepherd app.
  - `auth.js` handles worker sign-in (Netlify Identity, invite only) and connects the app to its private records.
- `netlify/functions/shepherd-db.mjs`: the private data API. It only answers signed-in workers and keeps the records in Netlify Blobs (store `shepherd`).
- `public/manifest.webmanifest`, `public/sw.js` and the icons let people install Ekklesia as a phone app. Worker pages and records are never stored by the app on the phone.

**No personal records are ever kept in this repository.** It is public.

## Settings in Netlify (one-time)

- Identity: enabled, registration **Invite only**. Workers are invited by email from Netlify (Project configuration → Identity → Invite users). Invitation and password-reset links come back to cpic.info, which forwards them to `/shepherd/`.
- Netlify publishes the `public` folder and the functions in `netlify/functions` automatically whenever this repository changes (see `netlify.toml`).
