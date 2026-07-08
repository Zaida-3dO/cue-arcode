import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

describe('SPA history-mode routing (catch-all fallback to index.html)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.CUEARCODE_DB_PATH = ':memory:';
    delete process.env.CF_API_TOKEN;
    delete process.env.CF_ACCOUNT_ID;
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

  it('serves the SPA shell for a client-routed detail path', async () => {
    const res = await fetch(`${baseUrl}/redirects/some-slug`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/html/);
    const body = await res.text();
    expect(body).toContain('<title>CueArcode</title>');
    expect(body).toContain('id="view-list"');
  });

  it('serves the SPA shell for the QR studio path', async () => {
    const res = await fetch(`${baseUrl}/redirects/some-slug/qr`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/html/);
  });

  it('serves the SPA shell for /settings', async () => {
    const res = await fetch(`${baseUrl}/settings`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/html/);
  });

  it('does NOT swallow a real API 404 into the SPA shell', async () => {
    const res = await fetch(`${baseUrl}/api/redirects/nonexistent-slug`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/json/);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('nonexistent-slug');
  });

  it('does NOT swallow an unknown /api/ path into the SPA shell', async () => {
    const res = await fetch(`${baseUrl}/api/totally-not-a-route`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('<title>CueArcode</title>');
  });

  it('still 404s a genuinely missing static asset (file-extension path) instead of serving HTML', async () => {
    const res = await fetch(`${baseUrl}/nonexistent.js`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('<title>CueArcode</title>');
  });

  it('still serves a real static asset normally (styles.css)', async () => {
    const res = await fetch(`${baseUrl}/styles.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/css/);
  });
});
