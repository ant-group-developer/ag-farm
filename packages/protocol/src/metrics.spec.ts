import { HeartbeatRequestSchema, MachineMetricsSchema } from './index';

const heartbeat = {
  agent_version: '0.9.0',
  kinds: ['studio.tts'],
  capabilities: {
    os: 'windows',
    cpu_cores: 8,
    ram_mb: 16000,
    gpus: [],
    engines: { ffmpeg: '7.0', ollama_models: [], python: null },
  },
  free_slots: { cpu: 1, gpu: 0 },
  running_job_ids: [],
};

const full = {
  cpu_pct: 37.5,
  ram_used_mb: 9000,
  ram_total_mb: 16000,
  disks: [
    { path: 'C:', free_mb: 120_000, total_mb: 500_000 },
    { path: 'D:', free_mb: 15_000, total_mb: 1_000_000 },
  ],
  net_rx_bps: 1_250_000,
  net_tx_bps: 80_000.5,
  gpus: [{ index: 0, util_pct: 92, vram_used_mb: 7000, vram_total_mb: 8192, temp_c: 71 }],
  uptime_s: 86_400,
};

describe('machine metrics', () => {
  it('a heartbeat without metrics still passes (workers before metrics)', () => {
    expect(HeartbeatRequestSchema.safeParse(heartbeat).success).toBe(true);
  });

  it('a heartbeat carries every reading', () => {
    const r = HeartbeatRequestSchema.safeParse({ ...heartbeat, metrics: full });
    expect(r.success).toBe(true);
    expect(r.data?.metrics).toEqual(full);
  });

  it('every reading is optional: a machine sends what it measured', () => {
    expect(MachineMetricsSchema.safeParse({}).success).toBe(true);
    expect(MachineMetricsSchema.safeParse({ ram_used_mb: 1, ram_total_mb: 2 }).success).toBe(true);
    expect(MachineMetricsSchema.safeParse({ gpus: [{ index: 1 }] }).success).toBe(true);
  });

  it('refuses unknown keys and out-of-range readings', () => {
    const bad: unknown[] = [
      { cpu: 1 },
      { cpu_pct: 101 },
      { cpu_pct: -1 },
      { ram_used_mb: 1.5 },
      { ram_total_mb: 0 },
      { net_rx_bps: -5 },
      { disks: [{ path: '', free_mb: 1, total_mb: 2 }] },
      { disks: [{ path: 'C:', free_mb: 1, total_mb: 2, x: 1 }] },
      { disks: Array.from({ length: 17 }, () => ({ path: 'C:', free_mb: 1, total_mb: 2 })) },
      { gpus: [{ index: 0, util_pct: 120 }] },
      { gpus: [{ index: 0, temp_c: 400 }] },
      { uptime_s: -1 },
    ];
    for (const m of bad) expect(MachineMetricsSchema.safeParse(m).success).toBe(false);
    expect(HeartbeatRequestSchema.safeParse({ ...heartbeat, metrics: { cpu_pct: 200 } }).success).toBe(false);
  });
});
