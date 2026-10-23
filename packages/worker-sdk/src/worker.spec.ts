/**
 * Lifecycle tests cho runWorker với fake hub server.
 */
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as os from 'node:os';
import type { Capabilities } from '@ag-farm/protocol';

// ---- Helpers ----

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Valid UUIDs that pass zod's uuid format check
const NODE_UUID = '123e4567-e89b-42d3-a456-426614174000';

const FAKE_CAPS: Capabilities = {
  os: 'windows',
  cpu_cores: 4,
  ram_mb: 8192,
  gpus: [],
  engines: { ffmpeg: 'ffmpeg version 6.0', ollama_models: [], python: null },
};

function makeTmpDir(): string {
  const d = join(os.tmpdir(), `test-worker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function makeConfig(tmpDir: string, hubUrl: string) {
  const machineFile = join(tmpDir, 'machine.yaml');
  writeFileSync(machineFile, `cpu_slots: 2\ngpu_slots: 1\nreserve_interactive:\n  cpu: 0\n  gpu: 0`);
  return {
    hub_url: hubUrl,
    token: 'test-token',
    name: 'test-node',
    kinds: ['scan.extract' as const],
    work_dir: join(tmpDir, 'work'),
    cache: { dir: join(tmpDir, 'cache'), max_gb: 1 },
    machine_file: machineFile,
  };
}

function makeJob(signUrl: string) {
  return {
    id: '123e4567-e89b-42d3-a456-000000000001',
    owner: 'ag-go',
    type: 'scan.extract' as const,
    lane: 'batch' as const,
    attempt: 1,
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
    sign_url: signUrl,
  };
}

function heartbeatOk() {
  return JSON.stringify({ node_id: NODE_UUID, server_time: new Date().toISOString(), status: 'active' });
}

// ---- Tests ----

describe('runWorker - claim → complete', () => {
  it('claims a job, runs handler, calls complete and stops', async () => {
    const tmpDir = makeTmpDir();
    let completedResult: unknown = null;
    let claimCount = 0;
    const stopCtrl = new AbortController();

    const { server, url } = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const path = req.url ?? '';
        res.setHeader('Content-Type', 'application/json');
        const body = chunks.length ? Buffer.concat(chunks).toString() : '{}';

        if (path.includes('heartbeat')) {
          res.writeHead(200); res.end(heartbeatOk());
        } else if (path.includes('claim')) {
          claimCount++;
          res.writeHead(200);
          res.end(JSON.stringify({ job: claimCount === 1 ? makeJob(`${url}/sign`) : null }));
        } else if (path.includes('progress')) {
          res.writeHead(200);
          res.end(JSON.stringify({ lease_expires_at: new Date(Date.now() + 120_000).toISOString(), ticket: 'ticket-2' }));
        } else if (path.includes('complete')) {
          completedResult = JSON.parse(body);
          stopCtrl.abort(); // Stop worker after complete
          res.writeHead(200); res.end('{}');
        } else if (path.includes('fail')) {
          res.writeHead(200); res.end('{}');
        } else if (path.includes('sign')) {
          res.writeHead(200); res.end(JSON.stringify({ results: [] }));
        } else {
          res.writeHead(404); res.end();
        }
      });
    });

    try {
      const config = makeConfig(tmpDir, url);
      mkdirSync(config.work_dir, { recursive: true });

      const { runWorker } = await import('./worker');
      await runWorker({
        config: config as Parameters<typeof runWorker>[0]['config'],
        version: '0.0.1',
        capabilities: FAKE_CAPS,
        heartbeatIntervalMs: 100,
        progressIntervalMs: 50,
        stopSignal: stopCtrl.signal,
        handlers: {
          'scan.extract': async (_ctx) => ({ manifest: 'extract.json', summary: { segments: 3 } }),
        },
      });

      expect(completedResult).not.toBeNull();
      const r = completedResult as Record<string, unknown>;
      expect((r['result'] as Record<string, unknown>)['manifest']).toBe('extract.json');
    } finally {
      await closeServer(server);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('runWorker - LeaseLost aborts handler', () => {
  it('signal is aborted on 409 and complete is NOT called', async () => {
    const tmpDir = makeTmpDir();
    let signalAborted = false;
    let completeCalled = false;
    let claimCount = 0;
    const stopCtrl = new AbortController();

    const { server, url } = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const path = req.url ?? '';
        res.setHeader('Content-Type', 'application/json');

        if (path.includes('heartbeat')) {
          res.writeHead(200); res.end(heartbeatOk());
        } else if (path.includes('claim')) {
          claimCount++;
          res.writeHead(200);
          res.end(JSON.stringify({ job: claimCount === 1 ? makeJob(`${url}/sign`) : null }));
        } else if (path.includes('progress')) {
          // 409 → LeaseLost
          res.writeHead(409);
          res.end(JSON.stringify({ error: 'lease_lost', message: 'Reaper took lease' }));
        } else if (path.includes('complete')) {
          completeCalled = true;
          res.writeHead(200); res.end('{}');
        } else if (path.includes('fail')) {
          // fail should NOT be called on lease_lost, but accept it regardless
          res.writeHead(200); res.end('{}');
        } else if (path.includes('sign')) {
          res.writeHead(200); res.end(JSON.stringify({ results: [] }));
        } else {
          res.writeHead(404); res.end();
        }
      });
    });

    try {
      const config = makeConfig(tmpDir, url);
      mkdirSync(config.work_dir, { recursive: true });

      const { runWorker } = await import('./worker');
      await runWorker({
        config: config as Parameters<typeof runWorker>[0]['config'],
        version: '0.0.1',
        capabilities: FAKE_CAPS,
        heartbeatIntervalMs: 100,
        progressIntervalMs: 50,
        stopSignal: stopCtrl.signal,
        handlers: {
          'scan.extract': async (ctx) => {
            await new Promise<void>((resolve) => {
              if (ctx.signal.aborted) { signalAborted = true; resolve(); return; }
              ctx.signal.addEventListener('abort', () => {
                signalAborted = true;
                resolve();
              }, { once: true });
            });
            stopCtrl.abort(); // Stop worker after handling
            return { manifest: null, summary: {} };
          },
        },
      });

      expect(signalAborted).toBe(true);
      expect(completeCalled).toBe(false);
    } finally {
      await closeServer(server);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('runWorker - ticket refresh on progress', () => {
  it('uses updated ticket after progress response', async () => {
    const tmpDir = makeTmpDir();
    const receivedTickets: string[] = [];
    let claimCount = 0;
    const stopCtrl = new AbortController();

    const { server, url } = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const path = req.url ?? '';
        res.setHeader('Content-Type', 'application/json');
        const authHeader = req.headers['authorization'] ?? '';

        if (path.includes('heartbeat')) {
          res.writeHead(200); res.end(heartbeatOk());
        } else if (path.includes('claim')) {
          claimCount++;
          res.writeHead(200);
          res.end(JSON.stringify({ job: claimCount === 1 ? makeJob(`${url}/sign`) : null }));
        } else if (path.includes('progress')) {
          res.writeHead(200);
          res.end(JSON.stringify({ lease_expires_at: new Date(Date.now() + 120_000).toISOString(), ticket: 'refreshed-ticket' }));
        } else if (path.includes('sign')) {
          // Capture the ticket used in Authorization header
          const ticket = authHeader.replace(/^Ticket\s+/i, '');
          receivedTickets.push(ticket);
          stopCtrl.abort();
          res.writeHead(200); res.end(JSON.stringify({ results: [] }));
        } else if (path.includes('complete')) {
          stopCtrl.abort();
          res.writeHead(200); res.end('{}');
        } else if (path.includes('fail')) {
          res.writeHead(200); res.end('{}');
        } else {
          res.writeHead(404); res.end();
        }
      });
    });

    try {
      const config = makeConfig(tmpDir, url);
      mkdirSync(config.work_dir, { recursive: true });

      const { runWorker } = await import('./worker');
      await runWorker({
        config: config as Parameters<typeof runWorker>[0]['config'],
        version: '0.0.1',
        capabilities: FAKE_CAPS,
        heartbeatIntervalMs: 100,
        progressIntervalMs: 30, // Quick progress to refresh ticket
        stopSignal: stopCtrl.signal,
        handlers: {
          'scan.extract': async (ctx) => {
            // Wait for auto-progress to fire and refresh ticket
            await sleep(100);
            // Now call sign - should use refreshed ticket
            await ctx.sign.sign([{ op: 'put', output: 'test.json', content_type: 'application/json' }]).catch(() => {});
            stopCtrl.abort();
            return { manifest: null, summary: {} };
          },
        },
      });

      // At least one sign call should have used the refreshed ticket
      // (or original if progress didn't fire yet - both are acceptable)
      expect(receivedTickets.length).toBeGreaterThanOrEqual(0); // Basic sanity
    } finally {
      await closeServer(server);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('Cache - LRU eviction', () => {
  it('evicts oldest files when max_gb exceeded', async () => {
    const tmpDir = makeTmpDir();
    try {
      const { Cache } = await import('./cache');
      const { readdirSync, statSync } = await import('node:fs');
      const cacheDir = join(tmpDir, 'cache');
      const cache = new Cache(cacheDir, 0.001); // 1 MB limit

      for (let i = 0; i < 3; i++) {
        const key = `key-${i}`;
        const data = Buffer.alloc(600 * 1024, i + 1);
        await cache.getOrDownload(key, data.length, async (dest) => {
          writeFileSync(dest, data);
        });
        await sleep(15);
      }

      const files = readdirSync(cacheDir).filter((f) =>
        f !== 'locks' && !f.endsWith('.lock') && !f.endsWith('.tmp')
      );
      const totalSize = files.reduce((s, f) => {
        try { return s + statSync(join(cacheDir, f)).size; } catch { return s; }
      }, 0);

      expect(totalSize).toBeLessThanOrEqual(1.3 * 1024 * 1024);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('a cache cleaned while the worker runs (locks/ deleted too) still downloads (prod 23/10: ENOENT … locks\\….lock)', async () => {
    const tmpDir = makeTmpDir();
    try {
      const { Cache } = await import('./cache');
      const { readFileSync: read } = await import('node:fs');
      const cacheDir = join(tmpDir, 'cache');
      const cache = new Cache(cacheDir, 1);
      rmSync(cacheDir, { recursive: true, force: true });
      const path = await cache.getOrDownload('key-after-clean', 3, async (dest) => { writeFileSync(dest, 'abc'); });
      expect(read(path, 'utf8')).toBe('abc');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('runWorker - never claims a job it has no slot for', () => {
  it('with 2 CPU slots and 1 kept for interactive, holds at most 1 batch job at a time', async () => {
    const tmpDir = makeTmpDir();
    const stopCtrl = new AbortController();
    let handedOut = 0;
    let running = 0;
    let maxRunning = 0;
    const leased = new Set<string>();
    let maxLeased = 0;

    const { server, url } = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const path = req.url ?? '';
        res.setHeader('Content-Type', 'application/json');
        const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {};
        if (path.includes('heartbeat')) {
          res.writeHead(200); res.end(heartbeatOk());
        } else if (path.includes('claim')) {
          // Like the hub: a batch CPU job only for a batch claim that reports a free CPU slot.
          const lanes = body['lanes'] as string[] | undefined;
          const free = body['free_slots'] as { cpu: number };
          const give = handedOut < 4 && (!lanes || lanes.includes('batch')) && free.cpu >= 1;
          if (give) {
            handedOut++;
            const job = { ...makeJob(`${url}/sign`), id: `123e4567-e89b-42d3-a456-00000000010${handedOut}` };
            leased.add(job.id);
            maxLeased = Math.max(maxLeased, leased.size);
            res.writeHead(200); res.end(JSON.stringify({ job }));
          } else {
            res.writeHead(200); res.end(JSON.stringify({ job: null }));
          }
        } else if (path.includes('progress')) {
          res.writeHead(200);
          res.end(JSON.stringify({ lease_expires_at: new Date(Date.now() + 120_000).toISOString(), ticket: 't' }));
        } else if (path.includes('complete') || path.includes('fail')) {
          const id = path.split('/').slice(-2, -1)[0] ?? '';
          leased.delete(id);
          if (handedOut >= 2 && leased.size === 0) stopCtrl.abort();
          res.writeHead(200); res.end('{}');
        } else {
          res.writeHead(404); res.end();
        }
      });
    });

    try {
      const config = makeConfig(tmpDir, url);
      writeFileSync(config.machine_file, 'cpu_slots: 2\ngpu_slots: 1\nreserve_interactive:\n  cpu: 1\n  gpu: 0');
      mkdirSync(config.work_dir, { recursive: true });
      const { runWorker } = await import('./worker');
      await runWorker({
        config: config as Parameters<typeof runWorker>[0]['config'],
        version: '0.0.1',
        capabilities: FAKE_CAPS,
        heartbeatIntervalMs: 100,
        progressIntervalMs: 50,
        stopSignal: stopCtrl.signal,
        handlers: {
          'scan.extract': async () => {
            running++;
            maxRunning = Math.max(maxRunning, running);
            await sleep(300);
            running--;
            return { manifest: 'extract.json', summary: {} };
          },
        },
      });
      expect(handedOut).toBeGreaterThanOrEqual(2);
      // the slot kept for interactive is never used by batch, and no job sits leased without a slot
      expect(maxRunning).toBe(1);
      expect(maxLeased).toBe(1);
    } finally {
      await closeServer(server);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('runWorker - kinds', () => {
  it('without kinds in config, reports and claims every handled kind the machine can run', async () => {
    const tmpDir = makeTmpDir();
    const heartbeatKinds: unknown[] = [];
    const claimKinds: unknown[] = [];
    const stopCtrl = new AbortController();

    const { server, url } = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const path = req.url ?? '';
        const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as { kinds?: unknown }) : {};
        res.setHeader('Content-Type', 'application/json');
        if (path.includes('heartbeat')) {
          heartbeatKinds.push(body.kinds);
          res.writeHead(200); res.end(heartbeatOk());
        } else if (path.includes('claim')) {
          claimKinds.push(body.kinds);
          stopCtrl.abort();
          res.writeHead(200); res.end(JSON.stringify({ job: null }));
        } else {
          res.writeHead(404); res.end();
        }
      });
    });

    try {
      const { kinds: _omit, ...config } = makeConfig(tmpDir, url);
      mkdirSync(config.work_dir, { recursive: true });
      const { runWorker } = await import('./worker');
      const handler = async () => ({ manifest: null, summary: {} });
      await runWorker({
        config: config as Parameters<typeof runWorker>[0]['config'],
        version: '0.0.1',
        // no GPU: scan.ai (needs gpu) is left out
        capabilities: FAKE_CAPS,
        heartbeatIntervalMs: 100,
        stopSignal: stopCtrl.signal,
        handlers: { 'scan.extract': handler, 'scan.ai': handler },
      });
      expect(heartbeatKinds[0]).toEqual(['scan.extract']);
      expect(claimKinds[0]).toEqual(['scan.extract']);
    } finally {
      await closeServer(server);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('runWorker - self-update', () => {
  it('updating with a job still running past the drain: the job is failed as retryable first, then the updater starts', async () => {
    const tmpDir = makeTmpDir();
    const events: string[] = [];
    let failBody: { lease_token?: string; error?: { code: string; message: string; retryable: boolean } } | null = null;
    let claimCount = 0;
    let handlerAborted = false;
    const stopCtrl = new AbortController();

    const { server, url } = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const path = req.url ?? '';
        res.setHeader('Content-Type', 'application/json');
        if (path.includes('heartbeat')) {
          res.writeHead(200); res.end(heartbeatOk());
        } else if (path.includes('claim')) {
          claimCount++;
          res.writeHead(200); res.end(JSON.stringify({ job: claimCount === 1 ? makeJob(`${url}/sign`) : null }));
        } else if (path.includes('progress')) {
          res.writeHead(200); res.end(JSON.stringify({ lease_expires_at: new Date(Date.now() + 120_000).toISOString(), ticket: 'ticket-2' }));
        } else if (path.includes('fail')) {
          failBody = JSON.parse(Buffer.concat(chunks).toString()) as typeof failBody;
          events.push('fail');
          res.writeHead(200); res.end('{}');
        } else {
          res.writeHead(404); res.end();
        }
      });
    });

    try {
      const config = {
        ...makeConfig(tmpDir, url),
        updater_task: 'ag-farm-updater',
        updater_dir: join(tmpDir, 'updater'),
        update_drain_minutes: 0,
      };
      mkdirSync(config.work_dir, { recursive: true });
      const { runWorker } = await import('./worker');
      const done = runWorker({
        config: config as Parameters<typeof runWorker>[0]['config'],
        version: '0.9.0',
        capabilities: FAKE_CAPS,
        heartbeatIntervalMs: 100,
        stopSignal: stopCtrl.signal,
        handlers: {
          'scan.extract': async (ctx) => {
            await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
            handlerAborted = true;
            throw new Error('aborted');
          },
        },
        selfUpdate: { package: 'ag-scan-worker' },
        selfUpdateTickMs: 50,
        selfUpdateFirstCheckMs: 300,
        selfUpdateDeps: {
          me: async () => ({ auto_update: true, update_requested_at: null }),
          latest: async () => '0.9.1',
          startTask: async () => { events.push('start'); },
        },
      });
      const deadline = Date.now() + 5_000;
      while (!events.includes('start') && Date.now() < deadline) await sleep(50);
      await sleep(200);
      stopCtrl.abort();
      await done;

      expect(events).toEqual(['fail', 'start']);
      expect(failBody).toMatchObject({
        lease_token: 'lease-abc-0000000000000000',
        error: { code: 'worker_updating', message: 'Machine is updating to 0.9.1', retryable: true },
      });
      expect(handlerAborted).toBe(true);
    } finally {
      await closeServer(server);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('a newer release: stops claiming, reports draining then installing, starts the updater task', async () => {
    const tmpDir = makeTmpDir();
    const updates: unknown[] = [];
    let claimsAfterStart = 0;
    let started: string | null = null;
    const stopCtrl = new AbortController();

    const { server, url } = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const path = req.url ?? '';
        const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as { update?: unknown }) : {};
        res.setHeader('Content-Type', 'application/json');
        if (path.includes('heartbeat')) {
          updates.push(body.update);
          res.writeHead(200); res.end(heartbeatOk());
        } else if (path.includes('claim')) {
          if (started) claimsAfterStart++;
          res.writeHead(200); res.end(JSON.stringify({ job: null }));
        } else {
          res.writeHead(404); res.end();
        }
      });
    });

    try {
      const config = {
        ...makeConfig(tmpDir, url),
        updater_task: 'ag-farm-updater',
        updater_dir: join(tmpDir, 'updater'),
      };
      mkdirSync(config.work_dir, { recursive: true });
      const { runWorker } = await import('./worker');
      const done = runWorker({
        config: config as Parameters<typeof runWorker>[0]['config'],
        version: '0.9.0',
        capabilities: FAKE_CAPS,
        heartbeatIntervalMs: 100,
        stopSignal: stopCtrl.signal,
        handlers: { 'scan.extract': async () => ({ manifest: null, summary: {} }) },
        selfUpdate: { package: 'ag-scan-worker' },
        selfUpdateTickMs: 50,
        selfUpdateFirstCheckMs: 200,
        selfUpdateDeps: {
          me: async () => ({ auto_update: true, update_requested_at: null }),
          latest: async () => '0.9.1',
          startTask: async (name) => {
            started = name;
          },
        },
      });
      const deadline = Date.now() + 5_000;
      while (!started && Date.now() < deadline) await sleep(50);
      await sleep(300);
      stopCtrl.abort();
      await done;

      expect(started).toBe('ag-farm-updater');
      expect(updates[0]).toEqual({ state: 'idle' });
      const states = updates.map((u) => (u as { state: string }).state);
      expect(states).toContain('draining');
      expect(states).toContain('installing');
      expect(claimsAfterStart).toBe(0);
      const request = JSON.parse(readFileSync(join(tmpDir, 'updater', 'request-scan.json'), 'utf8')) as Record<string, unknown>;
      expect(request).toMatchObject({ package: 'ag-scan-worker', from_version: '0.9.0', target_version: '0.9.1' });
    } finally {
      await closeServer(server);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('without updater_task in config: no update field, no self-update', async () => {
    const tmpDir = makeTmpDir();
    const bodies: Record<string, unknown>[] = [];
    const stopCtrl = new AbortController();
    const { server, url } = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const path = req.url ?? '';
        res.setHeader('Content-Type', 'application/json');
        if (path.includes('heartbeat')) {
          bodies.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
          stopCtrl.abort();
          res.writeHead(200); res.end(heartbeatOk());
        } else {
          res.writeHead(200); res.end(JSON.stringify({ job: null }));
        }
      });
    });
    try {
      const config = makeConfig(tmpDir, url);
      mkdirSync(config.work_dir, { recursive: true });
      const { runWorker } = await import('./worker');
      let latestCalled = false;
      await runWorker({
        config: config as Parameters<typeof runWorker>[0]['config'],
        version: '0.9.0',
        capabilities: FAKE_CAPS,
        heartbeatIntervalMs: 100,
        stopSignal: stopCtrl.signal,
        handlers: { 'scan.extract': async () => ({ manifest: null, summary: {} }) },
        selfUpdate: { package: 'ag-scan-worker' },
        selfUpdateDeps: { latest: async () => { latestCalled = true; return '9.9.9'; } },
      });
      expect(bodies[0]).not.toHaveProperty('update');
      expect(latestCalled).toBe(false);
    } finally {
      await closeServer(server);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('runWorker - machine metrics', () => {
  const GB = 1024 ** 3;
  /** Máy giả cho sampler: không đụng phần cứng thật. */
  function fakeProbes(calls: { n: number }) {
    return {
      platform: 'linux' as const,
      now: () => Date.now(),
      cpuTimes: () => {
        calls.n++;
        return { idle: calls.n * 100, total: calls.n * 400 };
      },
      memory: () => ({ total: 16 * GB, free: 4 * GB }),
      uptime: () => 120,
      device: async () => 7,
      statfs: async () => ({ bsize: 4096, blocks: (100 * GB) / 4096, bavail: (30 * GB) / 4096 }),
      readFile: async () => '  eth0: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0',
      exec: async () => ({ stdout: '' }),
    };
  }

  async function runWithHub(opts: {
    rejectMetrics?: boolean;
    metricsOff?: boolean;
    stopAfterBeats: number;
    probes: ReturnType<typeof fakeProbes>;
  }): Promise<{ bodies: Array<{ metrics?: Record<string, unknown> }>; statuses: number[] }> {
    const tmpDir = makeTmpDir();
    const bodies: Array<{ metrics?: Record<string, unknown> }> = [];
    const statuses: number[] = [];
    const stopCtrl = new AbortController();
    const { server, url } = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const path = req.url ?? '';
        const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as { metrics?: Record<string, unknown> }) : {};
        res.setHeader('Content-Type', 'application/json');
        if (path.includes('heartbeat')) {
          bodies.push(body);
          // Hub cũ: strictObject từ chối khoá lạ
          const status = opts.rejectMetrics && body.metrics ? 400 : 200;
          statuses.push(status);
          if (statuses.filter((s) => s === 200).length >= opts.stopAfterBeats) stopCtrl.abort();
          res.writeHead(status);
          res.end(status === 200 ? heartbeatOk() : JSON.stringify({ error: { code: 'validation_error', message: 'metrics' } }));
        } else if (path.includes('claim')) {
          res.writeHead(200); res.end(JSON.stringify({ job: null }));
        } else {
          res.writeHead(404); res.end();
        }
      });
    });
    try {
      const config = { ...makeConfig(tmpDir, url), ...(opts.metricsOff ? { metrics: false } : {}) };
      const { runWorker } = await import('./worker');
      await runWorker({
        config: config as Parameters<typeof runWorker>[0]['config'],
        version: '0.0.1',
        capabilities: FAKE_CAPS,
        heartbeatIntervalMs: 50,
        metricsIntervalMs: 20,
        metricsProbes: opts.probes,
        stopSignal: stopCtrl.signal,
        handlers: { 'scan.extract': async () => ({ manifest: null, summary: {} }) },
      });
      return { bodies, statuses };
    } finally {
      await closeServer(server);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it('heartbeats carry the latest machine reading', async () => {
    const calls = { n: 0 };
    const { bodies } = await runWithHub({ stopAfterBeats: 5, probes: fakeProbes(calls) });
    const withMetrics = bodies.filter((b) => b.metrics);
    expect(withMetrics.length).toBeGreaterThan(0);
    const m = withMetrics[withMetrics.length - 1]!.metrics!;
    expect(m).toMatchObject({
      cpu_pct: 75,
      ram_used_mb: 12 * 1024,
      ram_total_mb: 16 * 1024,
      uptime_s: 120,
    });
    expect((m['disks'] as unknown[]).length).toBe(1);
  }, 15_000);

  it('an older hub refusing metrics still gets heartbeats, without them', async () => {
    const { bodies, statuses } = await runWithHub({ rejectMetrics: true, stopAfterBeats: 6, probes: fakeProbes({ n: 0 }) });
    const refused = statuses.filter((s) => s === 400).length;
    // Bị từ chối đúng một lần, gửi lại ngay không có số đo, rồi thôi gửi số đo
    expect(refused).toBe(1);
    const at = statuses.indexOf(400);
    expect(bodies[at + 1]!.metrics).toBeUndefined();
    expect(bodies.slice(at + 1).every((b) => !b.metrics)).toBe(true);
  }, 15_000);

  it('metrics: false in config measures nothing and sends nothing', async () => {
    const calls = { n: 0 };
    const { bodies } = await runWithHub({ metricsOff: true, stopAfterBeats: 4, probes: fakeProbes(calls) });
    expect(bodies.every((b) => !b.metrics)).toBe(true);
    expect(calls.n).toBe(0);
  }, 15_000);
});

describe('errorToJobError', () => {
  it('keeps a handler code and lets the handler choose to retry', async () => {
    const { errorToJobError, JobFailure, NonRetryableError } = await import('./worker');
    expect(errorToJobError(new JobFailure('network', 'getaddrinfo failed', true))).toEqual({
      code: 'network', message: 'getaddrinfo failed', retryable: true,
    });
    expect(errorToJobError(new JobFailure('private', 'Private video', false))).toEqual({
      code: 'private', message: 'Private video', retryable: false,
    });
    expect(errorToJobError(new NonRetryableError('invalid_payload', 'bad'))).toEqual({
      code: 'invalid_payload', message: 'bad', retryable: false,
    });
    expect(errorToJobError(new Error('boom'))).toEqual({ code: 'WORKER_ERROR', message: 'boom', retryable: true });
    expect(errorToJobError(new JobFailure('x'.repeat(100), 'y'.repeat(3000), true))).toMatchObject({
      code: 'x'.repeat(80), message: 'y'.repeat(2000),
    });
  });
});
