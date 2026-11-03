/**
 * Trang trên máy worker (`local_ui` trong config): http://127.0.0.1:<port> cho người ngồi ở máy xem worker đang làm gì
 * mà không cần web farm: việc đang chạy (loại, bước, tiến độ), việc vừa xong, trạng thái nhận việc, kết nối hub, và log
 * (worker.log, setup.log, updater.log) đọc nối tiếp. Worker chạy dưới SYSTEM (session 0) nên không mở cửa sổ được;
 * trang web là cách người dùng đăng nhập nhìn thấy nó.
 *
 * Chỉ nghe 127.0.0.1, chỉ đọc, kiểm Host (chặn DNS rebinding), không lộ token hay config. Nhiều worker trên một máy
 * (scan, render): mỗi cái ghi `<thư mục machine.yaml>\local-ui\<tên>.json` để trang của cái này có link sang cái kia.
 */
import type { ClaimedJob } from '@ag-farm/protocol';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { LOCAL_UI_PAGE } from './local-ui-page';
import type { Logger } from './logger';

// ---- Việc đang chạy / vừa xong ----

export type LocalJobOutcome = 'completed' | 'failed' | 'aborted' | 'handed_back';

export interface LocalJobView {
  id: string;
  type: string;
  owner: string;
  lane: string;
  attempt: number;
  started_at: string;
  percent: number | null;
  stage: string | null;
  finished_at?: string;
  outcome?: LocalJobOutcome;
  error?: { code: string; message: string };
}

/**
 * Worker đang nhận việc không: `claiming`; hub tắt node (`disabled`); ngoài lịch chạy; đang chờ việc xong để cập nhật
 * (`updating`); đang tắt (`stopping`).
 */
export type LocalClaimState =
  'claiming' | 'disabled' | 'outside_schedule' | 'updating' | 'stopping';

/** Những gì trang hiện, worker cập nhật trong vòng lặp của nó. */
export class LocalStatusBoard {
  claim: LocalClaimState = 'claiming';
  private readonly running = new Map<string, LocalJobView>();
  private readonly recent: LocalJobView[] = [];
  private heartbeatOkAt: string | null = null;
  private heartbeatError: { message: string; at: string } | null = null;

  constructor(
    private readonly maxRecent = 50,
    private readonly now: () => Date = () => new Date(),
  ) {}

  jobStarted(job: Pick<ClaimedJob, 'id' | 'type' | 'owner' | 'lane' | 'attempt'>): void {
    this.running.set(job.id, {
      id: job.id,
      type: job.type,
      owner: job.owner,
      lane: job.lane,
      attempt: job.attempt,
      started_at: this.now().toISOString(),
      percent: null,
      stage: null,
    });
  }

  jobProgress(id: string, percent?: number, stage?: string): void {
    const j = this.running.get(id);
    if (!j) return;
    if (percent !== undefined) j.percent = percent;
    if (stage !== undefined) j.stage = stage;
  }

  jobFinished(
    id: string,
    outcome: LocalJobOutcome,
    error?: { code: string; message: string },
  ): void {
    const j = this.running.get(id);
    if (!j) return;
    this.running.delete(id);
    this.recent.unshift({
      ...j,
      finished_at: this.now().toISOString(),
      outcome,
      ...(error ? { error } : {}),
    });
    if (this.recent.length > this.maxRecent) this.recent.length = this.maxRecent;
  }

  heartbeat(ok: boolean, err?: unknown): void {
    if (ok) {
      this.heartbeatOkAt = this.now().toISOString();
      this.heartbeatError = null;
    } else {
      this.heartbeatError = {
        message: String(err ?? 'unknown error').slice(0, 500),
        at: this.now().toISOString(),
      };
    }
  }

  snapshot(): {
    claim: LocalClaimState;
    heartbeat: { last_ok_at: string | null; error: { message: string; at: string } | null };
    running: LocalJobView[];
    recent: LocalJobView[];
  } {
    return {
      claim: this.claim,
      heartbeat: { last_ok_at: this.heartbeatOkAt, error: this.heartbeatError },
      running: [...this.running.values()].map((j) => ({ ...j })),
      recent: this.recent.map((j) => ({ ...j })),
    };
  }
}

// ---- Đọc log ----

export interface LocalLogFile {
  /** `<chỉ số thư mục>:<tên file>`: trang chỉ chọn được file trong các thư mục log của worker. */
  id: string;
  path: string;
  size: number;
  modified_at: string;
}

/** Các file `.log` trong các thư mục log (thiếu thư mục thì bỏ), mỗi thư mục theo tên. */
export async function listLogFiles(dirs: readonly string[]): Promise<LocalLogFile[]> {
  const out: LocalLogFile[] = [];
  for (let i = 0; i < dirs.length; i++) {
    let names: string[];
    try {
      names = await readdir(dirs[i]!);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.toLowerCase().endsWith('.log')) continue;
      const path = join(dirs[i]!, name);
      try {
        const s = await stat(path);
        if (s.isFile())
          out.push({ id: `${i}:${name}`, path, size: s.size, modified_at: s.mtime.toISOString() });
      } catch {
        // file vừa quay vòng: bỏ
      }
    }
  }
  return out;
}

/** Đường dẫn file của một `id` từ `listLogFiles`, null nếu id lạ (không cho đọc file ngoài thư mục log). */
export function logFilePath(dirs: readonly string[], id: string): string | null {
  const m = /^(\d+):(.+)$/.exec(id);
  if (!m) return null;
  const dir = dirs[Number(m[1])];
  const name = m[2]!;
  if (
    !dir ||
    basename(name) !== name ||
    name.includes('/') ||
    name.includes('\\') ||
    !name.toLowerCase().endsWith('.log')
  ) {
    return null;
  }
  return join(dir, name);
}

export interface LogChunk {
  /** Byte đọc tiếp lần sau (`from`). */
  next: number;
  /** Các dòng đủ (dòng đang ghi dở để lần sau). */
  text: string;
  /** true: không nối tiếp được (lần đầu, file quay vòng, quá nhiều) nên đây là phần cuối file; trang xoá và hiện lại. */
  reset: boolean;
}

/**
 * Phần log từ byte `from`. `from` null hoặc lớn hơn file (file vừa quay vòng): `tailBytes` cuối file, bắt đầu từ đầu
 * một dòng. Phần mới quá `maxBytes` thì chỉ lấy phần cuối.
 */
export async function readLogChunk(
  path: string,
  from: number | null,
  tailBytes = 256 * 1024,
  maxBytes = 1024 * 1024,
): Promise<LogChunk> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    let start: number;
    let reset = false;
    if (from === null || from > size) {
      start = Math.max(0, size - tailBytes);
      reset = true;
    } else {
      start = from;
    }
    if (size - start > maxBytes) {
      start = size - maxBytes;
      reset = true;
    }
    const buf = Buffer.alloc(size - start);
    if (buf.length > 0) await fh.read(buf, 0, buf.length, start);
    let head = 0;
    if (reset && start > 0) {
      const nl = buf.indexOf(0x0a);
      head = nl >= 0 ? nl + 1 : buf.length;
    }
    const lastNl = buf.lastIndexOf(0x0a);
    const end = lastNl >= head ? lastNl + 1 : head;
    return { next: start + end, text: buf.subarray(head, end).toString('utf8'), reset };
  } finally {
    await fh.close();
  }
}

// ---- Các worker khác trên máy ----

export interface LocalUiPeer {
  name: string;
  url: string;
  pid: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function peerFile(dir: string, name: string): string {
  return join(dir, `${name.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
}

/** Trang của các worker khác đang chạy trên máy (file của tiến trình đã chết bị bỏ qua). */
export function readPeers(
  dir: string,
  selfName: string,
  isAlive: (pid: number) => boolean = alive,
): LocalUiPeer[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: LocalUiPeer[] = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.json')) continue;
    try {
      const p = JSON.parse(readFileSync(join(dir, n), 'utf8')) as Partial<LocalUiPeer>;
      if (typeof p.name !== 'string' || typeof p.url !== 'string' || typeof p.pid !== 'number')
        continue;
      if (p.name === selfName || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(p.url) || !isAlive(p.pid))
        continue;
      out.push({ name: p.name, url: p.url, pid: p.pid });
    } catch {
      // file đang ghi dở: bỏ
    }
  }
  return out;
}

// ---- Máy chủ ----

export interface LocalUiOptions {
  port: number;
  board: LocalStatusBoard;
  /** Phần trạng thái đọc lúc trang hỏi (slot rảnh, cập nhật...). */
  info: () => Record<string, unknown>;
  name: string;
  logDirs: readonly string[];
  /** Thư mục ghi / đọc trang của các worker trên máy (`<thư mục machine.yaml>\local-ui`); thiếu thì không có link. */
  peersDir?: string;
  log: Logger;
}

export interface LocalUiHandle {
  url: string;
  close(): Promise<void>;
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

const PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'";

function send(
  res: ServerResponse,
  status: number,
  body: string,
  type: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
}

/** Host của request là máy này đúng cổng (127.0.0.1, localhost, [::1]); tên miền lạ trỏ về 127.0.0.1 thì từ chối. */
export function isLocalHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase());
}

/**
 * Mở trang. Cổng bận hay không mở được thì ghi cảnh báo và trả null: worker vẫn chạy bình thường.
 * `port: 0` (tests) lấy cổng trống bất kỳ.
 */
export async function startLocalUi(o: LocalUiOptions): Promise<LocalUiHandle | null> {
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(err) });
      else res.end();
    });
  });

  let port = o.port;
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLocalHost(req.headers.host, port))
      return sendJson(res, 403, { error: 'local access only' });
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'read only' });
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    switch (url.pathname) {
      case '/':
        return send(res, 200, LOCAL_UI_PAGE, 'text/html; charset=utf-8', {
          'Content-Security-Policy': PAGE_CSP,
        });
      case '/api/status':
        return sendJson(res, 200, {
          ...o.info(),
          ...o.board.snapshot(),
          now: new Date().toISOString(),
          peers: o.peersDir
            ? readPeers(o.peersDir, o.name).map(({ name, url: u }) => ({ name, url: u }))
            : [],
        });
      case '/api/log-files':
        return sendJson(res, 200, { files: await listLogFiles(o.logDirs) });
      case '/api/log': {
        const path = logFilePath(o.logDirs, url.searchParams.get('file') ?? '');
        if (!path) return sendJson(res, 404, { error: 'unknown log file' });
        const fromText = url.searchParams.get('from');
        const from = fromText !== null && /^\d+$/.test(fromText) ? Number(fromText) : null;
        try {
          return sendJson(res, 200, await readLogChunk(path, from));
        } catch (err) {
          return sendJson(res, 404, { error: String(err) });
        }
      }
      default:
        return sendJson(res, 404, { error: 'not found' });
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(o.port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    o.log.warn('Local page not started (port busy?)', { port: o.port, err: String(err) });
    return null;
  }
  port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/`;
  server.on('error', (err) => o.log.warn('Local page error', { err: String(err) }));

  let registered: string | null = null;
  if (o.peersDir) {
    try {
      mkdirSync(o.peersDir, { recursive: true });
      registered = peerFile(o.peersDir, o.name);
      writeFileSync(registered, JSON.stringify({ name: o.name, url, pid: process.pid }));
    } catch (err) {
      registered = null;
      o.log.warn('Could not register the local page for other workers', { err: String(err) });
    }
  }
  o.log.info('Local page on', { url });

  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        if (registered) rmSync(registered, { force: true });
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
