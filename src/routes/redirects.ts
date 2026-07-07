// CRUD for slug <-> target_url. SQLite is this app's own source of
// truth/audit trail; every write also (best-effort) mirrors into Cloudflare
// Bulk Redirects. A Cloudflare mirror failure (e.g. the list doesn't exist
// yet) never blocks or rolls back the SQLite write — it's surfaced back to
// the caller as `cloudflare: { ok: false, error }` so the UI can show it,
// without breaking local CRUD.
import { Router } from 'express';
import type { CueArcodeDb } from '../db/index.js';
import type { CloudflareClient } from '../cloudflare/client.js';
import type { Logger } from '../logger.js';
import { REDIRECT_BASE_URL } from '../constants.js';

const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

function isValidSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SLUG_PATTERN.test(slug);
}

// Characters that have no business in a legitimate http(s) URL (they'd be
// percent-encoded) but that enable HTML/attribute injection if the stored
// value is ever interpolated into markup downstream. Rejecting them at the
// write boundary is defence-in-depth alongside the client rendering via
// textContent — it stops a stored-XSS payload like `"><script>…` from ever
// reaching the database in the first place.
const UNSAFE_URL_CHARS = /[<>"'`\\]/;

function isValidTargetUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0) return false;
  if (UNSAFE_URL_CHARS.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const INVALID_TARGET_URL_MESSAGE =
  'target_url must be a valid http(s) URL and must not contain <, >, quotes or backslashes';

const MAX_DISPLAY_NAME_LENGTH = 200;

const INVALID_DISPLAY_NAME_MESSAGE =
  `display_name must be a non-empty string of at most ${MAX_DISPLAY_NAME_LENGTH} characters ` +
  'and must not contain <, >, quotes or backslashes';

const SLUG_IMMUTABLE_MESSAGE = 'slug is immutable and cannot be changed';

// display_name isn't a URL, so unlike isValidTargetUrl this doesn't attempt
// new URL() parsing — just: non-empty after trim, same unsafe-char rejection
// (defence-in-depth against stored XSS, mirroring isValidTargetUrl above),
// capped length.
function isValidDisplayName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DISPLAY_NAME_LENGTH) return false;
  if (UNSAFE_URL_CHARS.test(name)) return false;
  return true;
}

function withRedirectUrl<T extends { slug: string }>(row: T) {
  return { ...row, redirect_url: `${REDIRECT_BASE_URL}/${row.slug}` };
}

export function createRedirectsRouter(db: CueArcodeDb, cf: CloudflareClient, logger: Logger): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ redirects: db.listRedirects().map(withRedirectUrl) });
  });

  router.get('/:slug', (req, res) => {
    const row = db.getRedirect(req.params.slug);
    if (!row) {
      res.status(404).json({ error: `No redirect for slug '${req.params.slug}'` });
      return;
    }
    res.json({ redirect: withRedirectUrl(row) });
  });

  router.post('/', (req, res, next) => {
    void (async () => {
      const { slug, target_url, display_name } = req.body ?? {};
      if (!isValidSlug(slug)) {
        res.status(400).json({ error: 'slug must match ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$' });
        return;
      }
      if (!isValidTargetUrl(target_url)) {
        res.status(400).json({ error: INVALID_TARGET_URL_MESSAGE });
        return;
      }
      // display_name is optional on create — omitted or blank-after-trim
      // defaults to the slug (server-side, so the DB never holds a null/empty
      // display_name even for rows created before this field existed in the UI).
      if (display_name !== undefined && display_name !== '' && !isValidDisplayName(display_name)) {
        res.status(400).json({ error: INVALID_DISPLAY_NAME_MESSAGE });
        return;
      }
      if (db.getRedirect(slug)) {
        res.status(409).json({ error: `Redirect for slug '${slug}' already exists` });
        return;
      }
      const row = db.createRedirect(slug, target_url, typeof display_name === 'string' ? display_name : undefined);
      const cloudflare = await cf.upsertRedirectItem(slug, target_url);
      if (!cloudflare.ok) {
        logger.warn(`Redirect '${slug}' created in SQLite but Cloudflare mirror failed`, {
          error: cloudflare.error,
        });
      }
      res.status(201).json({ redirect: withRedirectUrl(row), cloudflare });
    })().catch(next);
  });

  router.put('/:slug', (req, res, next) => {
    void (async () => {
      const { slug } = req.params;
      const body = req.body ?? {};
      const { target_url, display_name } = body as { target_url?: unknown; display_name?: unknown };

      // slug is immutable: the existing API never destructured `slug` from
      // the body, so there was no code path to change it — but now that we're
      // touching this handler for display_name, add an explicit guard so a
      // client that tries to smuggle a different slug through gets a clear
      // rejection instead of the field being silently dropped.
      if ('slug' in body && typeof body.slug === 'string' && body.slug !== slug) {
        res.status(400).json({ error: SLUG_IMMUTABLE_MESSAGE });
        return;
      }

      const hasTargetUrl = target_url !== undefined;
      const hasDisplayName = display_name !== undefined;
      if (!hasTargetUrl && !hasDisplayName) {
        res.status(400).json({ error: 'request body must include at least one of target_url, display_name' });
        return;
      }
      if (hasTargetUrl && !isValidTargetUrl(target_url)) {
        res.status(400).json({ error: INVALID_TARGET_URL_MESSAGE });
        return;
      }
      if (hasDisplayName && !isValidDisplayName(display_name)) {
        res.status(400).json({ error: INVALID_DISPLAY_NAME_MESSAGE });
        return;
      }

      const row = db.updateRedirect(slug, {
        targetUrl: hasTargetUrl ? (target_url as string) : undefined,
        displayName: hasDisplayName ? (display_name as string) : undefined,
      });
      if (!row) {
        res.status(404).json({ error: `No redirect for slug '${slug}'` });
        return;
      }

      // Cloudflare mirror is keyed by slug+target only — display_name is
      // local-only, so only mirror when target_url actually changed.
      let cloudflare: { ok: boolean; error?: string } = { ok: true };
      if (hasTargetUrl) {
        cloudflare = await cf.upsertRedirectItem(slug, row.target_url);
        if (!cloudflare.ok) {
          logger.warn(`Redirect '${slug}' updated in SQLite but Cloudflare mirror failed`, {
            error: cloudflare.error,
          });
        }
      }
      res.json({ redirect: withRedirectUrl(row), cloudflare });
    })().catch(next);
  });

  router.delete('/:slug', (req, res, next) => {
    void (async () => {
      const { slug } = req.params;
      const deleted = db.deleteRedirect(slug);
      if (!deleted) {
        res.status(404).json({ error: `No redirect for slug '${slug}'` });
        return;
      }
      const cloudflare = await cf.removeRedirectItem(slug);
      if (!cloudflare.ok) {
        logger.warn(`Redirect '${slug}' deleted in SQLite but Cloudflare mirror-delete failed`, {
          error: cloudflare.error,
        });
      }
      res.json({ ok: true, cloudflare });
    })().catch(next);
  });

  return router;
}
