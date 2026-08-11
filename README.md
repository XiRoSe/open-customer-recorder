# Open Customer Recorder

**Self-hosted session replay — a lightweight, open-source alternative to FullStory / OpenReplay.**

Open Customer Recorder captures real user sessions on your website with
[rrweb](https://github.com/rrweb-io/rrweb), stores them in your own Postgres,
and lets you replay them from a built-in admin dashboard. It's a single Next.js
app — the ingest API and the dashboard ship together — so it's cheap to run and
easy to own end to end.

![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-blue.svg)

> ⚖️ **License: noncommercial use only.** This project is licensed under the
> [PolyForm Noncommercial License 1.0.0](LICENSE) — free to use, modify, and
> self-host for personal, educational, or other noncommercial purposes.
> Commercial use requires a separate license from the author. See
> [LICENSE](LICENSE) for the exact terms.

> ⚠️ **Privacy & consent are your responsibility.** Session replay records what
> users do on your pages. Make sure your usage complies with the laws that apply
> to you (GDPR, CCPA, etc.), use the masking options below, and disclose
> recording in your privacy policy.

---

## Features

- 🎥 **Full session replay** powered by rrweb (DOM mutations, input, scroll, clicks), with a live URL bar that follows the visitor across page loads and SPA route changes.
- 🗄️ **Bring your own Postgres** — events are gzipped and stored inline; no extra object store or volume required.
- 🔒 **Privacy modes** — mask all inputs, or strict masking of any element you tag.
- 🏷️ **Admin-editable tag rules** — tag sessions automatically by URL match (e.g. "reached /signup") or by visit count (e.g. "2nd+ session, same visitor"), each with its own color. New rules apply to existing sessions immediately, no backfill script needed.
- 🚫 **Exclude specific visitors from recording** — stop future sessions from a given browser (e.g. your own team's QA/maintenance traffic) from ever being recorded, enforced server-side at ingest.
- ↕️ **Sortable session & user tables** — click any column header to reorder.
- 👤 **Per-admin "viewed" tracking** — each admin sees which sessions *they* have watched.
- 🎞️ **One-click MP4 export** — server-side render of a replay to mp4 (headless Chromium + ffmpeg).
- 🧹 **Retention & session caps** — automatic pruning of old sessions/zero-event orphans, and a hard per-session duration cap enforced server-side.
- 🐳 **Deploy anywhere** — a standard Dockerfile; migrations run automatically on boot.

## How it works

```
 ┌────────────┐   tracker.js (rrweb)   ┌─────────────────────────────┐
 │ Your site  │ ─────────────────────► │  Open Customer Recorder      │
 │  + <script>│   POST /api/ingest/... │  (Next.js: ingest + admin)   │
 └────────────┘                        │                              │
                                       │   ┌──────────────────────┐   │
        Admin dashboard  ◄──────────── │   │ Postgres (events,    │   │
        /projects, /sessions/[id]      │   │ gzipped blobs inline)│   │
                                       │   └──────────────────────┘   │
                                       └─────────────────────────────┘
```

The browser tracker uses a small **wire protocol** (kept stable for drop-in
script tags): cookie `mega_session`, storage keys `mega_anon_id` /
`mega_session_v2`, header `x-mega-end`, mask attribute `data-mega-mask`, and the
global `window.MegaRecorder`.

## Quick start (local)

**Prerequisites:** Node.js 20+, a Postgres database.

```bash
git clone https://github.com/XiRoSe/open-customer-recorder.git
cd open-customer-recorder
npm install
cp .env.example .env.local        # then edit the values
npm run db:migrate                # apply schema to your Postgres
npm run dev
```

Open <http://localhost:3000>, click **Log in**, and sign in with the
`ADMIN_EMAIL` / `ADMIN_PASSWORD` you set in `.env.local`. A default
organization/project is created on first boot.

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

\* Provide **either** `ADMIN_EMAIL`+`ADMIN_PASSWORD` **or** `ADMINS_CREDS`.

Generate strong secrets with `openssl rand -base64 32`.

## Add the tracker to your site

Each project has a **project key** (visible in the dashboard). Drop one script
tag on the pages you want to record:

```html
<script
  src="https://your-recorder.example.com/tracker.js"
  data-project-key="umsk_xxxxxxxxxxxxxxxxxxxx"
  data-privacy-mode="mask_all_inputs"
></script>
```

Script-tag options (all via `data-*`):

| Attribute | Description |
| --- | --- |
| `data-project-key` | **Required.** Your project key. |
| `data-api-origin` | Recorder origin to send events to (defaults to the script's own origin). |
| `data-privacy-mode` | `default`, `mask_all_inputs`, or `strict`. |

`window.MegaRecorder` is exposed for manual `identify()` / `stop()` calls — see
[`lib/tracker.ts`](lib/tracker.ts) for the exact API. In a bundled app you can
also `import { initRecorder } from './lib/tracker'` directly.

### Privacy modes

| Mode | Behavior |
| --- | --- |
| `default` | Records normally. |
| `mask_all_inputs` | Masks every `<input>` / `<textarea>` value. |
| `strict` | Masks all inputs **and** any element carrying `data-mega-mask`. |

## Deployment

The repo ships a production `Dockerfile`. The container's start command runs
database migrations and then the server:

```
node scripts/migrate.mjs && node server.js
```

So **migrations apply automatically on every deploy**, before the server starts
serving — no separate migration step. A health check is exposed at
`/api/health`.

### Railway

A `railway.toml` is included (Dockerfile builder, `/api/health` health check,
auto-migrate start command). Deploy with the Railway CLI:

```bash
railway up
```

## Testing

```bash
npm test          # unit tests (vitest)
npm run lint      # eslint
npm run build     # production build + type-check
```

Some tests are integration tests that talk to Postgres; they **skip
automatically** unless `DATABASE_URL` points at a reachable database.
End-to-end tests use Playwright: `npm run test:e2e`.

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) and
our [Code of Conduct](CODE_OF_CONDUCT.md). To report a security issue, see
[SECURITY.md](SECURITY.md).

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) © 2026 Matan Avitan — free for
personal, educational, and other noncommercial use. For commercial licensing,
contact the author.
