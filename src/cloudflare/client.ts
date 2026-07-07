// Cloudflare Bulk Redirects API client — server-side only, never exposed to
// the browser. Mirrors this app's SQLite redirect rows into the Cloudflare
// Bulk Redirects List (`cuearcode_redirects`) that a parallel workstream is
// responsible for creating (the List itself, the account ruleset entry
// point, and the `go.jodacreativestudio.com` DNS record). This client only
// CRUDs *items* inside that list — it does not create the list/ruleset/DNS
// record, and it fails gracefully (not with a crash) if the list doesn't
// exist yet.
//
// API sequence per developers.cloudflare.com/rules/url-forwarding/bulk-redirects/:
//   - GET  /accounts/{account}/rules/lists                          -> find list by name (never hardcode the id)
//   - GET  /accounts/{account}/rules/lists/{list_id}/items          -> current items (to find an existing slug's item id)
//   - POST /accounts/{account}/rules/lists/{list_id}/items          -> add item(s), async, returns operation_id
//   - DELETE /accounts/{account}/rules/lists/{list_id}/items        -> remove item(s) by id, async, returns operation_id
//   - GET  /accounts/{account}/rules/lists/bulk_operations/{id}     -> poll an async operation until it completes
//
// Cloudflare Lists don't support "update an item in place" — items are keyed
// by an opaque id, not by source_url — so an "update" is implemented here as
// delete-old-item-if-present + add-new-item, exposed as a single
// `upsertRedirectItem` so callers don't need to know that detail.
import { CLOUDFLARE_LIST_NAME, REDIRECT_HOST } from '../constants.js';
import type { Logger } from '../logger.js';

const API_BASE = 'https://api.cloudflare.com/client/v4';

export interface CloudflareCreds {
  apiToken: string | undefined;
  accountId: string | undefined;
}

export interface CfResult {
  ok: boolean;
  error?: string;
}

interface CfListSummary {
  id: string;
  name: string;
}

interface CfListItem {
  id: string;
  redirect?: {
    source_url: string;
    target_url: string;
    status_code: number;
    preserve_query_string?: boolean;
  };
}

interface CfApiEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
  result_info?: { operation_id?: string };
}

interface CfOperationStatus {
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
}

class CloudflareCredsMissingError extends Error {
  constructor() {
    super('Cloudflare credentials missing (CF_API_TOKEN / CF_ACCOUNT_ID not set)');
    this.name = 'CloudflareCredsMissingError';
  }
}

class CloudflareListNotFoundError extends Error {
  constructor(listName: string) {
    super(
      `Cloudflare Bulk Redirects list '${listName}' not found yet — has the infra ` +
        'workstream created it? (list/ruleset/DNS-record creation is not this app\'s job)',
    );
    this.name = 'CloudflareListNotFoundError';
  }
}

function sourceUrlFor(slug: string): string {
  return `${REDIRECT_HOST}/r/${slug}`;
}

export function createCloudflareClient(creds: CloudflareCreds, logger: Logger) {
  let cachedListId: string | undefined;

  function assertCreds(): { apiToken: string; accountId: string } {
    if (!creds.apiToken || !creds.accountId) {
      throw new CloudflareCredsMissingError();
    }
    return { apiToken: creds.apiToken, accountId: creds.accountId };
  }

  async function cfFetch<T>(path: string, init: RequestInit = {}): Promise<CfApiEnvelope<T>> {
    const { apiToken } = assertCreds();
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
    const body = (await res.json()) as CfApiEnvelope<T>;
    if (!res.ok || !body.success) {
      const msg = body.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') || res.statusText;
      throw new Error(`Cloudflare API error (${res.status}): ${msg}`);
    }
    return body;
  }

  async function getListId(): Promise<string> {
    if (cachedListId) return cachedListId;
    const { accountId } = assertCreds();
    const body = await cfFetch<CfListSummary[]>(`/accounts/${accountId}/rules/lists`);
    const match = body.result.find((l) => l.name === CLOUDFLARE_LIST_NAME);
    if (!match) {
      throw new CloudflareListNotFoundError(CLOUDFLARE_LIST_NAME);
    }
    cachedListId = match.id;
    return match.id;
  }

  async function pollOperation(operationId: string): Promise<void> {
    const { accountId } = assertCreds();
    const maxAttempts = 10;
    const delayMs = 500;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const body = await cfFetch<CfOperationStatus>(
        `/accounts/${accountId}/rules/lists/bulk_operations/${operationId}`,
      );
      if (body.result.status === 'completed') return;
      if (body.result.status === 'failed') {
        throw new Error(`Cloudflare bulk operation ${operationId} failed: ${body.result.error ?? 'unknown error'}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`Cloudflare bulk operation ${operationId} did not complete after ${maxAttempts} polls`);
  }

  async function listItems(): Promise<CfListItem[]> {
    const { accountId } = assertCreds();
    const listId = await getListId();
    // per_page=500 keeps this a single request for the personal-scale volume
    // this app expects; true pagination (result_info.cursor) is not
    // implemented — a known v1 limitation, see build report.
    const body = await cfFetch<CfListItem[]>(
      `/accounts/${accountId}/rules/lists/${listId}/items?per_page=500`,
    );
    return body.result;
  }

  async function addItem(sourceUrl: string, targetUrl: string, statusCode = 302): Promise<void> {
    const { accountId } = assertCreds();
    const listId = await getListId();
    const body = await cfFetch<unknown>(`/accounts/${accountId}/rules/lists/${listId}/items`, {
      method: 'POST',
      body: JSON.stringify([
        {
          redirect: {
            source_url: sourceUrl,
            target_url: targetUrl,
            status_code: statusCode,
            preserve_query_string: false,
          },
        },
      ]),
    });
    const operationId = body.result_info?.operation_id;
    if (operationId) await pollOperation(operationId);
  }

  async function deleteItemsByIds(itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return;
    const { accountId } = assertCreds();
    const listId = await getListId();
    const body = await cfFetch<unknown>(`/accounts/${accountId}/rules/lists/${listId}/items`, {
      method: 'DELETE',
      body: JSON.stringify({ items: itemIds.map((id) => ({ id })) }),
    });
    const operationId = body.result_info?.operation_id;
    if (operationId) await pollOperation(operationId);
  }

  /** Add-or-replace the Cloudflare list item mirroring `slug -> targetUrl`. Never throws. */
  async function upsertRedirectItem(slug: string, targetUrl: string): Promise<CfResult> {
    const sourceUrl = sourceUrlFor(slug);
    try {
      const items = await listItems();
      const existing = items.find((i) => i.redirect?.source_url === sourceUrl);
      if (existing) {
        await deleteItemsByIds([existing.id]);
      }
      await addItem(sourceUrl, targetUrl);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Cloudflare mirror failed for slug '${slug}' — SQLite write already succeeded`, {
        error: message,
      });
      return { ok: false, error: message };
    }
  }

  /** Remove the Cloudflare list item for `slug`, if present. Never throws. */
  async function removeRedirectItem(slug: string): Promise<CfResult> {
    const sourceUrl = sourceUrlFor(slug);
    try {
      const items = await listItems();
      const existing = items.find((i) => i.redirect?.source_url === sourceUrl);
      if (existing) {
        await deleteItemsByIds([existing.id]);
      }
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Cloudflare mirror-delete failed for slug '${slug}' — SQLite delete already succeeded`, {
        error: message,
      });
      return { ok: false, error: message };
    }
  }

  return { getListId, listItems, upsertRedirectItem, removeRedirectItem, sourceUrlFor };
}

export type CloudflareClient = ReturnType<typeof createCloudflareClient>;
