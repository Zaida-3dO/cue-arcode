# CueArcode

QR code generator + dynamic-redirect management console.

- **Redirects** — CRUD a slug → target URL map, backed by SQLite as the app's own source of truth, mirrored (best-effort) into a **Cloudflare Bulk Redirects List** so scans resolve at Cloudflare's edge (`https://go.jodacreativestudio.com/r/<slug>`, HTTP 302 — deliberately mutable, not a permanent redirect).
- **QR styling** — a full manual-control QR studio (dot shape/color, corner-eye shape/color, background, overall image radius, an independent image border, padding, error-correction level, a center icon with PNG/JPG/SVG import, contrast + logo-coverage guardrails, and a programmatic "Test Scan" decode-verify) built on [`qr-code-styling`](https://github.com/kozakdenys/qr-code-styling) + [`jsQR`](https://github.com/cozmo/jsQR), vendored into the served bundle (no CDN dependency at runtime).
- **Style history** — every "Save" writes a new versioned row per slug (never overwrites), so past styles stay viewable and restorable.

## Stack

Node.js + TypeScript (strict), Express, SQLite (`better-sqlite3`), a vanilla-TS frontend bundled with `esbuild` (no framework), `vitest` for tests, ESLint (TS-aware).

## Run locally

```bash
npm install
cp .env.example .env   # fill in real values, or leave placeholders — Cloudflare
                        # mirroring degrades gracefully (see below) if unset
npm run dev             # starts the backend (tsx watch) + frontend bundler (esbuild --watch)
```

Then open `http://localhost:7900`.

Other scripts:

```bash
npm run build      # tsc (backend) + esbuild (frontend) -> dist/ + public/bundle.js
npm start           # run the built server (after npm run build)
npm test            # vitest
npm run typecheck   # tsc --noEmit, backend + frontend tsconfigs
npm run lint         # eslint
```

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `CF_API_TOKEN` | Cloudflare API token (Bulk URL Redirects + DNS edit scope) | — |
| `CF_ACCOUNT_ID` | Cloudflare account id | — |
| `CF_ZONE_ID_JODACREATIVESTUDIO` | Cloudflare zone id for `jodacreativestudio.com` | — |
| `CUEARCODE_HOST` | Bind host | `0.0.0.0` |
| `CUEARCODE_PORT` | Bind port | `7900` |
| `CUEARCODE_DB_PATH` | SQLite file path | `./data/cuearcode.db` |
| `CUEARCODE_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` | `info` |

If the Cloudflare credentials are missing, or the `cuearcode_redirects` Bulk Redirects List doesn't exist yet (it's created by a separate infra workstream, not this app), redirect CRUD still writes to SQLite — the Cloudflare mirror step just reports `{ ok: false, error }` in the API response instead of throwing. The app never crashes because Cloudflare isn't reachable/ready.

## Docker image

Built via the multi-stage `Dockerfile` (TypeScript build stage → slim `node:22-slim` runtime, non-root user). See `DEPLOY.md` for the exact env vars, port, and volume mount a deploy needs.

CI (`.github/workflows/ci.yml`) runs on every push/PR to `main`: typecheck, tests, lint, and a Docker build dry-run — all required to pass. Release (`.github/workflows/release.yml`) is a manual `workflow_dispatch` that tags, builds, and pushes `ghcr.io/<owner>/cue-arcode:latest` + the version tag.
