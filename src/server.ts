import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { openDb } from './db/index.js';
import { createCloudflareClient } from './cloudflare/client.js';
import { createRedirectsRouter } from './routes/redirects.js';
import { createStylesRouter } from './routes/styles.js';
import { REDIRECT_BASE_URL } from './constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const db = openDb(config.dbPath);
  const cf = createCloudflareClient(config.cloudflare, logger);

  const app = express();
  // Style payloads embed the center-icon as a rasterized data-URI, which can be
  // hundreds of KB — well over Express's default ~100kb JSON body limit (that
  // default made POST /api/styles/:slug 500 with "request entity too large"
  // whenever any icon was loaded). 10mb comfortably holds a logo data-URI.
  app.use(express.json({ limit: '10mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, redirectBase: REDIRECT_BASE_URL });
  });

  app.use('/api/redirects', createRedirectsRouter(db, cf, logger));
  app.use('/api/styles', createStylesRouter(db));

  // Static frontend (index.html + styles.css + esbuild-bundled bundle.js).
  const publicDir = join(__dirname, '..', 'public');
  app.use(express.static(publicDir));

  // Centralised error handler — keeps route handlers free of try/catch boilerplate.
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Unhandled request error', { error: message });
      res.status(500).json({ error: 'Internal server error' });
    },
  );

  return { app, config, logger, db };
}

function main() {
  const { app, config, logger } = createApp();
  app.listen(config.port, config.host, () => {
    logger.info(`CueArcode listening on http://${config.host}:${config.port}`, {
      dbPath: config.dbPath,
      redirectBase: REDIRECT_BASE_URL,
    });
  });
}

// Only auto-start when run directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
