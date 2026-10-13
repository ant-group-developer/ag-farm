import type { GpuMetrics, MachineMetrics } from '@ag-farm/protocol';
import { z } from 'zod';

/** Khoảng xem biểu đồ và độ rộng mỗi điểm: ≤ 300 điểm mỗi khoảng (60, 288, 168). */
export const METRIC_RANGES = {
  '1h': { ms: 60 * 60_000, bucketSeconds: 60 },
  '24h': { ms: 24 * 60 * 60_000, bucketSeconds: 5 * 60 },
  '7d': { ms: 7 * 24 * 60 * 60_000, bucketSeconds: 60 * 60 },
} as const;
export type MetricRange = keyof typeof METRIC_RANGES;

export const MachineMetricsQuerySchema = z.strictObject({
  range: z.enum(['1h', '24h', '7d']).default('1h'),
});
export type MachineMetricsQuery = z.infer<typeof MachineMetricsQuerySchema>;

/** Khoá máy của node: cột `machine` (các node `<machine>-<role>` chung một máy), không có thì tên node. */
export function machineKey(node: { machine: string | null; name: string }): string {
  return node.machine?.trim() || node.name;
}

/** Một dòng `farm_machine_metrics` (chưa có machine/at). */
export interface MetricColumns {
  cpu_pct: number | null;
  ram_used_mb: number | null;
  ram_total_mb: number | null;
  disk_free_mb: number | null;
  disk_total_mb: number | null;
  disks: MachineMetrics['disks'] | null;
  net_rx_bps: number | null;
  net_tx_bps: number | null;
  gpu: GpuMetrics[] | null;
}

export interface MetricRow extends MetricColumns {
  machine: string;
  at: Date;
}

/** Số đo heartbeat → cột của bảng; ổ đại diện là ổ còn ít chỗ nhất. */
export function toMetricColumns(m: MachineMetrics): MetricColumns {
  const lowest = (m.disks ?? []).reduce<NonNullable<MachineMetrics['disks']>[number] | null>(
    (min, d) => (!min || d.free_mb < min.free_mb ? d : min),
    null,
  );
  return {
    cpu_pct: m.cpu_pct ?? null,
    ram_used_mb: m.ram_used_mb ?? null,
    ram_total_mb: m.ram_total_mb ?? null,
    disk_free_mb: lowest?.free_mb ?? null,
    disk_total_mb: lowest?.total_mb ?? null,
    disks: m.disks?.length ? m.disks : null,
    net_rx_bps: m.net_rx_bps ?? null,
    net_tx_bps: m.net_tx_bps ?? null,
    gpu: m.gpus?.length ? m.gpus : null,
  };
}

export interface GpuPoint {
  index: number;
  util_pct: number | null;
  vram_used_mb: number | null;
  vram_total_mb: number | null;
  temp_c: number | null;
}

/** Một điểm biểu đồ: trung bình trong ô (ổ trống: thấp nhất; nhiệt độ GPU: cao nhất); ô không có số đo thì null. */
export interface MetricPoint {
  t: string;
  cpu_pct: number | null;
  ram_used_mb: number | null;
  ram_total_mb: number | null;
  disk_free_mb: number | null;
  disk_total_mb: number | null;
  net_rx_bps: number | null;
  net_tx_bps: number | null;
  gpus: GpuPoint[];
}

class Avg {
  private sum = 0;
  private n = 0;
  add(v: number | null | undefined): void {
    if (v == null || !Number.isFinite(v)) return;
    this.sum += v;
    this.n++;
  }
  value(digits = 0): number | null {
    if (!this.n) return null;
    const f = 10 ** digits;
    return Math.round((this.sum / this.n) * f) / f;
  }
}

/**
 * Gom các dòng (mỗi phút một dòng) thành ô `bucketSeconds` từ `from` tới `to`, đủ mọi ô (ô trống là null để biểu đồ có
 * khoảng hở chứ không nối liền qua lúc máy tắt).
 */
export function downsample(rows: MetricRow[], from: Date, to: Date, bucketSeconds: number): MetricPoint[] {
  const step = bucketSeconds * 1000;
  const start = Math.floor(from.getTime() / step) * step;
  const count = Math.max(0, Math.ceil((to.getTime() - start) / step));
  type Acc = {
    cpu: Avg;
    ramUsed: Avg;
    ramTotal: Avg;
    disk: { free: number; total: number | null } | null;
    rx: Avg;
    tx: Avg;
    gpus: Map<number, { util: Avg; used: Avg; total: Avg; temp: number | null }>;
  };
  const accs: Array<Acc | undefined> = new Array(count);
  for (const r of rows) {
    const i = Math.floor((r.at.getTime() - start) / step);
    if (i < 0 || i >= count) continue;
    const a = (accs[i] ??= {
      cpu: new Avg(),
      ramUsed: new Avg(),
      ramTotal: new Avg(),
      disk: null,
      rx: new Avg(),
      tx: new Avg(),
      gpus: new Map(),
    });
    a.cpu.add(r.cpu_pct);
    a.ramUsed.add(r.ram_used_mb);
    a.ramTotal.add(r.ram_total_mb);
    if (r.disk_free_mb != null && (!a.disk || r.disk_free_mb < a.disk.free)) {
      a.disk = { free: r.disk_free_mb, total: r.disk_total_mb };
    }
    a.rx.add(r.net_rx_bps);
    a.tx.add(r.net_tx_bps);
    for (const g of r.gpu ?? []) {
      const ga = a.gpus.get(g.index) ?? { util: new Avg(), used: new Avg(), total: new Avg(), temp: null };
      ga.util.add(g.util_pct);
      ga.used.add(g.vram_used_mb);
      ga.total.add(g.vram_total_mb);
      if (g.temp_c != null && (ga.temp == null || g.temp_c > ga.temp)) ga.temp = g.temp_c;
      a.gpus.set(g.index, ga);
    }
  }
  const points: MetricPoint[] = [];
  for (let i = 0; i < count; i++) {
    const a = accs[i];
    points.push({
      t: new Date(start + i * step).toISOString(),
      cpu_pct: a?.cpu.value(1) ?? null,
      ram_used_mb: a?.ramUsed.value() ?? null,
      ram_total_mb: a?.ramTotal.value() ?? null,
      disk_free_mb: a?.disk?.free ?? null,
      disk_total_mb: a?.disk?.total ?? null,
      net_rx_bps: a?.rx.value() ?? null,
      net_tx_bps: a?.tx.value() ?? null,
      gpus: a
        ? [...a.gpus.entries()]
            .sort(([x], [y]) => x - y)
            .map(([index, g]) => ({
              index,
              util_pct: g.util.value(1),
              vram_used_mb: g.used.value(),
              vram_total_mb: g.total.value(),
              temp_c: g.temp,
            }))
        : [],
    });
  }
  return points;
}
