# Deploy notes

For whoever wires this into the shared NAS `docker-compose.yml` — the exact facts needed:

## Image

`ghcr.io/<owner>/cue-arcode:latest` (published by `.github/workflows/release.yml`, manual `workflow_dispatch`).

## Port

Container listens on **7900** internally (fixed). Map to whatever host port is free (`7900` recommended, matching the joda-creative-studio compose project — confirm no collision with the existing services: 4828, 7433, 8123, 8443, 18789, 32400, 2283, 5055).

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `CF_API_TOKEN` | yes (for Cloudflare mirroring to work — app still runs without it) | scoped token: Account → Bulk URL Redirects → Edit, Zone → DNS → Edit |
| `CF_ACCOUNT_ID` | yes | `<your-cf-account-id>` (Cloudflare dashboard → Account Home → Account ID) |
| `CF_ZONE_ID_JODACREATIVESTUDIO` | yes | `<your-cf-zone-id>` (Cloudflare dashboard → the zone → Overview → Zone ID) |
| `CUEARCODE_HOST` | no | default `0.0.0.0` |
| `CUEARCODE_PORT` | no | default `7900` — do not change unless the container's internal port mapping also changes |
| `CUEARCODE_DB_PATH` | no | default `/app/data/cuearcode.db` — must live under the volume mount below |
| `CUEARCODE_LOG_LEVEL` | no | default `info` |

Per this app's build task, secrets should **not** live in this repo's own `.env` at deploy time — the intended pattern (matching `fynance`/`joda-creative-studio`) is to keep the real values in the shared, never-committed `X:\projects\.env`, referenced by `X:\projects\docker-compose.yml`. That migration is a separate stage's job, not this app's.

## Volume mount

`/app/data` — holds `cuearcode.db` (the SQLite source of truth: redirects + versioned style history). Mount a host directory here so data survives container recreation, e.g.:

```yaml
volumes:
  - ${CUEARCODE_LOCATION}/data:/app/data
```

## Health check

`GET /health` returns `{ "ok": true, "redirectBase": "https://go.jodacreativestudio.com/r" }`.
