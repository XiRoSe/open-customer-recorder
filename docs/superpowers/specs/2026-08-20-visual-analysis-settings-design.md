# Visual Session Analysis + Settings Page

**Date:** 2026-08-20
**Status:** Approved (Matan: "every session but a light method" + settings page with toggles and stats)
**Builds on:** `2026-08-20-session-narratives-design.md`

## Goal

1. **Visual interpretation for every session, cheaply.** The LLM sees what the
   visitor saw — screenshots of key replay moments — and folds visual
   observations into the existing intent summary. One LLM call, not two.
2. **Settings page** (`/settings`): admin toggles for the pipeline features +
   general stats.

## Visual analysis — the light method

- **Same model, same service.** Qwen3.5-4B is vision-capable; its GGUF repo
  ships `mmproj` adapters. Summarizer Dockerfile adds the mmproj file +
  `LLAMA_ARG_MMPROJ`. The OpenAI-compatible API then accepts
  `image_url` (base64 data URI) content parts.
- **Frames, not video.** `lib/session-frames.ts` loads the rrweb replay in
  headless Chromium **paused**, `goto(t)`s to at most **2 moments**, and
  screenshots 800×450 JPEGs (quality 70). No real-time playback, no ffmpeg.
  - Moment selection (`pickFrameMoments(digest)`, pure, unit-tested): the
    first insight moment if any (rage/dead/abandon — what went wrong),
    else mid-session; plus the final activity moment (what they left on).
  - A **lazy singleton browser** (launched once per process, context per
    render) removes the ~3s launch cost per session.
  - The replay HTML builder moves from the video route into
    `lib/replay-html.ts`, shared by both.
- **Worker integration:** claim now returns `session_id`; if visual analysis
  is enabled, the worker renders frames and attaches them to the SAME
  chat completion as the digest. Frame render failure ⇒ text-only call
  (never blocks a summary). System prompt gains a line about screenshots —
  kept byte-identical in `scripts/export-training-data.mjs`.
- **Budget:** ~3-5s render + ~15-25s multimodal completion ≈ 20-30s/session,
  ~150/hour ceiling — comfortably above current traffic.

## Settings

New table `app_settings` (one row per org, defaults = all on):

| column | type |
|---|---|
| orgId | uuid unique FK cascade |
| summariesEnabled | boolean default true — sweep produces digests/narratives |
| intentEnabled | boolean default true — LLM drain runs |
| visualEnabled | boolean default true — frames attached to LLM call |
| updatedAt | timestamptz |

`lib/app-settings.ts`: `getAppSettings()` (single-org product — first org,
defaults when no row) and `updateAppSettings(patch)`. Sweep checks
`summariesEnabled`; drain checks `intentEnabled`; worker checks
`visualEnabled`. `SUMMARIZER_URL` unset still hard-disables the LLM layer.

## Settings page (`/settings`)

- Header gets a **Settings** link (next to Log out).
- Toggles for the three flags (client component → `PUT /api/admin/settings`).
- **General stats** (server-rendered):
  - Sessions: total, last 24h, average duration, storage used (Σ blobBytes)
  - Summaries: done / pending / failed, % with intent text
  - Insights: counts per kind across all sessions (SQL over the jsonb)

## API

`app/api/admin/settings/route.ts`: `GET` → `{ settings }`,
`PUT` `{ summariesEnabled?, intentEnabled?, visualEnabled? }` → upsert,
org-scoped via `readSessionCookie`.

## Testing

- `pickFrameMoments` pure unit tests (insight-first, mid-session fallback, cap 2).
- `lib/app-settings.test.ts` DB tests: defaults without row, upsert patch.
- Worker test: with `visualEnabled` and a stubbed frame renderer, the fetch
  body contains `image_url` parts; with it off, text-only. (Frame renderer
  itself is exercised in production validation, not CI — needs Chromium.)
- Settings API route tests (cookie-mock pattern).

## Non-goals

- Storing rendered frames (regenerate on demand; no image blobs in Postgres).
- A second "visual" text column — visual observations land inside intentText.
- Multi-org settings UI (single-org product today).
