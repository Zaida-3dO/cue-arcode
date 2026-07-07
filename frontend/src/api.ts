// Thin fetch wrappers over the backend CRUD API.
export interface RedirectDto {
  slug: string;
  target_url: string;
  redirect_url: string;
  created_at: string;
  updated_at: string;
}

export interface CloudflareResult {
  ok: boolean;
  error?: string;
}

async function asJson<T>(res: Response): Promise<T> {
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return body;
}

export async function listRedirects(): Promise<RedirectDto[]> {
  const res = await fetch('/api/redirects');
  const body = await asJson<{ redirects: RedirectDto[] }>(res);
  return body.redirects;
}

export async function createRedirect(
  slug: string,
  targetUrl: string,
): Promise<{ redirect: RedirectDto; cloudflare: CloudflareResult }> {
  const res = await fetch('/api/redirects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, target_url: targetUrl }),
  });
  return asJson(res);
}

export async function updateRedirect(
  slug: string,
  targetUrl: string,
): Promise<{ redirect: RedirectDto; cloudflare: CloudflareResult }> {
  const res = await fetch(`/api/redirects/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_url: targetUrl }),
  });
  return asJson(res);
}

export async function deleteRedirect(slug: string): Promise<{ ok: boolean; cloudflare: CloudflareResult }> {
  const res = await fetch(`/api/redirects/${encodeURIComponent(slug)}`, { method: 'DELETE' });
  return asJson(res);
}

export interface StyleVersionDto {
  version: number;
  style: unknown;
  created_at: string;
}

export async function listStyleVersions(slug: string): Promise<StyleVersionDto[]> {
  const res = await fetch(`/api/styles/${encodeURIComponent(slug)}`);
  const body = await asJson<{ versions: StyleVersionDto[] }>(res);
  return body.versions;
}

export async function saveStyleVersion(slug: string, style: unknown): Promise<StyleVersionDto> {
  const res = await fetch(`/api/styles/${encodeURIComponent(slug)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ style }),
  });
  return asJson(res);
}
