/**
 * Đo tình trạng máy ở nền: CPU %, RAM, ổ của work_dir/cache, mạng vào/ra, GPU (nvidia-smi), thời gian máy đã chạy.
 *
 * - Không bao giờ chặn heartbeat: heartbeat chỉ đọc bản đo mới nhất (`latest()`), đo chạy theo chu kỳ riêng.
 * - Mỗi lần đo chạy **tối đa một lệnh hệ điều hành** (có timeout): các phép đo cần lệnh (GPU qua `nvidia-smi`, mạng
 *   trên Windows qua `netstat -e`) thay phiên nhau; số của lần chạy trước được dùng tiếp tới khi cũ quá 3 chu kỳ.
 * - Số nào không đo được thì bỏ trường đó. Lệnh không có trên máy (ENOENT) thì thôi chạy hẳn.
 */
import { execFile } from 'node:child_process';
import { readFile, stat, statfs } from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { promisify } from 'node:util';
import { MachineMetricsSchema, METRICS_SAMPLE_SECONDS } from '@ag-farm/protocol';
import type { DiskMetrics, GpuMetrics, MachineMetrics } from '@ag-farm/protocol';

const execFileAsync = promisify(execFile);

/** Timeout của mỗi lệnh đo (nvidia-smi, netstat). */
export const METRICS_COMMAND_TIMEOUT_MS = 5_000;
/** Bản đo cũ hơn ngần này thì heartbeat không gửi (sampler kẹt: thà không có số còn hơn số cũ trông như mới). */
export const METRICS_MAX_AGE_MS = 2 * 60_000;

const MB = 1024 * 1024;
/** `netstat -e` của Windows đếm byte bằng số 32 bit: quay về 0 sau 4 GiB. */
const COUNTER_32 = 2 ** 32;

export interface CpuTimes {
  idle: number;
  total: number;
}

export interface StatfsResult {
  bsize: number;
  blocks: number;
  bavail: number;
}

/** Phần gọi ra ngoài của sampler; tests thay bằng số giả, không đụng phần cứng thật. */
export interface MetricsProbes {
  platform: NodeJS.Platform;
  /** Tổng thời gian idle/tất cả của mọi lõi từ lúc máy bật (ms). */
  cpuTimes(): CpuTimes;
  /** Byte. */
  memory(): { total: number; free: number };
  uptime(): number;
  /** Mã thiết bị (`stat.dev`) của đường dẫn, để gộp các thư mục cùng ổ; ném lỗi nếu không có. */
  device(path: string): Promise<number>;
  statfs(path: string): Promise<StatfsResult>;
  readFile(path: string): Promise<string>;
  exec(file: string, args: string[], options: { timeout: number }): Promise<{ stdout: string }>;
  now(): number;
}

export const defaultProbes: MetricsProbes = {
  platform: os.platform(),
  cpuTimes() {
    let idle = 0;
    let total = 0;
    for (const cpu of os.cpus()) {
      const t = cpu.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    return { idle, total };
  },
  memory: () => ({ total: os.totalmem(), free: os.freemem() }),
  uptime: () => os.uptime(),
  device: async (path) => (await stat(path)).dev,
  statfs: async (path) => {
    const s = await statfs(path);
    return { bsize: s.bsize, blocks: s.blocks, bavail: s.bavail };
  },
  readFile: (path) => readFile(path, 'utf8'),
  exec: async (file, args, options) => {
    const { stdout } = await execFileAsync(file, args, { timeout: options.timeout, windowsHide: true });
    return { stdout: String(stdout) };
  },
  now: () => Date.now(),
};

// ---- Đọc kết quả lệnh ----

/** `nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits` */
export const NVIDIA_SMI_ARGS = [
  '--query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu',
  '--format=csv,noheader,nounits',
];

/** Số trong một ô của nvidia-smi; `[N/A]`, `[Not Supported]`, rỗng → không có. */
function smiNumber(cell: string | undefined): number | undefined {
  const v = Number((cell ?? '').trim());
  return (cell ?? '').trim() !== '' && Number.isFinite(v) ? v : undefined;
}

export function parseNvidiaSmi(stdout: string): GpuMetrics[] {
  const gpus: GpuMetrics[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [index, util, used, total, temp] = line.split(',').map((c) => c.trim());
    const i = smiNumber(index);
    if (i === undefined || !Number.isInteger(i) || i < 0 || i > 63) continue;
    const g: GpuMetrics = { index: i };
    const u = smiNumber(util);
    if (u !== undefined) g.util_pct = clamp(u, 0, 100);
    const vu = smiNumber(used);
    if (vu !== undefined && vu >= 0) g.vram_used_mb = Math.round(vu);
    const vt = smiNumber(total);
    if (vt !== undefined && vt >= 0) g.vram_total_mb = Math.round(vt);
    const tc = smiNumber(temp);
    if (tc !== undefined && tc >= -50 && tc <= 150) g.temp_c = tc;
    gpus.push(g);
    if (gpus.length >= 16) break;
  }
  return gpus;
}

export interface NetCounters {
  rx: number;
  tx: number;
}

/**
 * `netstat -e` (Windows): dòng đầu có đúng hai số là dòng "Bytes" (nhãn có thể được dịch nên không dò theo chữ).
 */
export function parseNetstatE(stdout: string): NetCounters | null {
  for (const line of stdout.split(/\r?\n/)) {
    const nums = line.trim().split(/\s+/).filter((p) => /^\d+$/.test(p));
    const words = line.trim().split(/\s+/).filter((p) => !/^\d+$/.test(p));
    if (nums.length === 2 && words.length >= 1) return { rx: Number(nums[0]), tx: Number(nums[1]) };
  }
  return null;
}

/** Card ảo (loopback, docker, bridge, veth) đếm lại đúng gói đã qua card thật: bỏ để không cộng hai lần. */
const LINUX_SKIP_IFACE = /^(lo|docker\d*|veth.*|br-.*|virbr.*|cni.*|flannel.*|cali.*|tun.*|tap.*)$/;

/** `/proc/net/dev`: cộng byte nhận (cột 1) và gửi (cột 9) của các card thật. */
export function parseProcNetDev(content: string): NetCounters | null {
  let rx = 0;
  let tx = 0;
  let found = false;
  for (const line of content.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (!name || LINUX_SKIP_IFACE.test(name)) continue;
    const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    if (fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) continue;
    rx += fields[0]!;
    tx += fields[8]!;
    found = true;
  }
  return found ? { rx, tx } : null;
}

/** Byte/giây giữa hai lần đọc bộ đếm. Bộ đếm 32 bit quay vòng một lần thì cộng 2^32; tụt hẳn (card khởi động lại) thì bỏ. */
export function counterRate(prev: number, cur: number, seconds: number, wraps32: boolean): number | undefined {
  if (seconds <= 0) return undefined;
  let delta = cur - prev;
  if (delta < 0) {
    if (!wraps32 || prev >= COUNTER_32) return undefined;
    delta += COUNTER_32;
  }
  return delta / seconds;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// ---- Sampler ----

type CommandProbe = 'gpu' | 'net';

export interface MachineSamplerOptions {
  /** Thư mục cần biết ổ còn trống (work_dir, cache). Chưa có thì đo thư mục cha gần nhất đang có. */
  dirs: string[];
  /** Có đo GPU qua nvidia-smi không (máy không có GPU NVIDIA thì khỏi chạy). Mặc định true. */
  gpu?: boolean;
  intervalMs?: number;
  probes?: Partial<MetricsProbes>;
  /** Báo lỗi đo (một lần mỗi loại lỗi). */
  onError?: (what: string, err: unknown) => void;
}

export class MachineSampler {
  private readonly probes: MetricsProbes;
  private readonly intervalMs: number;
  private readonly dirs: string[];
  /** Đường dẫn theo đúng hệ điều hành được đo (tests giả Windows trên Linux và ngược lại). */
  private readonly path: typeof nodePath.posix;
  private readonly commands: CommandProbe[] = [];
  private nextCommand = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private prevCpu: CpuTimes | null = null;
  private prevNet: (NetCounters & { at: number }) | null = null;
  private net: { rx: number; tx: number; at: number } | null = null;
  private gpus: { list: GpuMetrics[]; at: number } | null = null;
  private last: { metrics: MachineMetrics; at: number } | null = null;
  private readonly reported = new Set<string>();

  constructor(private readonly options: MachineSamplerOptions) {
    this.probes = { ...defaultProbes, ...options.probes };
    this.intervalMs = options.intervalMs ?? METRICS_SAMPLE_SECONDS * 1000;
    this.path = this.probes.platform === 'win32' ? nodePath.win32 : nodePath.posix;
    this.dirs = [...new Set(options.dirs.filter(Boolean).map((d) => this.path.resolve(d)))];
    if (options.gpu !== false) this.commands.push('gpu');
    if (this.probes.platform === 'win32') this.commands.push('net');
  }

  /** Đo ngay một lần rồi đo theo chu kỳ; timer không giữ tiến trình sống. */
  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Bản đo mới nhất nếu chưa cũ quá `maxAgeMs` (mặc định 2 phút). */
  latest(maxAgeMs = METRICS_MAX_AGE_MS): MachineMetrics | undefined {
    if (!this.last || this.probes.now() - this.last.at > maxAgeMs) return undefined;
    return this.last.metrics;
  }

  /** Lần đo đang chạy chưa xong (lệnh treo tới timeout) thì bỏ lượt này. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sample();
    } catch (err) {
      this.report('sample', err);
    } finally {
      this.running = false;
    }
  }

  /** Một lần đo; trả và giữ bản đo đã kiểm theo `MachineMetricsSchema` (số lệch khỏi giới hạn bị bỏ). */
  async sample(): Promise<MachineMetrics> {
    const p = this.probes;
    const m: MachineMetrics = {};

    // CPU: chênh lệch thời gian idle giữa hai lần đo. Lần đầu chưa có gì để so.
    try {
      const cur = p.cpuTimes();
      if (this.prevCpu) {
        const total = cur.total - this.prevCpu.total;
        const idle = cur.idle - this.prevCpu.idle;
        if (total > 0) m.cpu_pct = round1(clamp((1 - idle / total) * 100, 0, 100));
      }
      this.prevCpu = cur;
    } catch (err) {
      this.report('cpu', err);
    }

    try {
      const mem = p.memory();
      if (mem.total > 0) {
        m.ram_total_mb = Math.max(1, Math.round(mem.total / MB));
        m.ram_used_mb = Math.max(0, Math.round((mem.total - mem.free) / MB));
      }
    } catch (err) {
      this.report('memory', err);
    }

    const disks = await this.disks();
    if (disks.length) m.disks = disks;

    // Một lệnh mỗi lần đo: GPU và mạng (Windows) thay phiên nhau.
    if (this.commands.length) {
      const probe = this.commands[this.nextCommand % this.commands.length]!;
      this.nextCommand = (this.nextCommand + 1) % Math.max(1, this.commands.length);
      if (probe === 'gpu') await this.readGpus();
      else await this.readNetWindows();
    }
    if (p.platform === 'linux') await this.readNetLinux();

    const fresh = p.now() - 3 * this.intervalMs - 1_000;
    if (this.net && this.net.at >= fresh) {
      m.net_rx_bps = Math.round(this.net.rx);
      m.net_tx_bps = Math.round(this.net.tx);
    }
    if (this.gpus && this.gpus.at >= fresh && this.gpus.list.length) m.gpus = this.gpus.list;

    try {
      const up = p.uptime();
      if (Number.isFinite(up) && up >= 0) m.uptime_s = Math.floor(up);
    } catch (err) {
      this.report('uptime', err);
    }

    const checked = MachineMetricsSchema.safeParse(m);
    const metrics = checked.success ? checked.data : {};
    if (!checked.success) this.report('schema', checked.error);
    this.last = { metrics, at: p.now() };
    return metrics;
  }

  private async disks(): Promise<DiskMetrics[]> {
    const out: DiskMetrics[] = [];
    const seen = new Set<string>();
    for (const dir of this.dirs) {
      try {
        const existing = await this.existingAncestor(dir);
        if (!existing) continue;
        const dev = await this.probes.device(existing);
        const s = await this.probes.statfs(existing);
        const total = Math.floor((s.blocks * s.bsize) / MB);
        const free = Math.floor((s.bavail * s.bsize) / MB);
        // Cùng thiết bị (cùng ổ) chỉ một dòng. dev = 0 (một số hệ file không báo) thì gộp theo dung lượng.
        const key = dev ? `dev:${dev}` : `size:${total}`;
        if (seen.has(key) || total <= 0) continue;
        seen.add(key);
        out.push({ path: this.diskLabel(existing), free_mb: Math.max(0, Math.min(free, total)), total_mb: total });
      } catch (err) {
        this.report(`disk:${dir}`, err);
      }
      if (out.length >= 16) break;
    }
    return out;
  }

  /** `C:` trên Windows; đường dẫn đo được trên Linux/macOS. */
  private diskLabel(path: string): string {
    if (this.probes.platform === 'win32') {
      const root = this.path.parse(path).root.replace(/[\\/]+$/, '');
      return (root || path).slice(0, 260);
    }
    return path.slice(0, 260);
  }

  private async existingAncestor(dir: string): Promise<string | null> {
    let cur = dir;
    for (let i = 0; i < 64; i++) {
      try {
        await this.probes.device(cur);
        return cur;
      } catch {
        const up = this.path.dirname(cur);
        if (up === cur) return null;
        cur = up;
      }
    }
    return null;
  }

  private async readGpus(): Promise<void> {
    try {
      const { stdout } = await this.probes.exec('nvidia-smi', NVIDIA_SMI_ARGS, { timeout: METRICS_COMMAND_TIMEOUT_MS });
      this.gpus = { list: parseNvidiaSmi(stdout), at: this.probes.now() };
    } catch (err) {
      if (isMissingCommand(err)) this.drop('gpu');
      this.report('gpu', err);
    }
  }

  private async readNetWindows(): Promise<void> {
    try {
      const { stdout } = await this.probes.exec('netstat', ['-e'], { timeout: METRICS_COMMAND_TIMEOUT_MS });
      const counters = parseNetstatE(stdout);
      if (counters) this.updateNet(counters, true);
      else this.report('net', new Error('netstat -e: no byte counters'));
    } catch (err) {
      if (isMissingCommand(err)) this.drop('net');
      this.report('net', err);
    }
  }

  private async readNetLinux(): Promise<void> {
    try {
      const counters = parseProcNetDev(await this.probes.readFile('/proc/net/dev'));
      if (counters) this.updateNet(counters, false);
    } catch (err) {
      this.report('net', err);
    }
  }

  private updateNet(cur: NetCounters, wraps32: boolean): void {
    const at = this.probes.now();
    const prev = this.prevNet;
    this.prevNet = { ...cur, at };
    if (!prev) return;
    const seconds = (at - prev.at) / 1000;
    const rx = counterRate(prev.rx, cur.rx, seconds, wraps32);
    const tx = counterRate(prev.tx, cur.tx, seconds, wraps32);
    if (rx === undefined || tx === undefined) return;
    this.net = { rx, tx, at };
  }

  private drop(probe: CommandProbe): void {
    const i = this.commands.indexOf(probe);
    if (i >= 0) this.commands.splice(i, 1);
    if (probe === 'gpu') this.gpus = null;
  }

  private report(what: string, err: unknown): void {
    const kind = what.split(':')[0]!;
    if (this.reported.has(kind)) return;
    this.reported.add(kind);
    this.options.onError?.(what, err);
  }
}

function isMissingCommand(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'ENOENT';
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
