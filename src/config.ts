// Central env-var loading. Reads exact names specified by the deploy spec —
// do not rename these, a later deploy stage maps prefixed host-level names
// onto these exact names inside the container.
import { createLogger } from './logger.js';

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  logLevel: string;
  cloudflare: {
    apiToken: string | undefined;
    accountId: string | undefined;
    zoneIdJodaCreativeStudio: string | undefined;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = {
    host: env.CUEARCODE_HOST ?? '0.0.0.0',
    port: Number(env.CUEARCODE_PORT ?? '7900'),
    dbPath: env.CUEARCODE_DB_PATH ?? './data/cuearcode.db',
    logLevel: env.CUEARCODE_LOG_LEVEL ?? 'info',
    cloudflare: {
      apiToken: env.CF_API_TOKEN,
      accountId: env.CF_ACCOUNT_ID,
      zoneIdJodaCreativeStudio: env.CF_ZONE_ID_JODACREATIVESTUDIO,
    },
  };

  if (!Number.isFinite(config.port) || config.port <= 0) {
    throw new Error(`Invalid CUEARCODE_PORT: ${env.CUEARCODE_PORT}`);
  }

  const logger = createLogger(config.logLevel);
  const { apiToken, accountId } = config.cloudflare;
  if (!apiToken || !accountId) {
    logger.warn(
      'Cloudflare credentials missing (CF_API_TOKEN / CF_ACCOUNT_ID) — redirect CRUD will still ' +
        'write to SQLite but Cloudflare mirroring will be skipped and reported per-request.',
    );
  }

  return config;
}
