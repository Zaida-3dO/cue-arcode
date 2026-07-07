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
      const { slug, target_url } = req.body ?? {};
      if (!isValidSlug(slug)) {
        res.status(400).json({ error: 'slug must match ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$' });
        return;
      }
      if (!isValidTargetUrl(target_url)) {
        res.status(400).json({ error: INVALID_TARGET_URL_MESSAGE });
        return;
      }
      if (db.getRedirect(slug)) {
        res.status(409).json({ error: `Redirect for slug '${slug}' already exists` });
        return;
      }
      const row = db.createRedirect(slug, target_url);
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
      const { target_url } = req.body ?? {};
      if (!isValidTargetUrl(target_url)) {
        res.status(400).json({ error: INVALID_TARGET_URL_MESSAGE });
        return;
      }
      const row = db.updateRedirect(slug, target_url);
      if (!row) {
        res.status(404).json({ error: `No redirect for slug '${slug}'` });
        return;
      }
      const cloudflare = await cf.upsertRedirectItem(slug, target_url);
      if (!cloudflare.ok) {
        logger.warn(`Redirect '${slug}' updated in SQLite but Cloudflare mirror failed`, {
          error: cloudflare.error,
        });
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
