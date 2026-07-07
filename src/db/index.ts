// SQLite persistence layer (better-sqlite3). This is the app's own source of
// truth / audit trail for redirects (mirrored into Cloudflare separately —
// see src/cloudflare/client.ts) and the versioned QR-style history.
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RedirectRow {
  slug: string;
  target_url: string;
  display_name: string;
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
  slug          TEXT PRIMARY KEY,
  target_url    TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
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

  // `CREATE TABLE IF NOT EXISTS` above does not retroactively add columns to
  // an already-existing `redirects` table (e.g. the deployed NAS container's
  // production DB, created before `display_name` existed). Additive,
  // idempotent migration: check for the column via PRAGMA table_info, add it
  // if missing, then backfill any NULL/empty display_name to the slug. Safe
  // to run on every startup — a no-op once the column exists and is backfilled.
  const columns = db.pragma('table_info(redirects)') as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'display_name')) {
    db.exec("ALTER TABLE redirects ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
  }
  db.exec("UPDATE redirects SET display_name = slug WHERE display_name IS NULL OR display_name = ''");

  const stmts = {
    listRedirects: db.prepare<[], RedirectRow>('SELECT * FROM redirects ORDER BY slug ASC'),
    getRedirect: db.prepare<[string], RedirectRow>('SELECT * FROM redirects WHERE slug = ?'),
    insertRedirect: db.prepare(
      'INSERT INTO redirects (slug, target_url, display_name, created_at, updated_at) ' +
        'VALUES (@slug, @target_url, @display_name, @now, @now)',
    ),
    updateRedirectTargetUrl: db.prepare(
      'UPDATE redirects SET target_url = @target_url, updated_at = @now WHERE slug = @slug',
    ),
    updateRedirectDisplayName: db.prepare(
      'UPDATE redirects SET display_name = @display_name, updated_at = @now WHERE slug = @slug',
    ),
    updateRedirectBoth: db.prepare(
      'UPDATE redirects SET target_url = @target_url, display_name = @display_name, updated_at = @now WHERE slug = @slug',
    ),
    deleteRedirect: db.prepare('DELETE FROM redirects WHERE slug = ?'),
    deleteStyleHistoryForSlug: db.prepare('DELETE FROM style_history WHERE slug = ?'),
    deleteAllStyleHistory: db.prepare('DELETE FROM style_history'),

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

  function createRedirect(slug: string, targetUrl: string, displayName?: string): RedirectRow {
    const now = new Date().toISOString();
    const name = displayName && displayName.trim().length > 0 ? displayName.trim() : slug;
    stmts.insertRedirect.run({ slug, target_url: targetUrl, display_name: name, now });
    const row = getRedirect(slug);
    if (!row) throw new Error(`Failed to read back redirect '${slug}' after insert`);
    return row;
  }

  // At least one of targetUrl/displayName must be provided (enforced by the
  // route layer) — this function updates only the field(s) given.
  function updateRedirect(
    slug: string,
    updates: { targetUrl?: string | undefined; displayName?: string | undefined },
  ): RedirectRow | undefined {
    const now = new Date().toISOString();
    const hasTarget = updates.targetUrl !== undefined;
    const hasDisplayName = updates.displayName !== undefined;
    let result;
    if (hasTarget && hasDisplayName) {
      result = stmts.updateRedirectBoth.run({
        slug,
        target_url: updates.targetUrl,
        display_name: updates.displayName,
        now,
      });
    } else if (hasTarget) {
      result = stmts.updateRedirectTargetUrl.run({ slug, target_url: updates.targetUrl, now });
    } else if (hasDisplayName) {
      result = stmts.updateRedirectDisplayName.run({ slug, display_name: updates.displayName, now });
    } else {
      return getRedirect(slug);
    }
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

  function deleteAllStyleHistory(): number {
    const result = stmts.deleteAllStyleHistory.run();
    return result.changes;
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
    deleteAllStyleHistory,
    close: () => db.close(),
  };
}
