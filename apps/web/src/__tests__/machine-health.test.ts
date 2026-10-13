import { describe, expect, it } from 'vitest';
import {
  diskLevel,
  formatRate,
  formatUptime,
  gpuView,
  healthSummary,
  isStale,
  levelOf,
  machineKey,
  metricSortValue,
  sortByMetric,
  ramPct,
  worstDisk,
} from '../modules/nodes/machine-health';
import type { MachineMetrics, NodeView } from '../types/api';

const NOW = Date.parse('2026-10-13T10:00:00Z');
const fresh = new Date(NOW - 20_000).toISOString();
const old = new Date(NOW - 5 * 60_000).toISOString();

function node(name: string, machine: string, metrics: MachineMetrics | null, metrics_at: string | null = fresh): NodeView {
  return { name, machine, metrics, metrics_at } as NodeView;
}

describe('machine health', () => {
  it('yellow from 80 %, red from 95 %', () => {
    expect(levelOf(79.9)).toBe('normal');
    expect(levelOf(80)).toBe('warning');
    expect(levelOf(95)).toBe('danger');
    expect(levelOf(null)).toBe('normal');
  });

  it('the fullest disk decides; under 20 GB free is red whatever its size', () => {
    const d = worstDisk({
      disks: [
        { path: 'C:', free_mb: 200_000, total_mb: 500_000 },
        { path: 'D:', free_mb: 19_000, total_mb: 4_000_000 },
      ],
    });
    expect(d?.path).toBe('D:');
    expect(diskLevel(d)).toBe('danger');
    expect(diskLevel(worstDisk({ disks: [{ path: 'C:', free_mb: 50_000, total_mb: 400_000 }] }))).toBe('warning');
    expect(diskLevel(worstDisk({ disks: [{ path: 'C:', free_mb: 300_000, total_mb: 400_000 }] }))).toBe('normal');
    expect(worstDisk({})).toBeNull();
  });

  it('RAM and GPU percentages, busiest GPU', () => {
    expect(ramPct({ ram_used_mb: 9, ram_total_mb: 10 })).toBe(90);
    expect(ramPct({ ram_used_mb: 9 })).toBeNull();
    expect(
      gpuView({
        gpus: [
          { index: 0, util_pct: 10, vram_used_mb: 1000, vram_total_mb: 8000, temp_c: 50 },
          { index: 1, util_pct: 90, temp_c: 88 },
        ],
      }),
    ).toEqual({ util_pct: 90, vram_pct: 12.5, temp_c: 88, count: 2 });
    expect(gpuView({})).toBeNull();
  });

  it('a reading older than 2 minutes, or none, is stale', () => {
    expect(isStale({ metrics_at: fresh }, NOW)).toBe(false);
    expect(isStale({ metrics_at: old }, NOW)).toBe(true);
    expect(isStale({ metrics_at: null }, NOW)).toBe(true);
    expect(isStale({}, NOW)).toBe(true);
  });

  it('formats rates and uptime', () => {
    expect(formatRate(950)).toBe('950 B/s');
    expect(formatRate(12_400)).toBe('12.4 kB/s');
    expect(formatRate(3_100_000)).toBe('3.1 MB/s');
    expect(formatRate(null)).toBe('-');
    expect(formatUptime(3 * 86_400 + 4 * 3600 + 5)).toBe('3d 4h');
    expect(formatUptime(5 * 3600 + 12 * 60)).toBe('5h 12m');
    expect(formatUptime(720)).toBe('12m');
  });

  it('machine of a node: its machine, or its name', () => {
    expect(machineKey({ machine: 'PC1', name: 'PC1-render' })).toBe('PC1');
    expect(machineKey({ machine: '', name: 'solo' })).toBe('solo');
  });

  it('sort values: missing readings give null', () => {
    const n = node('a', 'A', { cpu_pct: 5, net_rx_bps: 10, disks: [{ path: 'C:', free_mb: 7, total_mb: 9 }] });
    expect(metricSortValue.cpu(n)).toBe(5);
    expect(metricSortValue.disk(n)).toBe(7);
    expect(metricSortValue.net(n)).toBe(10);
    expect(metricSortValue.ram(n)).toBeNull();
    expect(metricSortValue.gpu(n)).toBeNull();
  });

  it('sorting on a reading keeps nodes without it last, both ways', () => {
    const a = node('a', 'A', { cpu_pct: 10 });
    const b = node('b', 'B', null, null);
    const c = node('c', 'C', { cpu_pct: 90 });
    const d = node('d', 'D', { cpu_pct: 10 });
    expect(sortByMetric([a, b, c, d], 'cpu', 'descend').map((n) => n.name)).toEqual(['c', 'a', 'd', 'b']);
    expect(sortByMetric([a, b, c, d], 'cpu', 'ascend').map((n) => n.name)).toEqual(['a', 'd', 'c', 'b']);
  });

  it('summary counts machines, not workers, from fresh readings only', () => {
    const fullDisk: MachineMetrics = { disks: [{ path: 'D:', free_mb: 10_000, total_mb: 1_000_000 }] };
    const s = healthSummary(
      [
        // PC1: render and scan worker, one machine
        node('PC1-render', 'PC1', { ...fullDisk, ram_used_mb: 95, ram_total_mb: 100 }),
        node('PC1-scan', 'PC1', { ...fullDisk, ram_used_mb: 95, ram_total_mb: 100 }),
        node('PC2-render', 'PC2', { ...fullDisk, cpu_pct: 99, gpus: [{ index: 0, temp_c: 86 }] }),
        // stale: does not count
        node('PC3-render', 'PC3', { ...fullDisk, ram_used_mb: 99, ram_total_mb: 100 }, old),
        node('PC4-render', 'PC4', { ram_used_mb: 10, ram_total_mb: 100 }),
        node('PC5-render', 'PC5', null, null),
      ],
      NOW,
    );
    expect(s).toEqual({ diskLow: ['PC1', 'PC2'], ramHigh: ['PC1'], cpuHigh: ['PC2'], gpuHot: ['PC2'] });
  });
});
