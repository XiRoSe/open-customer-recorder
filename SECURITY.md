# Security Policy

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub issues.

Instead, email **anihamail@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if possible),
- any suggested remediation.

You'll get an acknowledgment as soon as possible. Please give us a reasonable
window to investigate and ship a fix before any public disclosure.

## Supported versions

This project is pre-1.0 and moves quickly. Security fixes are applied to the
latest `main`. If you're self-hosting, track `main` (or tagged releases once
they exist) to stay current.

## Hardening notes for self-hosters

- Set strong, unique `JWT_SECRET` and `INGEST_TOKEN_SECRET` values (32+ bytes).
- Use a strong admin password / `ADMINS_CREDS`, and serve the app over HTTPS.
- Session recordings can contain sensitive data — use the `mask_all_inputs` or
  `strict` privacy modes and restrict who can access the dashboard.
