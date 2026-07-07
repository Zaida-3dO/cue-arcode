import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

    expect(db.getRedirect('review-etsy')).toMatchObject({ slug: 'review-etsy' });
    expect(db.listRedirects()).toHaveLength(1);

    const updated = db.updateRedirect('review-etsy', 'https://www.etsy.com/your/favorites');
    expect(updated?.target_url).toBe('https://www.etsy.com/your/favorites');

    expect(db.updateRedirect('does-not-exist', 'https://example.com')).toBeUndefined();

    expect(db.deleteRedirect('review-etsy')).toBe(true);
    expect(db.getRedirect('review-etsy')).toBeUndefined();
    expect(db.deleteRedirect('review-etsy')).toBe(false); // already gone
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
