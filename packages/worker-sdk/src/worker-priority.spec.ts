/**
 * runWorker: tiến độ tới được hub, và việc interactive (Studio) được ưu tiên trên cùng máy.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as os from 'node:os';
import type { Capabilities } from '@ag-farm/protocol';
import { SlotAllocator, loadMachineConfig } from './machine';
import { runWorker } from './worker';

type HubCall = { path: string; body: Record<string, unknown> };

const NODE_UUID = '123e4567-e89b-42d3-a456-426614174000';

const FAKE_CAPS: Capabilities = {
  os: 'windows',
  cpu_cores: 4,
  ram_mb: 8192,
  gpus: [],
  engines: { ffmpeg: 'ffmpeg version 6.0', ollama_models: [], python: null },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTmpDir(): string {
  const d = join(os.tmpdir(), `test-priority-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function makeConfig(tmpDir: string, machineYaml = 'cpu_slots: 2\ngpu_slots: 1\nreserve_interactive:\n  cpu: 0\n  gpu: 0') {
  const machineFile = join(tmpDir, 'machine.yaml');
  writeFileSync(machineFile, machineYaml);
  const workDir = join(tmpDir, 'work');
  mkdirSync(workDir, { recursive: true });
  return {
    hub_url: 'http://placeholder',
    token: 'test-token',
    name: 'test-node',
    kinds: ['scan.extract' as const],
    work_dir: workDir,
    cache: { dir: join(tmpDir, 'cache'), max_gb: 1 },
    machine_file: machineFile,
  };
}

function makeJob() {
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
      params: {
        window_s: 4, max_segment_s: 20, min_segment_s: 1.5,
        merge_dhash_max_distance: 10, scene_threshold: 0.3,
        keyframes_per_segment: 3, keyframe_px: 640,
        proxy: { enabled: true, height: 720, crf: 26, gop_s: 1 },
        contact_sheet: { enabled: true, columns: 6, tile_px: 320 },
        dead: { black_ratio_min: 0.9, frozen_ratio_min: 0.95, blur_min: 12 },
      },
      extract_version: 'v1',
    },
    lease_token: 'lease-abc-0000000000000000',
    lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
    ticket: 'ticket-1-placeholder-00000000000000',
    sign_url: 'http://127.0.0.1:1/sign',
  };
}

/** Hub giả: ghi lại mọi request, trả job theo `pickJob`, progress/complete/fail luôn ok. */
function startFakeHub(
  pickJob: (body: Record<string, unknown>) => unknown,
): Promise<{ server: Server; url: string; calls: HubCall[] }> {
  const calls: HubCall[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const path = req.url ?? '';
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {};
      calls.push({ path, body });
      res.setHeader('Content-Type', 'application/json');
      if (path.includes('heartbeat')) {
        res.writeHead(200);
        res.end(JSON.stringify({ node_id: NODE_UUID, server_time: new Date().toISOString(), status: 'active' }));
      } else if (path.includes('claim')) {
        res.writeHead(200);
        res.end(JSON.stringify(pickJob(body)));
      } else if (path.includes('progress')) {
        res.writeHead(200);
        res.end(JSON.stringify({ lease_expires_at: new Date(Date.now() + 120_000).toISOString(), ticket: 'ticket-progress-000000000' }));
      } else {
        res.writeHead(200);
        res.end('{}');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, calls });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

type WorkerConfigArg = Parameters<typeof runWorker>[0]['config'];

describe('runWorker - progress reaches the hub', () => {
  it('sends the latest value after the gap instead of dropping it', async () => {
    const tmpDir = makeTmpDir();
    const stopCtrl = new AbortController();
    let handed = false;
    const hub = await startFakeHub(() => {
      if (handed) return { job: null };
      handed = true;
      return { job: makeJob() };
    });
    try {
      const config = { ...makeConfig(tmpDir), hub_url: hub.url };
      await runWorker({
        config: config as WorkerConfigArg,
        version: '0.0.1',
        capabilities: FAKE_CAPS,
        heartbeatIntervalMs: 100,
        progressIntervalMs: 60_000, // chỉ kiểm phần handler báo, không để timer giữ lease chen vào
        progressMinGapMs: 80,
        stopSignal: stopCtrl.signal,
        handlers: {
          'scan.extract': async (ctx) => {
            ctx.progress(10, 'download');
            ctx.progress(20, 'cut');
            ctx.progress(48, 'cut');
            await sleep(250);
            stopCtrl.abort();
            return { manifest: null, summary: {} };
          },
        },
      });
      const sent = hub.calls
        .filter((c) => c.path.includes('progress'))
        .map((c) => [c.body['percent'], c.body['stage']]);
      expect(sent[0]).toEqual([10, 'download']);
      // 20% được gộp, 48% phải tới hub (trước đây throttle bỏ đi và hub đứng ở 10%)
      expect(sent[sent.length - 1]).toEqual([48, 'cut']);
    } finally {
      await closeServer(hub.server);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('runWorker - interactive work has priority on the machine', () => {
  it('does not claim batch work while an interactive job is flagged, and resumes after', async () => {
    const tmpDir = makeTmpDir();
    const stopCtrl = new AbortController();
    const baseConfig = makeConfig(tmpDir);
    const other = new SlotAllocator(loadMachineConfig(baseConfig.machine_file), baseConfig.machine_file);
    const flag = other.markInteractive('render-job');
    let flagged = true;
    let batchClaimsWhileFlagged = 0;
    const hub = await startFakeHub((body) => {
      const lanes = body['lanes'] as string[];
      if (lanes.includes('batch')) {
        if (flagged) batchClaimsWhileFlagged++;
        else stopCtrl.abort();
      }
      return { job: null };
    });
    try {
      setTimeout(() => {
        flagged = false;
        other.clearFlag(flag);
      }, 1_500);
      await runWorker({
        config: { ...baseConfig, hub_url: hub.url } as WorkerConfigArg,
        version: '0.0.1',
        capabilities: FAKE_CAPS,
        heartbeatIntervalMs: 100,
        progressIntervalMs: 50,
        stopSignal: stopCtrl.signal,
        handlers: { 'scan.extract': async () => ({ manifest: null, summary: {} }) },
      });
      expect(batchClaimsWhileFlagged).toBe(0);
      expect(stopCtrl.signal.aborted).toBe(true); // claim batch lại sau khi cờ gỡ
    } finally {
      await closeServer(hub.server);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('raises the wanted flag when the hub reports interactive jobs waiting for a slot', async () => {
    const tmpDir = makeTmpDir();
    const stopCtrl = new AbortController();
    const baseConfig = makeConfig(tmpDir);
    const scanSide = new SlotAllocator(loadMachineConfig(baseConfig.machine_file), baseConfig.machine_file);
    let sawPressure = false;
    const hub = await startFakeHub((body) => {
      const lanes = body['lanes'] as string[];
      if (lanes.includes('interactive')) return { job: null, waiting_interactive: { cpu: 0, gpu: 1 } };
      return { job: null };
    });
    const probe = setInterval(() => {
      if (scanSide.interactivePressure()) {
        sawPressure = true;
        stopCtrl.abort();
      }
    }, 50);
    try {
      await runWorker({
        config: { ...baseConfig, hub_url: hub.url } as WorkerConfigArg,
        version: '0.0.1',
        capabilities: FAKE_CAPS,
        heartbeatIntervalMs: 100,
        progressIntervalMs: 50,
        stopSignal: stopCtrl.signal,
        handlers: { 'scan.extract': async () => ({ manifest: null, summary: {} }) },
      });
      expect(sawPressure).toBe(true);
      expect(scanSide.interactivePressure()).toBe(false); // gỡ khi worker dừng
    } finally {
      clearInterval(probe);
      await closeServer(hub.server);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('a batch job gives its slot back while interactive work runs, then takes it again', async () => {
    const tmpDir = makeTmpDir();
    const stopCtrl = new AbortController();
    const baseConfig = makeConfig(tmpDir, 'cpu_slots: 1\ngpu_slots: 0\nreserve_interactive:\n  cpu: 0\n  gpu: 0');
    const renderSide = new SlotAllocator(loadMachineConfig(baseConfig.machine_file), baseConfig.machine_file);
    let handed = false;
    const hub = await startFakeHub(() => {
      if (handed) return { job: null };
      handed = true;
      return { job: makeJob() };
    });
    const events: string[] = [];
    let yieldBefore: boolean | null = null;
    let yieldDuring: boolean | null = null;
    try {
      await runWorker({
        config: { ...baseConfig, hub_url: hub.url } as WorkerConfigArg,
        version: '0.0.1',
        capabilities: FAKE_CAPS,
        heartbeatIntervalMs: 100,
        progressIntervalMs: 60_000,
        progressMinGapMs: 10,
        yieldPollMs: 20,
        stopSignal: stopCtrl.signal,
        handlers: {
          'scan.extract': async (ctx) => {
            yieldBefore = ctx.shouldYield();
            const flag = renderSide.markInteractive('render-job');
            yieldDuring = ctx.shouldYield();
            const yielding = ctx.yieldToInteractive().then(() => events.push('resumed'));
            await sleep(100);
            // Máy chỉ có 1 slot CPU: job batch đã nhả nên bên render lấy được
            const renderSlot = renderSide.acquire('cpu', { lane: 'interactive' });
            events.push(renderSlot ? 'render-got-slot' : 'render-blocked');
            await sleep(100);
            if (renderSlot) renderSide.release(renderSlot);
            renderSide.clearFlag(flag);
            await yielding;
            stopCtrl.abort();
            return { manifest: null, summary: {} };
          },
        },
      });
      expect(yieldBefore).toBe(false);
      expect(yieldDuring).toBe(true);
      expect(events).toEqual(['render-got-slot', 'resumed']);
      const stages = hub.calls.filter((c) => c.path.includes('progress')).map((c) => c.body['stage']);
      expect(stages).toContain('waiting_for_interactive');
    } finally {
      await closeServer(hub.server);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 10_000);
});
