import { METRIC_RANGES, MachineMetricsQuerySchema, downsample, machineKey, toMetricColumns, type MetricRow } from './machine-metrics';

function row(at: string, over: Partial<MetricRow> = {}): MetricRow {
  return {
    machine: 'pc1',
    at: new Date(at),
    cpu_pct: null,
    ram_used_mb: null,
    ram_total_mb: null,
    disk_free_mb: null,
    disk_total_mb: null,
    disks: null,
    net_rx_bps: null,
    net_tx_bps: null,
    gpu: null,
    ...over,
  };
}

describe('machine metrics', () => {
  it('the machine of a node is its machine column, or its name when it has none', () => {
    expect(machineKey({ machine: 'PC1', name: 'PC1-render' })).toBe('PC1');
    expect(machineKey({ machine: '  ', name: 'old-node' })).toBe('old-node');
    expect(machineKey({ machine: null, name: 'old-node' })).toBe('old-node');
  });

  it('a reading becomes table columns; the disk shown is the fullest one', () => {
    expect(
      toMetricColumns({
        cpu_pct: 40,
        ram_used_mb: 1000,
        ram_total_mb: 4000,
        disks: [
          { path: 'C:', free_mb: 50_000, total_mb: 100_000 },
          { path: 'D:', free_mb: 9_000, total_mb: 1_000_000 },
        ],
        net_rx_bps: 10,
        gpus: [{ index: 0, util_pct: 5 }],
      }),
    ).toEqual({
      cpu_pct: 40,
      ram_used_mb: 1000,
      ram_total_mb: 4000,
      disk_free_mb: 9_000,
      disk_total_mb: 1_000_000,
      disks: [
        { path: 'C:', free_mb: 50_000, total_mb: 100_000 },
        { path: 'D:', free_mb: 9_000, total_mb: 1_000_000 },
      ],
      net_rx_bps: 10,
      net_tx_bps: null,
      gpu: [{ index: 0, util_pct: 5 }],
    });
    expect(toMetricColumns({})).toEqual({
      cpu_pct: null,
      ram_used_mb: null,
      ram_total_mb: null,
      disk_free_mb: null,
      disk_total_mb: null,
      disks: null,
      net_rx_bps: null,
      net_tx_bps: null,
      gpu: null,
    });
  });

  it('every range stays at or under 300 points', () => {
    for (const spec of Object.values(METRIC_RANGES)) {
      const now = new Date('2026-10-13T10:17:31Z');
      const points = downsample([], new Date(now.getTime() - spec.ms), now, spec.bucketSeconds);
      expect(points.length).toBeLessThanOrEqual(300);
      expect(points.length).toBeGreaterThan(50);
    }
  });

  it('averages within a bucket, keeps the lowest free disk and hottest GPU, leaves empty buckets null', () => {
    const from = new Date('2026-10-13T10:00:00Z');
    const to = new Date('2026-10-13T10:15:00Z');
    const rows = [
      row('2026-10-13T10:00:00Z', {
        cpu_pct: 10,
        ram_used_mb: 1000,
        ram_total_mb: 8000,
        disk_free_mb: 5000,
        disk_total_mb: 9000,
        net_rx_bps: 100,
        net_tx_bps: 10,
        gpu: [{ index: 0, util_pct: 50, vram_used_mb: 100, vram_total_mb: 8192, temp_c: 60 }],
      }),
      row('2026-10-13T10:03:00Z', {
        cpu_pct: 21,
        ram_used_mb: 2001,
        ram_total_mb: 8000,
        disk_free_mb: 4000,
        disk_total_mb: 9000,
        net_rx_bps: 300,
        gpu: [{ index: 0, util_pct: 70, temp_c: 75 }],
      }),
      // second bucket empty; third bucket has only CPU
      row('2026-10-13T10:11:00Z', { cpu_pct: 99 }),
    ];
    const points = downsample(rows, from, to, 300);
    expect(points.map((p) => p.t)).toEqual([
      '2026-10-13T10:00:00.000Z',
      '2026-10-13T10:05:00.000Z',
      '2026-10-13T10:10:00.000Z',
    ]);
    expect(points[0]).toEqual({
      t: '2026-10-13T10:00:00.000Z',
      cpu_pct: 15.5,
      ram_used_mb: 1501,
      ram_total_mb: 8000,
      disk_free_mb: 4000,
      disk_total_mb: 9000,
      net_rx_bps: 200,
      net_tx_bps: 10,
      gpus: [{ index: 0, util_pct: 60, vram_used_mb: 100, vram_total_mb: 8192, temp_c: 75 }],
    });
    expect(points[1]).toMatchObject({ cpu_pct: null, ram_used_mb: null, disk_free_mb: null, gpus: [] });
    expect(points[2]).toMatchObject({ cpu_pct: 99, ram_used_mb: null });
  });

  it('rows outside the window are ignored', () => {
    const from = new Date('2026-10-13T10:00:00Z');
    const to = new Date('2026-10-13T10:02:00Z');
    const points = downsample([row('2026-10-13T09:59:00Z', { cpu_pct: 1 }), row('2026-10-13T10:05:00Z', { cpu_pct: 2 })], from, to, 60);
    expect(points.every((p) => p.cpu_pct === null)).toBe(true);
  });

  it('range defaults to 1h and only takes 1h, 24h, 7d', () => {
    expect(MachineMetricsQuerySchema.parse({})).toEqual({ range: '1h' });
    expect(MachineMetricsQuerySchema.parse({ range: '7d' })).toEqual({ range: '7d' });
    expect(MachineMetricsQuerySchema.safeParse({ range: '30d' }).success).toBe(false);
  });
});
