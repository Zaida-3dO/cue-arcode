import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

describe('redirects API (integration, real HTTP + in-memory SQLite)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.CUEARCODE_DB_PATH = ':memory:';
    delete process.env.CF_API_TOKEN;
    delete process.env.CF_ACCOUNT_ID;
    // Imported after env is set, since createApp() reads process.env at call time.
    const { createApp } = await import('../src/server.js');
    const { app } = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('GET /health reports ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('rejects an invalid slug on create', async () => {
    const res = await fetch(`${baseUrl}/api/redirects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'Not Valid!', target_url: 'https://example.com' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid target_url on create', async () => {
    const res = await fetch(`${baseUrl}/api/redirects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'bad-url', target_url: 'not-a-url' }),
    });
    expect(res.status).toBe(400);
  });

  it('creates, lists, updates, and deletes a redirect end to end', async () => {
    const createRes = await fetch(`${baseUrl}/api/redirects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'review-etsy', target_url: 'https://www.etsy.com/your/purchases' }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      redirect: { slug: string; redirect_url: string; display_name: string };
      cloudflare: { ok: boolean; error?: string };
    };
    expect(created.redirect.slug).toBe('review-etsy');
    expect(created.redirect.redirect_url).toBe('https://go.jodacreativestudio.com/r/review-etsy');
    // display_name omitted on create -> defaults to the slug.
    expect(created.redirect.display_name).toBe('review-etsy');
    // No CF creds in this test environment — the app must degrade gracefully, not crash.
    expect(created.cloudflare.ok).toBe(false);

    const dupeRes = await fetch(`${baseUrl}/api/redirects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'review-etsy', target_url: 'https://example.com' }),
    });
    expect(dupeRes.status).toBe(409);

    const listRes = await fetch(`${baseUrl}/api/redirects`);
    const list = (await listRes.json()) as { redirects: Array<{ slug: string }> };
    expect(list.redirects.some((r) => r.slug === 'review-etsy')).toBe(true);

    const updateRes = await fetch(`${baseUrl}/api/redirects/review-etsy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_url: 'https://www.etsy.com/your/favorites' }),
    });
    expect(updateRes.status).toBe(200);

    const getRes = await fetch(`${baseUrl}/api/redirects/review-etsy`);
    const got = (await getRes.json()) as { redirect: { target_url: string } };
    expect(got.redirect.target_url).toBe('https://www.etsy.com/your/favorites');

    const deleteRes = await fetch(`${baseUrl}/api/redirects/review-etsy`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(200);

    const afterDeleteRes = await fetch(`${baseUrl}/api/redirects/review-etsy`);
    expect(afterDeleteRes.status).toBe(404);
  });

  it('accepts an explicit display_name on create and updates it independently via PUT', async () => {
    const createRes = await fetch(`${baseUrl}/api/redirects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'display-name-test',
        target_url: 'https://example.com/a',
        display_name: 'My Nice Label',
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { redirect: { display_name: string; target_url: string } };
    expect(created.redirect.display_name).toBe('My Nice Label');

    // Update display_name only — target_url must be untouched.
    const updateRes = await fetch(`${baseUrl}/api/redirects/display-name-test`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'Renamed Label' }),
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as { redirect: { display_name: string; target_url: string } };
    expect(updated.redirect.display_name).toBe('Renamed Label');
    expect(updated.redirect.target_url).toBe('https://example.com/a');
  });

  it('rejects a display_name containing HTML metacharacters (stored-XSS guard)', async () => {
    const res = await fetch(`${baseUrl}/api/redirects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'display-name-xss',
        target_url: 'https://example.com',
        display_name: '"><script>alert(1)</script>',
      }),
    });
    expect(res.status).toBe(400);
    const getRes = await fetch(`${baseUrl}/api/redirects/display-name-xss`);
    expect(getRes.status).toBe(404);
  });

  it('rejects a display_name over the length cap', async () => {
    const res = await fetch(`${baseUrl}/api/redirects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'display-name-too-long',
        target_url: 'https://example.com',
        display_name: 'x'.repeat(201),
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an attempt to change slug via PUT (slug is immutable)', async () => {
    await fetch(`${baseUrl}/api/redirects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'immutable-slug', target_url: 'https://example.com/a' }),
    });

    const res = await fetch(`${baseUrl}/api/redirects/immutable-slug`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'a-different-slug', target_url: 'https://example.com/b' }),
    });
    expect(res.status).toBe(400);

    // Original row untouched, and no new row was created under the smuggled slug.
    const original = await fetch(`${baseUrl}/api/redirects/immutable-slug`);
    expect(original.status).toBe(200);
    const smuggled = await fetch(`${baseUrl}/api/redirects/a-different-slug`);
    expect(smuggled.status).toBe(404);
  });

  it('rejects a PUT with neither target_url nor display_name', async () => {
    await fetch(`${baseUrl}/api/redirects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'empty-put-test', target_url: 'https://example.com' }),
    });

    const res = await fetch(`${baseUrl}/api/redirects/empty-put-test`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('saves and lists versioned style history for a slug', async () => {
    await fetch(`${baseUrl}/api/redirects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'style-test', target_url: 'https://example.com' }),
    });

    const save1 = await fetch(`${baseUrl}/api/styles/style-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ style: { dotColor: '#000000' } }),
    });
    expect(save1.status).toBe(201);
    const saved1 = (await save1.json()) as { version: number };
    expect(saved1.version).toBe(1);

    const save2 = await fetch(`${baseUrl}/api/styles/style-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ style: { dotColor: '#ffffff' } }),
    });
    const saved2 = (await save2.json()) as { version: number };
    expect(saved2.version).toBe(2);

    const listRes = await fetch(`${baseUrl}/api/styles/style-test`);
    const versions = (await listRes.json()) as { versions: Array<{ version: number }> };
    expect(versions.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it('rejects a target_url containing HTML metacharacters (stored-XSS guard)', async () => {
    const res = await fetch(`${baseUrl}/api/redirects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'xss-guard',
        target_url: 'https://example.com/"><script>alert(1)</script>',
      }),
    });
    expect(res.status).toBe(400);
    // And nothing was persisted for that slug.
    const getRes = await fetch(`${baseUrl}/api/redirects/xss-guard`);
    expect(getRes.status).toBe(404);
  });

  it('accepts a large style payload with an embedded icon data-URI (body-size limit)', async () => {
    await fetch(`${baseUrl}/api/redirects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'big-style', target_url: 'https://example.com' }),
    });
    // ~300KB base64 data-URI — comfortably larger than Express's default
    // ~100kb JSON body limit, which used to 500 with "request entity too large"
    // whenever an icon was loaded. Must now round-trip and persist.
    const bigDataUri = `data:image/png;base64,${'A'.repeat(300_000)}`;
    const res = await fetch(`${baseUrl}/api/styles/big-style`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ style: { image: bigDataUri } }),
    });
    expect(res.status).toBe(201);
    const saved = (await res.json()) as { version: number; style: { image: string } };
    expect(saved.version).toBe(1);
    expect(saved.style.image.length).toBe(bigDataUri.length);
  });

});
