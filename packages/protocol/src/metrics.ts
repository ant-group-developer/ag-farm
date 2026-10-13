import { z } from 'zod';

/**
 * Số đo tình trạng máy (worker-sdk đo nền mỗi `METRICS_SAMPLE_SECONDS`, gửi bản mới nhất ở heartbeat). Mọi trường
 * là tuỳ chọn: số nào máy không đo được thì bỏ hẳn trường đó (không gửi 0 giả).
 */
export const METRICS_SAMPLE_SECONDS = 15;

/** MB: tới 1 EB, đủ cho mọi ổ/RAM thật mà vẫn chặn số rác. */
const MB_MAX = 1_000_000_000;

export const DiskMetricsSchema = z.strictObject({
  /** Ổ chứa `work_dir`/cache: `C:` trên Windows, đường dẫn thư mục trên Linux. */
  path: z.string().min(1).max(260),
  free_mb: z.int().nonnegative().max(MB_MAX),
  total_mb: z.int().positive().max(MB_MAX),
});
export type DiskMetrics = z.infer<typeof DiskMetricsSchema>;

export const GpuMetricsSchema = z.strictObject({
  /** Số thứ tự GPU theo `nvidia-smi` (khớp thứ tự `capabilities.gpus`). */
  index: z.int().min(0).max(63),
  util_pct: z.number().min(0).max(100).optional(),
  vram_used_mb: z.int().nonnegative().max(MB_MAX).optional(),
  vram_total_mb: z.int().nonnegative().max(MB_MAX).optional(),
  temp_c: z.number().min(-50).max(150).optional(),
});
export type GpuMetrics = z.infer<typeof GpuMetricsSchema>;

export const MachineMetricsSchema = z.strictObject({
  /** CPU đang dùng, % của mọi lõi (trung bình từ lần đo trước). */
  cpu_pct: z.number().min(0).max(100).optional(),
  ram_used_mb: z.int().nonnegative().max(MB_MAX).optional(),
  ram_total_mb: z.int().positive().max(MB_MAX).optional(),
  /** Ổ của `work_dir` và cache (cùng ổ thì một dòng). */
  disks: z.array(DiskMetricsSchema).max(16).optional(),
  /** Byte/giây vào/ra, cộng các card mạng của máy. */
  net_rx_bps: z.number().nonnegative().max(1e12).optional(),
  net_tx_bps: z.number().nonnegative().max(1e12).optional(),
  gpus: z.array(GpuMetricsSchema).max(16).optional(),
  /** Máy đã chạy bao lâu (giây). */
  uptime_s: z.int().nonnegative().max(1e10).optional(),
});
export type MachineMetrics = z.infer<typeof MachineMetricsSchema>;
