# PocketScience

**Self-hosted session replay — a lightweight, open-source alternative to FullStory / OpenReplay.**

Captures real user sessions with [rrweb](https://github.com/rrweb-io/rrweb), stores them in your own Postgres, and replays them from a built-in admin dashboard. One Next.js app — ingest API and dashboard ship together, so it's cheap to run and you own the data end to end.

![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-blue.svg)
**License:** [PolyForm Noncommercial 1.0.0](LICENSE) — free for personal/educational/noncommercial use; commercial use needs a separate license from the author.
**Privacy:** you're responsible for complying with GDPR/CCPA/etc. — use the [masking options](#privacy-modes) and disclose recording in your privacy policy.

---

## Quick start

**Prerequisites:** Node.js 20+, a Postgres database.

```bash
git clone https://github.com/XiRoSe/pocketscience-oss.git
cd pocketscience-oss
npm install
cp .env.example .env.local        # edit the values
npm run db:migrate                # apply schema to your Postgres
npm run dev
```

Open <http://localhost:3000>, log in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD`
you set in `.env.local`. A default org/project is created on first boot —
copy its **project key** from the dashboard for the next step.

## Record sessions on your site

Every project you create has its own **project key** (looks like
`umsk_xxxxxxxxxxxxxxxxxxxx`) — it's how the tracker tells your recorder
*which* project a session belongs to. Copy it from the project's page in the
dashboard, then drop one script tag on the pages you want to record:

```html
<script
  src="https://your-recorder.example.com/tracker.js"
  data-project-key="umsk_xxxxxxxxxxxxxxxxxxxx"
  data-privacy-mode="mask_all_inputs"
></script>
```

| Attribute | Required? | What it does |
| --- | --- | --- |
| `src` | ✅ | Where the browser loads the tracker script from — the URL of *your own* recorder deployment (the app from Quick start), not this repo. |
| `data-project-key` | ✅ | Which project this session gets filed under. Get it from that project's page in the dashboard. |
| `data-privacy-mode` | – | `default`, `mask_all_inputs`, or `strict` — see [Privacy modes](#privacy-modes). Defaults to `default` (records everything, unmasked) if omitted. |
| `data-api-origin` | – | **Advanced, rarely needed.** By default, recorded events are sent back to whatever host `src` pointed at above — so this attribute is intentionally left out of the example. Only set it if you serve `tracker.js` itself from a different host than the recorder API (e.g. a CDN in front of the static file). |

That's it — sessions start showing up in the dashboard within a few seconds
of a visit. `window.PocketScience` is exposed for manual `identify()` /
`stop()` calls (see [`lib/tracker.ts`](lib/tracker.ts)); in a bundled app you
can `import { initRecorder } from './lib/tracker'` directly instead of the
script tag. `window.MegaRecorder` still works too, as an alias — the pre-rebrand
name — so nothing embedded before the PocketScience rename breaks.

---

## Screenshots

**Sessions list** — recent sessions with duration, pages, country, browser, and per-admin unviewed indicators.

![Sessions list](docs/screenshots/sessions-list.png)

**Session replay** — scrub through a recorded session with speed controls, skip-inactive, and one-click MP4 export.

![Session replay](docs/screenshots/session-replay.png)

**Users** — sessions aggregated per visitor.

![Users list](docs/screenshots/users-list.png)

**Tags** — admin-editable rules that auto-tag sessions by URL or visit count, each with its own color.

![Tags](docs/screenshots/tags.png)

## Features

- 🎥 **Full session replay** via rrweb, with a live URL bar that follows the visitor across page loads and SPA route changes.
- 📖 **Session narratives** — every session is auto-translated into a readable step-by-step story ("Landed on /home → clicked 'Pricing' → typed in the email field") with frustration badges: 🔥 rage clicks, 💀 dead clicks, 📝 abandoned forms, 🔁 pogo-sticking. Pure deterministic extraction — no AI required, works retroactively on existing sessions.
- 🧠 **Optional AI intent summaries** — point `SUMMARIZER_URL` at the bundled self-hosted [summarizer service](summarizer/README.md) (llama.cpp + Qwen3.5-4B) and each session also gets a 2–3 sentence read on what the visitor wanted and where they got stuck. Session data never leaves your infrastructure.
- 🗄️ **Bring your own Postgres** — events are gzipped and stored inline, no extra object store or volume.
- 🔒 **Privacy modes** — mask all inputs, or strict masking of any element you tag.
- 🏷️ **Admin-editable tag rules** — auto-tag sessions by URL match (e.g. "reached /signup") or visit count (e.g. "2nd+ session, same visitor"), each with its own color. Applies to existing sessions immediately.
- 🚫 **Exclude visitors from recording** — stop a given browser (e.g. your own team's QA traffic) from ever being recorded, enforced server-side.
- ↕️ **Sortable session & user tables** — click any column header to reorder.
- 👤 **Per-admin "viewed" tracking** — each admin sees which sessions *they've* watched.
- 🎞️ **One-click MP4 export** — server-side render to mp4 (headless Chromium + ffmpeg).
- 🧹 **Retention & session caps** — auto-prunes old/zero-event sessions, hard per-session duration cap.
- 🐳 **Deploy anywhere** — standard Dockerfile, migrations run automatically on boot.

## How it works

```
 ┌────────────┐   tracker.js (rrweb)   ┌─────────────────────────────┐
 │ Your site  │ ─────────────────────► │  PocketScience               │
 │  + <script>│   POST /api/ingest/... │  (Next.js: ingest + admin)   │
 └────────────┘                        │                              │
                                       │   ┌──────────────────────┐   │
        Admin dashboard  ◄──────────── │   │ Postgres (events,    │   │
        /projects, /sessions/[id]      │   │ gzipped blobs inline)│   │
                                       │   └──────────────────────┘   │
                                       └─────────────────────────────┘
```

The tracker uses a small **wire protocol** (kept stable for drop-in script tags): storage keys `ps_anon_id` / `ps_session_v2`, header `x-ps-end`, mask attribute `data-ps-mask`, global `window.PocketScience`. These replaced pre-rebrand names (`mega_anon_id` / `mega_session_v2` / `x-mega-end` / `data-mega-mask` / `window.MegaRecorder`) — all still honored so a tracker.js snippet embedded before the PocketScience rename keeps working with no re-embed; see `LEGACY_TRACKER_COMPAT` below for the one that's a server-side flag rather than a permanent alias.

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | Postgres connection string. |
| `JWT_SECRET` | ✅ | Secret for signing admin session cookies (32+ bytes). |
| `INGEST_TOKEN_SECRET` | ✅ | Secret for signing per-project ingest tokens (32+ bytes). |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | ✅* | Single admin login. |
| `ADMINS_CREDS` | ✅* | JSON array of `{ "email", "password" }` for multiple admins (takes precedence over the pair above). |
| `ORG_NAME` | – | Display name for the auto-created org/project (default `My Company`). |
| `BLOB_DIR` | – | Directory for blob storage when not using inline DB storage. |
| `APP_ORIGIN` | – | Public origin of the app (cookies etc). |
| `LEGACY_TRACKER_COMPAT` | – | Whether the ingest endpoint still honors the pre-rebrand `x-mega-end` header alongside `x-ps-end` (default `true`). Set to `false` once nothing sends the old header anymore. |
| `SUMMARIZER_URL` | – | URL of the [summarizer service](summarizer/README.md) (OpenAI-compatible). Unset = AI intent summaries off; deterministic narratives still work. |
| `SUMMARIZER_MODEL_LABEL` | – | Label stored with each AI summary (e.g. `qwen3.5-4b-q4km`), useful once you fine-tune. |

\* Provide **either** `ADMIN_EMAIL`+`ADMIN_PASSWORD` **or** `ADMINS_CREDS`. Generate strong secrets with `openssl rand -base64 32`.

## Privacy modes

| Mode | Behavior |
| --- | --- |
| `default` | Records normally. |
| `mask_all_inputs` | Masks every `<input>` / `<textarea>` value. |
| `strict` | Masks all inputs **and** any element carrying `data-ps-mask` (or the pre-rebrand `data-mega-mask`, still honored). |

## Deployment

The repo ships a production `Dockerfile`. The container's start command runs migrations then the server:

```
node scripts/migrate.mjs && node server.js
```

Migrations apply automatically on every deploy, before the server starts serving — no separate step. Health check at `/api/health`.

**Railway:** a `railway.toml` is included (Dockerfile builder, health check, auto-migrate start command).

```bash
railway up
```

## Testing

```bash
npm test         # unit tests (vitest) — DB-dependent tests skip unless DATABASE_URL is reachable
npm run lint      # eslint
npm run build     # production build + type-check
npm run test:e2e  # Playwright
```

## Contributing

Contributions welcome! Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues: [SECURITY.md](SECURITY.md), not a public issue.

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) © 2026 Matan Avitan — free for personal, educational, and other noncommercial use. For commercial licensing, contact the author.
