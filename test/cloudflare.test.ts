import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCloudflareClient } from '../src/cloudflare/client.js';
import { createLogger } from '../src/logger.js';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  } as Response;
}

const logger = createLogger('error'); // quiet during tests

describe('createCloudflareClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok:false (never throws) when credentials are missing', async () => {
    const client = createCloudflareClient({ apiToken: undefined, accountId: undefined }, logger);
    const result = await client.upsertRedirectItem('review-etsy', 'https://example.com');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/credentials missing/i);
  });

  it('returns ok:false (never throws) when the Bulk Redirects list does not exist yet', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ success: true, errors: [], result: [] })) as typeof fetch;

    const client = createCloudflareClient({ apiToken: 'tok', accountId: 'acct' }, logger);
    const result = await client.upsertRedirectItem('review-etsy', 'https://example.com');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found yet/i);
  });

  it('upserts an item: adds when no existing item matches the slug', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });

      if (url.endsWith('/rules/lists')) {
        return jsonResponse({ success: true, errors: [], result: [{ id: 'list123', name: 'cuearcode_redirects' }] });
      }
      if (url.includes('/rules/lists/list123/items') && method === 'GET') {
        return jsonResponse({ success: true, errors: [], result: [] });
      }
      if (url.includes('/rules/lists/list123/items') && method === 'POST') {
        return jsonResponse({ success: true, errors: [], result: null, result_info: { operation_id: 'op1' } });
      }
      if (url.includes('/bulk_operations/op1')) {
        return jsonResponse({ success: true, errors: [], result: { status: 'completed' } });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const client = createCloudflareClient({ apiToken: 'tok', accountId: 'acct' }, logger);
    const result = await client.upsertRedirectItem('review-etsy', 'https://www.etsy.com/your/purchases');

    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.method === 'POST')).toBe(true);
    // No DELETE, since no existing item matched.
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('upserts an item: deletes the old item then adds the new one when a match exists', async () => {
    const methodsCalled: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      methodsCalled.push(method);

      if (url.endsWith('/rules/lists')) {
        return jsonResponse({ success: true, errors: [], result: [{ id: 'list123', name: 'cuearcode_redirects' }] });
      }
      if (url.includes('/rules/lists/list123/items') && method === 'GET') {
        return jsonResponse({
          success: true,
          errors: [],
          result: [
            {
              id: 'item-old',
              redirect: {
                source_url: 'go.jodacreativestudio.com/r/review-etsy',
                target_url: 'https://old.example.com',
                status_code: 302,
              },
            },
          ],
        });
      }
      if (url.includes('/rules/lists/list123/items') && (method === 'POST' || method === 'DELETE')) {
        return jsonResponse({ success: true, errors: [], result: null, result_info: { operation_id: 'op-x' } });
      }
      if (url.includes('/bulk_operations/op-x')) {
        return jsonResponse({ success: true, errors: [], result: { status: 'completed' } });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const client = createCloudflareClient({ apiToken: 'tok', accountId: 'acct' }, logger);
    const result = await client.upsertRedirectItem('review-etsy', 'https://new.example.com');

    expect(result.ok).toBe(true);
    expect(methodsCalled).toContain('DELETE');
    expect(methodsCalled).toContain('POST');
  });

  it('surfaces a failed bulk operation as ok:false rather than throwing', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/rules/lists')) {
        return jsonResponse({ success: true, errors: [], result: [{ id: 'list123', name: 'cuearcode_redirects' }] });
      }
      if (url.includes('/items') && method === 'GET') {
        return jsonResponse({ success: true, errors: [], result: [] });
      }
      if (url.includes('/items') && method === 'POST') {
        return jsonResponse({ success: true, errors: [], result: null, result_info: { operation_id: 'op-fail' } });
      }
      if (url.includes('/bulk_operations/op-fail')) {
        return jsonResponse({ success: true, errors: [], result: { status: 'failed', error: 'boom' } });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    const client = createCloudflareClient({ apiToken: 'tok', accountId: 'acct' }, logger);
    const result = await client.upsertRedirectItem('review-etsy', 'https://example.com');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/failed/i);
  });
});
