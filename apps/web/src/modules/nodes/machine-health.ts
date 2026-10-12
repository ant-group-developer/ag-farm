import type { DiskMetrics, MachineMetrics, NodeView } from '../../types/api';

/** A reading older than this is stale: the worker stopped sending (offline, older version, metrics off). */
export const METRICS_STALE_MS = 2 * 60_000;
/** Yellow from here (percent used). */
export const WARN_PCT = 80;
/** Red from here (percent used). */
export const DANGER_PCT = 95;
/** A disk with less free space than this is red whatever its size. */
export const DISK_LOW_MB = 20 * 1024;
/** Header summary: RAM above this counts as "RAM > 90 %". */
export const RAM_HIGH_PCT = 90;
/** Header summary: a GPU this hot counts. */
export const GPU_HOT_C = 85;

export type Level = 'normal' | 'warning' | 'danger';

/** The machine a node runs on: nodes `<machine>-<role>` share it; nodes without one stand alone (the hub does the same). */
export function machineKey(node: Pick<NodeView, 'machine' | 'name'>): string {
  return node.machine?.trim() || node.name;
}

export function isStale(node: Pick<NodeView, 'metrics_at'>, now: number = Date.now()): boolean {
  if (!node.metrics_at) return true;
  return now - Date.parse(node.metrics_at) > METRICS_STALE_MS;
}

export function levelOf(pct: number | null | undefined): Level {
  if (pct == null) return 'normal';
  if (pct >= DANGER_PCT) return 'danger';
  if (pct >= WARN_PCT) return 'warning';
  return 'normal';
}

export function ramPct(m: MachineMetrics | null | undefined): number | null {
  if (!m || m.ram_used_mb == null || !m.ram_total_mb) return null;
  return (m.ram_used_mb / m.ram_total_mb) * 100;
}

export interface DiskView extends DiskMetrics {
  used_pct: number;
}

/** The disk closest to full (least free space): what decides the Disk column and its colour. */
export function worstDisk(m: MachineMetrics | null | undefined): DiskView | null {
  const disks = m?.disks ?? [];
  if (!disks.length) return null;
  const d = disks.reduce((min, x) => (x.free_mb < min.free_mb ? x : min));
  return { ...d, used_pct: d.total_mb > 0 ? ((d.total_mb - d.free_mb) / d.total_mb) * 100 : 0 };
}

export function diskLevel(d: DiskView | null): Level {
  if (!d) return 'normal';
  if (d.free_mb < DISK_LOW_MB) return 'danger';
  return levelOf(d.used_pct);
}

export interface GpuView {
  util_pct: number | null;
  vram_pct: number | null;
  temp_c: number | null;
  count: number;
}

/** Busiest GPU: highest use, fullest VRAM, hottest card (a machine with several cards shows the worst of each). */
export function gpuView(m: MachineMetrics | null | undefined): GpuView | null {
  const gpus = m?.gpus ?? [];
  if (!gpus.length) return null;
  const max = (values: Array<number | null>) => {
    const real = values.filter((v): v is number => v != null);
    return real.length ? Math.max(...real) : null;
  };
  return {
    util_pct: max(gpus.map((g) => g.util_pct ?? null)),
    vram_pct: max(gpus.map((g) => (g.vram_used_mb != null && g.vram_total_mb ? (g.vram_used_mb / g.vram_total_mb) * 100 : null))),
    temp_c: max(gpus.map((g) => g.temp_c ?? null)),
    count: gpus.length,
  };
}

/** Bytes per second, base 1000 like network speeds: 950 B/s, 12.4 kB/s, 3.1 MB/s. */
export function formatRate(bps: number | null | undefined): string {
  if (bps == null) return '-';
  const units = ['B/s', 'kB/s', 'MB/s', 'GB/s'];
  let v = bps;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 ? Math.round(v) : v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** MB → GB: whole numbers from 10 GB up, one decimal below. */
export function formatGb(mb: number): string {
  const gb = mb / 1024;
  return String(gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10);
}

/** How long a machine has been up: 3d 4h, 5h 12m, 12m. */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null) return '-';
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatPct(pct: number | null | undefined): string {
  return pct == null ? '-' : `${Math.round(pct)}%`;
}

// ---- Sort values (missing last) ----

export const metricSortValue = {
  cpu: (n: NodeView) => n.metrics?.cpu_pct ?? null,
  ram: (n: NodeView) => ramPct(n.metrics),
  disk: (n: NodeView) => worstDisk(n.metrics)?.free_mb ?? null,
  net: (n: NodeView) =>
    n.metrics?.net_rx_bps == null && n.metrics?.net_tx_bps == null
      ? null
      : (n.metrics?.net_rx_bps ?? 0) + (n.metrics?.net_tx_bps ?? 0),
  gpu: (n: NodeView) => gpuView(n.metrics)?.util_pct ?? null,
} as const;

export type MetricKey = keyof typeof metricSortValue;
export type MetricSortOrder = 'ascend' | 'descend';

/** Rows sorted on a reading; nodes without that reading stay last in both directions. */
export function sortByMetric<T extends NodeView>(nodes: T[], key: MetricKey, order: MetricSortOrder): T[] {
  const value = metricSortValue[key];
  const dir = order === 'descend' ? -1 : 1;
  return nodes
    .map((n, i) => ({ n, i, v: value(n) }))
    .sort((a, b) => {
      if (a.v == null || b.v == null) return a.v == null && b.v == null ? a.i - b.i : a.v == null ? 1 : -1;
      return (a.v - b.v) * dir || a.i - b.i;
    })
    .map((x) => x.n);
}

export function isMetricKey(key: unknown): key is MetricKey {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(metricSortValue, key);
}

// ---- Header summary ----

export interface HealthSummary {
  /** Machines with a disk under 20 GB free or 95 % full. */
  diskLow: string[];
  /** Machines using more than 90 % of RAM. */
  ramHigh: string[];
  /** Machines at 95 % CPU or more. */
  cpuHigh: string[];
  /** Machines with a GPU at 85 °C or more. */
  gpuHot: string[];
}

/**
 * Problems per machine (not per node: the render and scan worker of one machine count once), from fresh readings only.
 */
export function healthSummary(nodes: NodeView[], now: number = Date.now()): HealthSummary {
  const latest = new Map<string, { at: number; m: MachineMetrics }>();
  for (const n of nodes) {
    if (!n.metrics || isStale(n, now)) continue;
    const at = Date.parse(n.metrics_at!);
    const key = machineKey(n);
    const cur = latest.get(key);
    if (!cur || at > cur.at) latest.set(key, { at, m: n.metrics });
  }
  const out: HealthSummary = { diskLow: [], ramHigh: [], cpuHigh: [], gpuHot: [] };
  for (const [machine, { m }] of [...latest.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (diskLevel(worstDisk(m)) === 'danger') out.diskLow.push(machine);
    const ram = ramPct(m);
    if (ram != null && ram > RAM_HIGH_PCT) out.ramHigh.push(machine);
    if (m.cpu_pct != null && m.cpu_pct >= DANGER_PCT) out.cpuHigh.push(machine);
    const temp = gpuView(m)?.temp_c;
    if (temp != null && temp >= GPU_HOT_C) out.gpuHot.push(machine);
  }
  return out;
}
