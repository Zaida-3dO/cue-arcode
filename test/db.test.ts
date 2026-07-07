import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type CueArcodeDb } from '../src/db/index.js';

describe('db (redirects + style history)', () => {
  let db: CueArcodeDb;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates, reads, lists, updates, and deletes a redirect', () => {
    expect(db.listRedirects()).toEqual([]);

    const created = db.createRedirect('review-etsy', 'https://www.etsy.com/your/purchases');
    expect(created.slug).toBe('review-etsy');
    expect(created.target_url).toBe('https://www.etsy.com/your/purchases');
    // display_name defaults to the slug when omitted on create.
    expect(created.display_name).toBe('review-etsy');

    expect(db.getRedirect('review-etsy')).toMatchObject({ slug: 'review-etsy' });
    expect(db.listRedirects()).toHaveLength(1);

    const updated = db.updateRedirect('review-etsy', { targetUrl: 'https://www.etsy.com/your/favorites' });
    expect(updated?.target_url).toBe('https://www.etsy.com/your/favorites');
    expect(updated?.display_name).toBe('review-etsy'); // untouched — only target_url was updated

    expect(db.updateRedirect('does-not-exist', { targetUrl: 'https://example.com' })).toBeUndefined();

    expect(db.deleteRedirect('review-etsy')).toBe(true);
    expect(db.getRedirect('review-etsy')).toBeUndefined();
    expect(db.deleteRedirect('review-etsy')).toBe(false); // already gone
  });

  it('accepts an explicit display_name on create, independent of slug', () => {
    const created = db.createRedirect('review-etsy', 'https://www.etsy.com/your/purchases', 'Etsy reviews');
    expect(created.display_name).toBe('Etsy reviews');
    expect(created.slug).toBe('review-etsy');
  });

  it('updates target_url and display_name independently, or together', () => {
    db.createRedirect('review-etsy', 'https://www.etsy.com/your/purchases', 'Etsy reviews');

    const nameOnly = db.updateRedirect('review-etsy', { displayName: 'Etsy — reviews page' });
    expect(nameOnly?.display_name).toBe('Etsy — reviews page');
    expect(nameOnly?.target_url).toBe('https://www.etsy.com/your/purchases'); // untouched

    const both = db.updateRedirect('review-etsy', {
      targetUrl: 'https://www.etsy.com/your/favorites',
      displayName: 'Etsy favorites',
    });
    expect(both?.target_url).toBe('https://www.etsy.com/your/favorites');
    expect(both?.display_name).toBe('Etsy favorites');
  });

  it('versions style history per slug, newest first, and never overwrites', () => {
    db.createRedirect('review-etsy', 'https://www.etsy.com/your/purchases');

    const v1 = db.saveStyleVersion('review-etsy', JSON.stringify({ dotColor: '#000' }));
    expect(v1.version).toBe(1);
    const v2 = db.saveStyleVersion('review-etsy', JSON.stringify({ dotColor: '#fff' }));
    expect(v2.version).toBe(2);

    const versions = db.listStyleVersions('review-etsy');
    expect(versions.map((v) => v.version)).toEqual([2, 1]); // newest first

    const fetched1 = db.getStyleVersion('review-etsy', 1);
    expect(JSON.parse(fetched1?.style_json ?? '{}')).toEqual({ dotColor: '#000' });
    const fetched2 = db.getStyleVersion('review-etsy', 2);
    expect(JSON.parse(fetched2?.style_json ?? '{}')).toEqual({ dotColor: '#fff' });
  });

  it('cascades style_history deletion when a redirect is deleted', () => {
    db.createRedirect('review-etsy', 'https://www.etsy.com/your/purchases');
    db.saveStyleVersion('review-etsy', JSON.stringify({ dotColor: '#000' }));

    db.deleteRedirect('review-etsy');

    expect(db.listStyleVersions('review-etsy')).toEqual([]);
  });

  it('keeps style history independently versioned per slug', () => {
    db.createRedirect('a', 'https://example.com/a');
    db.createRedirect('b', 'https://example.com/b');

    db.saveStyleVersion('a', JSON.stringify({ v: 1 }));
    db.saveStyleVersion('a', JSON.stringify({ v: 2 }));
    db.saveStyleVersion('b', JSON.stringify({ v: 1 }));

    expect(db.listStyleVersions('a')).toHaveLength(2);
    expect(db.listStyleVersions('b')).toHaveLength(1);
  });

});

describe('db migration (display_name backfill on pre-existing databases)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cuearcode-migration-'));
    dbPath = join(dir, 'test.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds the display_name column and backfills it from slug on an old-schema database', () => {
    // Simulate a production DB file created before display_name existed:
    // build the table with the pre-migration schema directly, bypassing
    // openDb()/SCHEMA entirely, and insert rows the way the old app would.
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE redirects (
        slug        TEXT PRIMARY KEY,
        target_url  TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `);
    legacyDb
      .prepare('INSERT INTO redirects (slug, target_url, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('legacy-slug', 'https://example.com/legacy', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    legacyDb.close();

    // Now open it through the real app code path — this must migrate
    // in-place without dropping the existing row.
    const migrated = openDb(dbPath);
    try {
      const columns = migrated.raw.pragma('table_info(redirects)') as Array<{ name: string }>;
      expect(columns.some((c) => c.name === 'display_name')).toBe(true);

      const row = migrated.getRedirect('legacy-slug');
      expect(row?.target_url).toBe('https://example.com/legacy');
      // Backfilled to the slug, since no display_name existed pre-migration.
      expect(row?.display_name).toBe('legacy-slug');
    } finally {
      migrated.close();
    }
  });

  it('is idempotent — reopening an already-migrated database is a no-op that never re-blanks display_name', () => {
    const first = openDb(dbPath);
    first.createRedirect('a', 'https://example.com/a', 'Custom Name');
    first.close();

    const second = openDb(dbPath);
    try {
      const row = second.getRedirect('a');
      expect(row?.display_name).toBe('Custom Name'); // not clobbered back to 'a'
    } finally {
      second.close();
    }
  });
});
