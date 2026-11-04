/**
 * Trang trên máy worker: bảng trạng thái, đọc log nối tiếp, link sang worker khác, máy chủ chỉ cho máy này, và runWorker
 * hiện đúng việc đang chạy / vừa xong.
 */
import type { Capabilities } from '@ag-farm/protocol';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer, get } from 'node:http';
import * as os from 'node:os';
import { join } from 'node:path';
import {
  LocalStatusBoard,
  isLocalHost,
  listLogFiles,
  logFilePath,
  readLogChunk,
  readPeers,
  startLocalUi,
} from './local-ui';
import { rootLogger } from './logger';

function makeTmpDir(): string {
  const d = join(os.tmpdir(), `test-local-ui-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(50);
  }
}

/** GET với Host tuỳ chọn (fetch không cho đặt Host). */
function rawGet(url: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    get(url, host ? { headers: { host } } : {}, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    }).on('error', reject);
  });
}

const job = {
  id: '123e4567-e89b-42d3-a456-000000000001',
  type: 'scan.extract',
  owner: 'ag-go',
  lane: 'batch',
  attempt: 1,
} as const;

describe('LocalStatusBoard', () => {
  it('moves a job from running to recent with its progress and outcome', () => {
    let t = Date.parse('2026-11-03T10:00:00Z');
    const board = new LocalStatusBoard(2, () => new Date(t));
    board.jobStarted(job);
    board.jobProgress(job.id, 40, 'extract');
    board.jobProgress(job.id, undefined, 'upload');
    expect(board.snapshot().running).toEqual([
      expect.objectContaining({
        id: job.id,
        percent: 40,
        stage: 'upload',
        started_at: '2026-11-03T10:00:00.000Z',
      }),
    ]);
    t += 5_000;
    board.jobFinished(job.id, 'failed', { code: 'ffmpeg', message: 'bad input' });
    const s = board.snapshot();
    expect(s.running).toEqual([]);
    expect(s.recent[0]).toMatchObject({
      outcome: 'failed',
      finished_at: '2026-11-03T10:00:05.000Z',
      error: { code: 'ffmpeg' },
    });
  });

  it('keeps only the newest finished jobs', () => {
    const board = new LocalStatusBoard(2);
    for (const n of [1, 2, 3]) {
      board.jobStarted({ ...job, id: `j${n}` });
      board.jobFinished(`j${n}`, 'completed');
    }
    expect(board.snapshot().recent.map((j) => j.id)).toEqual(['j3', 'j2']);
  });

  it('shows the last heartbeat error until the next good heartbeat', () => {
    const board = new LocalStatusBoard();
    board.heartbeat(false, new Error('ECONNREFUSED'));
    expect(board.snapshot().heartbeat.error?.message).toContain('ECONNREFUSED');
    board.heartbeat(true);
    expect(board.snapshot().heartbeat).toMatchObject({
      error: null,
      last_ok_at: expect.any(String),
    });
  });
});

describe('readLogChunk', () => {
  let dir: string;
  beforeEach(() => (dir = makeTmpDir()));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the tail first, then only whole new lines', async () => {
    const f = join(dir, 'worker.log');
    writeFileSync(f, 'one\ntwo\n');
    const first = await readLogChunk(f, null);
    expect(first).toEqual({ next: 8, text: 'one\ntwo\n', reset: true });

    appendFileSync(f, 'thr');
    expect(await readLogChunk(f, first.next)).toEqual({ next: 8, text: '', reset: false });
    appendFileSync(f, 'ee\n');
    expect(await readLogChunk(f, first.next)).toEqual({ next: 14, text: 'three\n', reset: false });
  });

  it('starts over when the file was rotated (smaller than where it stopped)', async () => {
    const f = join(dir, 'worker.log');
    writeFileSync(f, 'new\n');
    expect(await readLogChunk(f, 500)).toEqual({ next: 4, text: 'new\n', reset: true });
  });

  it('cuts the tail at a line start', async () => {
    const f = join(dir, 'worker.log');
    writeFileSync(f, 'aaaa\nbbbb\ncccc\n');
    expect(await readLogChunk(f, null, 8)).toEqual({ next: 15, text: 'cccc\n', reset: true });
  });
});

describe('log files', () => {
  it('lists .log files per folder and only resolves those ids', async () => {
    const a = makeTmpDir();
    const b = makeTmpDir();
    try {
      writeFileSync(join(a, 'worker.log'), 'x\n');
      writeFileSync(join(a, 'notes.txt'), 'x');
      writeFileSync(join(b, 'setup.log'), 'y\n');
      const files = await listLogFiles([a, join(a, 'missing'), b]);
      expect(files.map((f) => f.id)).toEqual(['0:worker.log', '2:setup.log']);
      expect(logFilePath([a, b], '1:setup.log')).toBe(join(b, 'setup.log'));
      for (const bad of [
        '0:..\\secret.log',
        '0:../secret.log',
        '5:worker.log',
        '0:notes.txt',
        'worker.log',
        '',
      ]) {
        expect(logFilePath([a, b], bad)).toBeNull();
      }
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('readPeers', () => {
  it('lists other live workers only', () => {
    const dir = makeTmpDir();
    try {
      writeFileSync(
        join(dir, 'pc-scan.json'),
        JSON.stringify({ name: 'pc-scan', url: 'http://127.0.0.1:47811/', pid: 11 }),
      );
      writeFileSync(
        join(dir, 'pc-render.json'),
        JSON.stringify({ name: 'pc-render', url: 'http://127.0.0.1:47812/', pid: 12 }),
      );
      writeFileSync(
        join(dir, 'old.json'),
        JSON.stringify({ name: 'old', url: 'http://127.0.0.1:1/', pid: 13 }),
      );
      writeFileSync(
        join(dir, 'evil.json'),
        JSON.stringify({ name: 'evil', url: 'http://evil.example/', pid: 11 }),
      );
      writeFileSync(join(dir, 'half.json'), '{"name":');
      const peers = readPeers(dir, 'pc-render', (pid) => pid !== 13);
      expect(peers).toEqual([{ name: 'pc-scan', url: 'http://127.0.0.1:47811/', pid: 11 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('startLocalUi', () => {
  it('answers this machine only, read only, and never serves files outside the log folders', async () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'worker.log'), '{"level":"info","msg":"hi"}\n');
    const ui = await startLocalUi({
      port: 0,
      board: new LocalStatusBoard(),
      info: () => ({ name: 'pc-render', version: '1.0.0' }),
      name: 'pc-render',
      logDirs: [dir],
      peersDir: join(dir, 'peers'),
      log: rootLogger,
    });
    try {
      expect(ui).not.toBeNull();
      const port = new URL(ui!.url).port;
      expect(existsSync(join(dir, 'peers', 'pc-render.json'))).toBe(true);

      const page = await fetch(ui!.url);
      expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(await page.text()).toContain('<title>ag-farm worker</title>');

      const status = (await (await fetch(`${ui!.url}api/status`)).json()) as Record<
        string,
        unknown
      >;
      expect(status).toMatchObject({
        name: 'pc-render',
        claim: 'claiming',
        running: [],
        peers: [],
      });

      const chunk = (await (await fetch(`${ui!.url}api/log?file=0%3Aworker.log`)).json()) as {
        text: string;
      };
      expect(chunk.text).toContain('"msg":"hi"');
      expect((await fetch(`${ui!.url}api/log?file=0%3A..%2F..%2Fconfig.yaml`)).status).toBe(404);

      expect((await rawGet(`${ui!.url}api/status`, `evil.example:${port}`)).status).toBe(403);
      expect((await rawGet(`${ui!.url}api/status`, `localhost:${port}`)).status).toBe(200);
      expect((await fetch(`${ui!.url}api/status`, { method: 'POST' })).status).toBe(405);
    } finally {
      await ui?.close();
    }
    expect(existsSync(join(dir, 'peers', 'pc-render.json'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not stop the worker when the port is taken', async () => {
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
    const port = (busy.address() as { port: number }).port;
    try {
      const ui = await startLocalUi({
        port,
        board: new LocalStatusBoard(),
        info: () => ({}),
        name: 'x',
        logDirs: [],
        log: rootLogger,
      });
      expect(ui).toBeNull();
    } finally {
      await new Promise<void>((r) => busy.close(() => r()));
    }
  });

  it('checks the Host header', () => {
    expect(isLocalHost('127.0.0.1:47812', 47812)).toBe(true);
    expect(isLocalHost('LOCALHOST:47812', 47812)).toBe(true);
    expect(isLocalHost('127.0.0.1:47811', 47812)).toBe(false);
    expect(isLocalHost('farm.example.com', 47812)).toBe(false);
    expect(isLocalHost(undefined, 47812)).toBe(false);
  });
});

// ---- runWorker hiện việc trên trang ----

const FAKE_CAPS: Capabilities = {
  os: 'windows',
  cpu_cores: 4,
  ram_mb: 8192,
  gpus: [],
  engines: { ffmpeg: 'ffmpeg version 6.0', ollama_models: [], python: null },
};

function startHub(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }),
    );
  });
}

describe('runWorker - local page', () => {
  it('shows the running job with its progress, then the finished one', async () => {
    const tmpDir = makeTmpDir();
    const stopCtrl = new AbortController();
    let claims = 0;
    const { server, url } = await startHub((req, res) => {
      req.resume();
      req.on('end', () => {
        const path = req.url ?? '';
        res.setHeader('Content-Type', 'application/json');
        if (path.includes('heartbeat')) {
          res.end(
            JSON.stringify({
              node_id: '123e4567-e89b-42d3-a456-426614174000',
              server_time: new Date().toISOString(),
              status: 'active',
            }),
          );
        } else if (path.includes('claim')) {
          claims++;
          res.end(
            JSON.stringify({
              job:
                claims === 1
                  ? {
                      ...job,
                      payload: {
                        asset: {
                          id: '123e4567-e89b-42d3-a456-000000000002',
                          kind: 'video',
                          mime_type: 'video/mp4',
                          size_bytes: null,
                          checksum_sha256: null,
                          duration_ms: null,
                          width: null,
                          height: null,
                        },
                        extract_version: 'v1',
                      },
                      lease_token: 'lease-abc-0000000000000000',
                      lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
                      ticket: 'ticket-1-placeholder-00000000000000',
                      sign_url: `${url}/sign`,
                    }
                  : null,
            }),
          );
        } else if (path.includes('progress')) {
          res.end(
            JSON.stringify({
              lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
              ticket: 'ticket-2',
            }),
          );
        } else {
          res.end('{}');
        }
      });
    });

    const machineFile = join(tmpDir, 'machine.yaml');
    writeFileSync(machineFile, 'cpu_slots: 2\ngpu_slots: 1\n');
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let pageUrl: string | undefined;

    const { runWorker } = await import('./worker');
    const run = runWorker({
      config: {
        hub_url: url,
        token: 'test-token',
        name: 'pc-scan',
        kinds: ['scan.extract'],
        work_dir: join(tmpDir, 'work'),
        cache: { dir: join(tmpDir, 'cache'), max_gb: 1 },
        machine_file: machineFile,
      },
      version: '0.0.1',
      capabilities: FAKE_CAPS,
      heartbeatIntervalMs: 100,
      progressIntervalMs: 50,
      stopSignal: stopCtrl.signal,
      logDirs: [],
      localUi: { port: 0 },
      onLocalUi: (u) => (pageUrl = u),
      handlers: {
        'scan.extract': async (ctx) => {
          ctx.progress(40, 'extract');
          await released;
          return { manifest: 'extract.json', summary: {} };
        },
      },
    });

    try {
      const page = await waitFor(async () => pageUrl);
      expect(existsSync(join(tmpDir, 'local-ui', 'pc-scan.json'))).toBe(true);
      type Status = {
        running: Array<{ id: string; percent: number | null; stage: string | null }>;
        recent: Array<{ outcome: string }>;
        heartbeat: { last_ok_at: string | null };
      };
      const get = async (): Promise<Status> =>
        (await (await fetch(`${page}api/status`)).json()) as Status;

      const busy = await waitFor(async () => {
        const s = await get();
        return s.running[0]?.percent === 40 ? s : undefined;
      });
      expect(busy.running[0]).toMatchObject({ id: job.id, stage: 'extract' });
      expect(busy.heartbeat.last_ok_at).not.toBeNull();

      release();
      const done = await waitFor(async () => {
        const s = await get();
        return s.recent.length > 0 ? s : undefined;
      });
      expect(done.running).toEqual([]);
      expect(done.recent[0]).toMatchObject({ outcome: 'completed' });
    } finally {
      release();
      stopCtrl.abort();
      await run;
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(existsSync(join(tmpDir, 'local-ui', 'pc-scan.json'))).toBe(false);
    rmSync(tmpDir, { recursive: true, force: true });
  }, 15_000);
});
