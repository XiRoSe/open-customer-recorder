# Contributing to PocketScience

Thanks for your interest in contributing! This document explains how to get set
up and what we expect in a pull request.

## Getting set up

1. Fork and clone the repo.
2. `npm install`
3. `cp .env.example .env.local` and fill in the values (you'll need a Postgres
   database for the app and for the DB-backed tests).
4. `npm run db:migrate`
5. `npm run dev`

## Before you open a PR

Please make sure these pass locally:

```bash
npm test          # unit tests (vitest)
npm run lint      # eslint
npm run build     # production build + type-check
```

- **Tests:** we practice test-driven development. New features and bug fixes
  should come with tests. DB-backed tests skip automatically when `DATABASE_URL`
  isn't set, so set it locally to run the full suite.
- **Scope:** keep PRs focused. Unrelated refactors are harder to review.
- **The tracker wire protocol** (header/storage names, the `ps_*` identifiers,
  the `PocketScience` global) is a compatibility surface — don't rename these
  without a clear migration story, since deployed trackers depend on them.
  When this was rebranded from `mega_*`/`MegaRecorder`, the pre-rebrand names
  stayed supported as aliases/fallbacks (see the README's wire protocol
  section) rather than being dropped outright — follow that pattern for any
  future rename too.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add per-project retention override
fix: stop dropping Meta+FullSnapshot on heavy first flushes
docs: clarify privacy modes in the README
```

## Branching & PRs

1. Create a branch from `main` (`feat/...`, `fix/...`, `docs/...`).
2. Make your change with tests.
3. Open a PR against `main` and fill in the template.
4. A maintainer will review. Be ready to discuss and iterate.

## Reporting bugs & requesting features

Use the GitHub issue templates. For security issues, **do not** open a public
issue — see [SECURITY.md](SECURITY.md).

By contributing, you agree that your contributions are licensed under the
project's [PolyForm Noncommercial License 1.0.0](LICENSE).
