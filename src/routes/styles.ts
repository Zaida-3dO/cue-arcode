// Saved QR style history, versioned per slug. Every save is a NEW row (never
// an overwrite) so past versions stay viewable/regenerable — "restore" is
// just the client re-loading an old version's JSON into the live controls
// and (if the user then hits Save again) that becomes a new version, not a
// mutation of the old one.
import { Router } from 'express';
import type { CueArcodeDb } from '../db/index.js';

export function createStylesRouter(db: CueArcodeDb): Router {
  const router = Router();

  router.get('/:slug', (req, res) => {
    const versions = db.listStyleVersions(req.params.slug);
    res.json({
      versions: versions.map((v) => ({
        version: v.version,
        style: JSON.parse(v.style_json) as unknown,
        created_at: v.created_at,
      })),
    });
  });

  router.get('/:slug/:version', (req, res) => {
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version <= 0) {
      res.status(400).json({ error: 'version must be a positive integer' });
      return;
    }
    const row = db.getStyleVersion(req.params.slug, version);
    if (!row) {
      res.status(404).json({ error: `No style version ${version} for slug '${req.params.slug}'` });
      return;
    }
    res.json({ version: row.version, style: JSON.parse(row.style_json) as unknown, created_at: row.created_at });
  });

  router.post('/:slug', (req, res) => {
    const { style } = req.body ?? {};
    if (style === undefined || style === null || typeof style !== 'object') {
      res.status(400).json({ error: 'body must be { "style": <object> }' });
      return;
    }
    const saved = db.saveStyleVersion(req.params.slug, JSON.stringify(style));
    res.status(201).json({
      version: saved.version,
      style: JSON.parse(saved.style_json) as unknown,
      created_at: saved.created_at,
    });
  });

  return router;
}
