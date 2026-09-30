/**
 * Đọc machine.yaml và quản lý slot cấp máy qua lock file.
 * Mọi worker process trên cùng một máy dùng chung các lock file này,
 * nên hai worker không tranh slot CPU/GPU lẫn nhau.
 *
 * Lock file nằm ở <dir(machine_file)>/locks/<kind>-<n>.lock
 * Nội dung: "<pid> <start_time_ms>\n"
 * Tạo bằng cờ 'wx' (exclusive create); nếu đã có → slot đang dùng.
 * Phát hiện lock cũ: process.kill(pid, 0) → ESRCH → xoá lock.
 *
 * Cùng thư mục còn có cờ ưu tiên cho việc interactive (Studio) trên máy:
 *   interactive-<pid>-<tag>.lock  một job interactive đang chạy hoặc đang chờ slot
 *   wanted-<pid>.lock             hub báo còn job interactive chờ vì máy hết slot (làm mới mỗi vòng claim)
 * Khi có cờ, worker batch ngừng nhận việc mới và job batch đang chạy nhường slot (`interactivePressure`).
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const MachineConfigSchema = z.strictObject({
  cpu_slots: z.int().positive(),
  gpu_slots: z.int().nonnegative(),
  reserve_interactive: z
    .strictObject({
      cpu: z.int().nonnegative(),
      gpu: z.int().nonnegative(),
    })
    .default({ cpu: 0, gpu: 0 }),
});
export type MachineConfig = z.infer<typeof MachineConfigSchema>;

/** Cờ `wanted-*` cũ hơn chừng này thì bỏ qua: worker interactive làm mới nó mỗi vòng claim (~1 s). */
const WANTED_TTL_MS = 15_000;

export type SlotKind = 'cpu' | 'gpu';

/** Đọc machine.yaml; ném lỗi nếu file không có hoặc schema sai. */
export function loadMachineConfig(machineFile: string): MachineConfig {
  const raw = readFileSync(machineFile, 'utf8');
  const parsed = parseYaml(raw) as unknown;
  return MachineConfigSchema.parse(parsed);
}

/** Thông tin của một slot đang bị chiếm. */
export interface SlotHandle {
  kind: SlotKind;
  index: number;
  lockPath: string;
}

/** Lane của job đang nhận. */
export type ClaimLane = 'batch' | 'interactive';

export class SlotAllocator {
  private readonly lockDir: string;

  constructor(
    private readonly machineConfig: MachineConfig,
    machineFile: string,
  ) {
    this.lockDir = join(dirname(machineFile), 'locks');
    mkdirSync(this.lockDir, { recursive: true });
  }

  /** Số slot đang rảnh (sau khi gặp lock cũ). */
  freeSlots(): { cpu: number; gpu: number } {
    const cpuUsed = this.countUsed('cpu', this.machineConfig.cpu_slots);
    const gpuUsed = this.countUsed('gpu', this.machineConfig.gpu_slots);
    return {
      cpu: Math.max(0, this.machineConfig.cpu_slots - cpuUsed),
      gpu: Math.max(0, this.machineConfig.gpu_slots - gpuUsed),
    };
  }

  /**
   * Cố gắng chiếm một slot. Trả về SlotHandle nếu thành công, null nếu hết slot.
   * `lane` dùng để kiểm reserve_interactive: job batch không lấy slot dự trữ.
   */
  acquire(kind: SlotKind, options: { lane: ClaimLane }): SlotHandle | null {
    const total =
      kind === 'cpu' ? this.machineConfig.cpu_slots : this.machineConfig.gpu_slots;
    const reserve =
      kind === 'cpu'
        ? this.machineConfig.reserve_interactive.cpu
        : this.machineConfig.reserve_interactive.gpu;

    // Slot cuối cùng được giữ riêng cho job interactive
    const maxForBatch = total - reserve;

    for (let i = 0; i < total; i++) {
      // Job batch không lấy các slot dành cho interactive
      if (options.lane === 'batch' && i >= maxForBatch) continue;

      const lockPath = join(this.lockDir, `${kind}-${i}.lock`);
      if (this.tryAcquireLock(lockPath)) {
        return { kind, index: i, lockPath };
      }
    }
    return null;
  }

  /**
   * Slot trống mà job của `lane` được lấy: job batch không tính các slot giữ cho interactive (cùng quy tắc
   * với `acquire`). Worker xin việc theo con số này nên job nhận về luôn chiếm được slot.
   */
  freeSlotsFor(lane: ClaimLane): { cpu: number; gpu: number } {
    const count = (kind: SlotKind): number => {
      const total = kind === 'cpu' ? this.machineConfig.cpu_slots : this.machineConfig.gpu_slots;
      const reserve =
        kind === 'cpu' ? this.machineConfig.reserve_interactive.cpu : this.machineConfig.reserve_interactive.gpu;
      const limit = lane === 'batch' ? Math.max(0, total - reserve) : total;
      let free = 0;
      for (let i = 0; i < limit; i++) {
        if (!this.isLocked(join(this.lockDir, `${kind}-${i}.lock`))) free++;
      }
      return free;
    };
    return { cpu: count('cpu'), gpu: count('gpu') };
  }

  /** Giải phóng slot đã chiếm. */
  release(handle: SlotHandle): void {
    try {
      unlinkSync(handle.lockPath);
    } catch {
      // Đã bị xoá, không sao
    }
  }

  /** Đánh dấu máy đang có một job interactive (chạy hoặc chờ slot). Trả đường dẫn cờ để gỡ. */
  markInteractive(tag: string): string {
    const safeTag = tag.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
    const flagPath = join(this.lockDir, `interactive-${process.pid}-${safeTag}.lock`);
    writeFileSync(flagPath, `${process.pid} ${Date.now()}\n`);
    return flagPath;
  }

  /** Gỡ cờ do `markInteractive` tạo. */
  clearFlag(flagPath: string): void {
    try {
      unlinkSync(flagPath);
    } catch {
      // Đã bị xoá, không sao
    }
  }

  /**
   * Bật/tắt cờ "hub còn job interactive chờ slot" của process này. Bật lại mỗi vòng claim để làm mới
   * thời điểm; cờ quá `WANTED_TTL_MS` coi như hết hiệu lực (process còn sống nhưng đã thôi claim).
   */
  setWanted(on: boolean): void {
    const flagPath = join(this.lockDir, `wanted-${process.pid}.lock`);
    if (on) {
      writeFileSync(flagPath, `${process.pid} ${Date.now()}\n`);
    } else {
      this.clearFlag(flagPath);
    }
  }

  /** Có job interactive đang chạy, đang chờ slot, hoặc đang chờ trên hub vì máy hết slot. */
  interactivePressure(): boolean {
    let names: string[];
    try {
      names = readdirSync(this.lockDir);
    } catch {
      return false;
    }
    for (const name of names) {
      const flagPath = join(this.lockDir, name);
      if (name.startsWith('interactive-') && this.isLocked(flagPath)) return true;
      if (name.startsWith('wanted-') && this.isFresh(flagPath, WANTED_TTL_MS) && this.isLocked(flagPath)) return true;
    }
    return false;
  }

  // ---- private ----

  private isFresh(flagPath: string, ttlMs: number): boolean {
    try {
      const [, tsStr] = readFileSync(flagPath, 'utf8').trim().split(' ');
      const ts = Number(tsStr);
      return Number.isFinite(ts) && Date.now() - ts <= ttlMs;
    } catch {
      return false;
    }
  }

  private countUsed(kind: SlotKind, total: number): number {
    let used = 0;
    for (let i = 0; i < total; i++) {
      const lockPath = join(this.lockDir, `${kind}-${i}.lock`);
      if (this.isLocked(lockPath)) used++;
    }
    return used;
  }

  private isLocked(lockPath: string): boolean {
    if (!existsSync(lockPath)) return false;
    // Kiểm xem process còn sống không
    try {
      const content = readFileSync(lockPath, 'utf8').trim();
      const [pidStr] = content.split(' ');
      if (!pidStr) return false;
      const pid = parseInt(pidStr, 10);
      if (!Number.isFinite(pid) || pid <= 0) return false;

      try {
        process.kill(pid, 0);
        return true; // Process còn sống
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') {
          // Process đã chết → xoá lock cũ
          try {
            unlinkSync(lockPath);
          } catch {
            // Race condition, không sao
          }
          return false;
        }
        // EPERM: process tồn tại nhưng không có quyền signal → coi như còn sống
        return true;
      }
    } catch {
      return false;
    }
  }

  private tryAcquireLock(lockPath: string): boolean {
    // Trước hết kiểm lock cũ
    if (this.isLocked(lockPath)) return false;

    // Thử tạo bằng cờ 'wx' (exclusive create)
    try {
      const fd = openSync(lockPath, 'wx');
      const content = `${process.pid} ${Date.now()}\n`;
      writeFileSync(lockPath, content);
      try { closeSync(fd); } catch { /* ignore */ }
      return true;
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      throw e;
    }
  }
}
