/**
 * Đọc machine.yaml và quản lý slot cấp máy qua lock file.
 * Mọi worker process trên cùng một máy dùng chung các lock file này,
 * nên hai worker không tranh slot CPU/GPU lẫn nhau.
 *
 * Lock file nằm ở <dir(machine_file)>/locks/<kind>-<n>.lock
 * Nội dung: "<pid> <start_time_ms>\n"
 * Tạo bằng cờ 'wx' (exclusive create); nếu đã có → slot đang dùng.
 * Phát hiện lock cũ: process.kill(pid, 0) → ESRCH → xoá lock.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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

  // ---- private ----

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
