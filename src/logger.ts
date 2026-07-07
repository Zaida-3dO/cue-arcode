// Minimal level-filtered logger. Deliberately not a dependency (pino/winston)
// — this app is small enough that a ~30-line logger is easier to reason
// about than configuring a logging library.

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LEVELS)[number];

function levelIndex(level: string): number {
  const idx = LEVELS.indexOf(level as LogLevel);
  return idx === -1 ? 1 /* default: info */ : idx;
}

export function createLogger(minLevel: string) {
  const threshold = levelIndex(minLevel);

  function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (levelIndex(level) < threshold) return;
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}`;
    const out = level === 'error' || level === 'warn' ? console.error : console.log;
    if (meta && Object.keys(meta).length > 0) {
      out(line, meta);
    } else {
      out(line);
    }
  }

  return {
    debug: (msg: string, meta?: Record<string, unknown>) => log('debug', msg, meta),
    info: (msg: string, meta?: Record<string, unknown>) => log('info', msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => log('warn', msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, meta),
  };
}

export type Logger = ReturnType<typeof createLogger>;
