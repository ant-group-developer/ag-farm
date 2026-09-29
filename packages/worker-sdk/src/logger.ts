/**
 * Logger JSON-lines đơn giản.
 * Mỗi dòng là một object JSON: { level, time, msg, ...extra }
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  child(extra: Record<string, unknown>): Logger;
}

function write(level: LogLevel, msg: string, base: Record<string, unknown>, extra?: Record<string, unknown>): void {
  const entry = {
    level,
    time: new Date().toISOString(),
    msg,
    ...base,
    ...extra,
  };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

function createLogger(base: Record<string, unknown> = {}): Logger {
  return {
    debug: (msg, extra) => write('debug', msg, base, extra),
    info: (msg, extra) => write('info', msg, base, extra),
    warn: (msg, extra) => write('warn', msg, base, extra),
    error: (msg, extra) => write('error', msg, base, extra),
    child: (extra) => createLogger({ ...base, ...extra }),
  };
}

export const rootLogger: Logger = createLogger();
