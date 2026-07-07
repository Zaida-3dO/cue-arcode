// Shared constants. Duplicated (deliberately) in frontend/src/constants.ts —
// this app has no shared package between backend/frontend, and the two
// values below are small and stable enough that duplication is simpler than
// wiring up a shared workspace package for a personal-scale tool.

/** Hostname that serves the public-facing redirects (Cloudflare Bulk Redirects, edge-resolved). */
export const REDIRECT_HOST = 'go.jodacreativestudio.com';

/** Full base URL for a redirect slug: `${REDIRECT_BASE_URL}/<slug>`. */
export const REDIRECT_BASE_URL = `https://${REDIRECT_HOST}/r`;

/** Name of the Cloudflare Bulk Redirects List this app mirrors into. */
export const CLOUDFLARE_LIST_NAME = 'cuearcode_redirects';
