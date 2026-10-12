import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as os from 'node:os';
import {
  SelfUpdater,
  fetchLatestVersion,
  readUpdateOutcome,
  updateRole,
  writeUpdateRequest,
} from './self-update';
import type { SelfUpdaterDeps, UpdateRequest } from './self-update';
import { rootLogger } from './logger';

const MIN = 60_000;
const silent = { ...rootLogger, debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

function setup(over: { version?: string; latest?: string | null; auto?: boolean; requestedAt?: string | null } = {}) {
  let now = Date.parse('2026-10-12T10:00:00.000Z');
  const state = {
    latest: over.latest === undefined ? '0.9.1' : over.latest,
    auto: over.auto ?? true,
    requestedAt: over.requestedAt ?? null,
    started: [] as string[],
    requests: [] as UpdateRequest[],
    changes: 0,
    startError: null as Error | null,
    latestCalls: 0,
  };
  const deps: SelfUpdaterDeps = {
    me: async () => ({ auto_update: state.auto, update_requested_at: state.requestedAt }),
    latest: async () => {
      state.latestCalls++;
      return state.latest;
    },
    startTask: async (name) => {
      if (state.startError) throw state.startError;
      state.started.push(name);
    },
    writeRequest: (req) => state.requests.push(req),
    now: () => now,
    random: () => 0.5,
  };
  const u = new SelfUpdater({
    packageName: 'ag-render-worker',
    version: over.version ?? '0.9.0',
    updaterTask: 'ag-farm-updater',
    updaterDir: 'C:\\ag-farm\\updater',
    checkMs: 15 * MIN,
    drainMs: 30 * MIN,
    firstCheckMs: 0,
    log: silent,
    deps,
    onChange: () => state.changes++,
  });
  return { u, state, advance: (ms: number) => (now += ms), now: () => now };
}

describe('SelfUpdater', () => {
  it('a newer version: stops taking jobs, waits for running jobs, then starts the updater', async () => {
    const { u, state, advance } = setup();
    await u.tick(2);
    expect(u.pausesClaims).toBe(true);
    expect(u.report).toMatchObject({ state: 'draining', target_version: '0.9.1' });
    expect(state.started).toEqual([]);

    advance(10_000);
    await u.tick(1);
    expect(state.started).toEqual([]);

    advance(10_000);
    await u.tick(0);
    expect(state.started).toEqual(['ag-farm-updater']);
    expect(state.requests).toEqual([
      expect.objectContaining({ package: 'ag-render-worker', from_version: '0.9.0', target_version: '0.9.1', reason: 'auto' }),
    ]);
    expect(u.report.state).toBe('installing');
    expect(u.pausesClaims).toBe(true);
    expect(state.changes).toBe(2); // draining, installing: each sends a heartbeat at once
  });

  it('updates anyway when the jobs outlast update_drain_minutes', async () => {
    const { u, state, advance } = setup();
    await u.tick(1);
    advance(29 * MIN);
    await u.tick(1);
    expect(state.started).toEqual([]);
    advance(MIN);
    await u.tick(1);
    expect(state.started).toEqual(['ag-farm-updater']);
  });

  it('same or older version on the hub: nothing happens', async () => {
    for (const latest of ['0.9.0', '0.8.1', null]) {
      const { u, state } = setup({ latest });
      await u.tick(0);
      expect(u.pausesClaims).toBe(false);
      expect(u.report.state).toBe('idle');
      expect(state.started).toEqual([]);
    }
  });

  it('checks latest.json every update_check_minutes, not every tick', async () => {
    const { u, state, advance } = setup({ latest: '0.9.0' });
    await u.tick(0);
    expect(state.latestCalls).toBe(1);
    advance(5 * MIN);
    await u.tick(0);
    expect(state.latestCalls).toBe(1);
    advance(11 * MIN);
    await u.tick(0);
    expect(state.latestCalls).toBe(2);
  });

  it('auto_update off: does not update on its own', async () => {
    const { u, state } = setup({ auto: false });
    await u.tick(0);
    expect(u.pausesClaims).toBe(false);
    expect(state.latestCalls).toBe(0);
  });

  it('"update now" updates even with auto_update off, without waiting for the check interval', async () => {
    const { u, state, advance, now } = setup({ auto: false });
    await u.tick(0);
    advance(MIN);
    state.requestedAt = new Date(now()).toISOString();
    await u.tick(0);
    expect(u.report).toMatchObject({ state: 'draining', target_version: '0.9.1' });
    advance(10_000);
    await u.tick(0);
    expect(state.requests[0]).toMatchObject({ reason: 'requested', requested_at: state.requestedAt });
  });

  it('"update now" on the latest version says so', async () => {
    const { u, state, now } = setup({ latest: '0.9.0', requestedAt: null });
    state.requestedAt = new Date(now()).toISOString();
    await u.tick(0);
    expect(u.report).toMatchObject({ state: 'idle', message: 'Already on the latest version (0.9.0)' });
  });

  it('an "update now" older than an hour is ignored', async () => {
    const { u, state, now } = setup({ auto: false });
    state.requestedAt = new Date(now() - 2 * 60 * MIN).toISOString();
    await u.tick(0);
    expect(u.pausesClaims).toBe(false);
  });

  it('the updater cannot start: reports failed, takes jobs again, does not retry that version by itself', async () => {
    const { u, state, advance } = setup();
    state.startError = new Error('ERROR: The system cannot find the file specified.');
    await u.tick(0);
    advance(10_000);
    await u.tick(0);
    expect(u.pausesClaims).toBe(false);
    expect(u.report).toMatchObject({ state: 'failed', target_version: '0.9.1' });
    expect(u.report.message).toContain('Could not start the updater');
    advance(20 * MIN);
    await u.tick(0);
    expect(u.pausesClaims).toBe(false);
  });

  it('the updater never stops the worker: takes jobs again after the timeout', async () => {
    const { u, advance } = setup();
    await u.tick(0);
    advance(10_000);
    await u.tick(0);
    expect(u.report.state).toBe('installing');
    advance(16 * MIN);
    await u.tick(0);
    expect(u.pausesClaims).toBe(false);
    expect(u.report.state).toBe('failed');
  });

  it('reports the last update and skips a version that failed (rolled back)', async () => {
    const ok = setup({ version: '0.9.1', latest: '0.9.1' });
    ok.u.init({ state: 'done', from_version: '0.9.0', target_version: '0.9.1', finished_at: '2026-10-12T09:00:00.000Z' });
    expect(ok.u.report).toEqual({ state: 'idle', target_version: '0.9.1', message: 'Updated from 0.9.0 to 0.9.1', since: '2026-10-12T09:00:00.000Z' });

    const bad = setup({ version: '0.9.0', latest: '0.9.1' });
    bad.u.init({ state: 'failed', from_version: '0.9.0', target_version: '0.9.1', message: 'no heartbeat in 3 min', finished_at: '2026-10-12T09:00:00.000Z' });
    expect(bad.u.report).toMatchObject({ state: 'failed', target_version: '0.9.1', message: 'no heartbeat in 3 min' });
    await bad.u.tick(0);
    expect(bad.u.pausesClaims).toBe(false);
    // A newer release is tried again
    bad.state.latest = '0.9.2';
    bad.advance(16 * MIN);
    await bad.u.tick(0);
    expect(bad.u.report).toMatchObject({ state: 'draining', target_version: '0.9.2' });
  });

  it('the "update now" that caused the last update is not handled twice', async () => {
    const { u, state } = setup({ version: '0.9.0', latest: '0.9.1', auto: false, requestedAt: '2026-10-12T09:59:00.000Z' });
    u.init({ state: 'failed', target_version: '0.9.1', finished_at: '2026-10-12T09:59:30.000Z', requested_at: '2026-10-12T09:59:00.000Z' });
    await u.tick(0);
    expect(u.pausesClaims).toBe(false);
    expect(state.latestCalls).toBe(0);
  });
});

describe('update files', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(os.tmpdir(), 'ag-update-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('role names match install.ps1', () => {
    expect(updateRole('ag-render-worker')).toBe('render');
    expect(updateRole('ag-scan-worker')).toBe('scan');
    expect(updateRole('other')).toBe('other');
  });

  it('writes the request the updater reads', () => {
    writeUpdateRequest(dir, 'render', {
      package: 'ag-render-worker',
      from_version: '0.9.0',
      target_version: '0.9.1',
      reason: 'auto',
      requested_at: '2026-10-12T10:00:00.000Z',
    });
    expect(JSON.parse(readFileSync(join(dir, 'request-render.json'), 'utf8'))).toMatchObject({ target_version: '0.9.1' });
  });

  it('reads the result PowerShell wrote (with a BOM), ignores junk', () => {
    writeFileSync(join(dir, 'result-render.json'), '\uFEFF{"state":"failed","target_version":"0.9.1","message":"x"}');
    expect(readUpdateOutcome(dir, 'render')).toMatchObject({ state: 'failed', target_version: '0.9.1', message: 'x' });
    writeFileSync(join(dir, 'result-scan.json'), '{"state":"weird"}');
    expect(readUpdateOutcome(dir, 'scan')).toBeNull();
    expect(readUpdateOutcome(dir, 'none')).toBeNull();
  });
});

describe('fetchLatestVersion', () => {
  let server: Server;
  let url: string;
  let body = '';
  beforeAll(async () => {
    server = createServer((_req, res) => {
      if (!body) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('reads its own package from latest.json', async () => {
    body = JSON.stringify({
      packages: {
        'ag-render-worker': { version: '0.9.1', file: 'ag-render-worker-0.9.1.zip', sha256: 'a'.repeat(64), size_bytes: 1 },
        'ag-scan-worker': { version: 'broken' },
      },
    });
    await expect(fetchLatestVersion(`${url}/`, 'ag-render-worker')).resolves.toBe('0.9.1');
    await expect(fetchLatestVersion(url, 'ag-scan-worker')).resolves.toBeNull();
    await expect(fetchLatestVersion(url, 'ag-other-worker')).resolves.toBeNull();
  });

  it('no latest.json on the hub: no version', async () => {
    body = '';
    await expect(fetchLatestVersion(url, 'ag-render-worker')).resolves.toBeNull();
  });
});
