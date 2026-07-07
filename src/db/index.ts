// SQLite persistence layer (better-sqlite3). This is the app's own source of
// truth / audit trail for redirects (mirrored into Cloudflare separately —
// see src/cloudflare/client.ts) and the versioned QR-style history.
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RedirectRow {
  slug: string;
  target_url: string;
  created_at: string;
  updated_at: string;
}

export interface StyleVersionRow {
  id: number;
  slug: string;
  version: number;
  style_json: string;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS redirects (
  slug        TEXT PRIMARY KEY,
  target_url  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS style_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  style_json  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(slug, version)
);

CREATE INDEX IF NOT EXISTS idx_style_history_slug ON style_history(slug);
`;

export type CueArcodeDb = ReturnType<typeof openDb>;

export function openDb(dbPath: string) {
  if (dbPath !== ':memory:') {
    const dir = dirname(dbPath);
    if (dir && dir !== '.' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const stmts = {
    listRedirects: db.prepare<[], RedirectRow>('SELECT * FROM redirects ORDER BY slug ASC'),
    getRedirect: db.prepare<[string], RedirectRow>('SELECT * FROM redirects WHERE slug = ?'),
    insertRedirect: db.prepare(
      'INSERT INTO redirects (slug, target_url, created_at, updated_at) VALUES (@slug, @target_url, @now, @now)',
    ),
    updateRedirect: db.prepare(
      'UPDATE redirects SET target_url = @target_url, updated_at = @now WHERE slug = @slug',
    ),
    deleteRedirect: db.prepare('DELETE FROM redirects WHERE slug = ?'),
    deleteStyleHistoryForSlug: db.prepare('DELETE FROM style_history WHERE slug = ?'),

    listStyleVersions: db.prepare<[string], StyleVersionRow>(
      'SELECT * FROM style_history WHERE slug = ? ORDER BY version DESC',
    ),
    getStyleVersion: db.prepare<[string, number], StyleVersionRow>(
      'SELECT * FROM style_history WHERE slug = ? AND version = ?',
    ),
    getLatestVersionNumber: db.prepare<[string], { maxVersion: number | null }>(
      'SELECT MAX(version) as maxVersion FROM style_history WHERE slug = ?',
    ),
    insertStyleVersion: db.prepare(
      'INSERT INTO style_history (slug, version, style_json, created_at) VALUES (@slug, @version, @style_json, @now)',
    ),
  };

  function listRedirects(): RedirectRow[] {
    return stmts.listRedirects.all();
  }

  function getRedirect(slug: string): RedirectRow | undefined {
    return stmts.getRedirect.get(slug);
  }

  function createRedirect(slug: string, targetUrl: string): RedirectRow {
    const now = new Date().toISOString();
    stmts.insertRedirect.run({ slug, target_url: targetUrl, now });
    const row = getRedirect(slug);
    if (!row) throw new Error(`Failed to read back redirect '${slug}' after insert`);
    return row;
  }

  function updateRedirect(slug: string, targetUrl: string): RedirectRow | undefined {
    const now = new Date().toISOString();
    const result = stmts.updateRedirect.run({ slug, target_url: targetUrl, now });
    if (result.changes === 0) return undefined;
    return getRedirect(slug);
  }

  function deleteRedirect(slug: string): boolean {
    const result = stmts.deleteRedirect.run(slug);
    stmts.deleteStyleHistoryForSlug.run(slug);
    return result.changes > 0;
  }

  function listStyleVersions(slug: string): StyleVersionRow[] {
    return stmts.listStyleVersions.all(slug);
  }

  function getStyleVersion(slug: string, version: number): StyleVersionRow | undefined {
    return stmts.getStyleVersion.get(slug, version);
  }

  function saveStyleVersion(slug: string, styleJson: string): StyleVersionRow {
    const row = stmts.getLatestVersionNumber.get(slug);
    const nextVersion = (row?.maxVersion ?? 0) + 1;
    const now = new Date().toISOString();
    stmts.insertStyleVersion.run({ slug, version: nextVersion, style_json: styleJson, now });
    const saved = getStyleVersion(slug, nextVersion);
    if (!saved) throw new Error(`Failed to read back style version ${nextVersion} for '${slug}'`);
    return saved;
  }

  return {
    raw: db,
    listRedirects,
    getRedirect,
    createRedirect,
    updateRedirect,
    deleteRedirect,
    listStyleVersions,
    getStyleVersion,
    saveStyleVersion,
    close: () => db.close(),
  };
}
