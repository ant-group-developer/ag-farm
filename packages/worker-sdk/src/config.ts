/**
 * Đọc và kiểm cấu hình worker từ file YAML.
 * Hỗ trợ lịch chạy theo tuần (schedule), cho phép cửa sổ qua đêm.
 */
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { JobTypeSchema } from '@ag-farm/protocol';

// ---- Lịch chạy ----

const DaySchema = z.int().min(0).max(6); // 0=Chu nhat..6=Thu 7
const TimeStringSchema = z.string().regex(/^\d{2}:\d{2}$/);

export const ScheduleWindowSchema = z.strictObject({
  /** Các ngày trong tuần (0=Chủ nhật). */
  days: z.array(DaySchema).min(1).max(7),
  /** Thời điểm bắt đầu, dạng 'HH:MM'. */
  from: TimeStringSchema,
  /** Thời điểm kết thúc, dạng 'HH:MM'. Có thể nhỏ hơn `from` (cửa sổ qua đêm). */
  to: TimeStringSchema,
});
export type ScheduleWindow = z.infer<typeof ScheduleWindowSchema>;

// ---- Cấu hình chính ----

export const WorkerConfigSchema = z
  .object({
    /** URL của ag-farm hub, ví dụ https://farm.example.com */
    hub_url: z.string().min(1),
    /** Token node (ưu tiên hơn token_file). */
    token: z.string().min(1).optional(),
    /** Đường dẫn tới file chứa token (chỉ đọc khi không có `token`). */
    token_file: z.string().min(1).optional(),
    /** Tên hiển thị của node này. */
    name: z.string().min(1).max(100),
    /** Loại job node này nhận. */
    kinds: z.array(JobTypeSchema).min(1),
    /** Thư mục làm việc tạm cho mỗi job. */
    work_dir: z.string().min(1),
    cache: z.object({
      dir: z.string().min(1),
      max_gb: z.number().positive(),
    }),
    /** Đường dẫn file machine.yaml; mặc định theo OS. */
    machine_file: z.string().min(1).optional(),
    /**
     * Lịch chạy tuần (tuỳ chọn; vắng mặt = chạy 24/7).
     * Ví dụ: [{days:[1,2,3,4,5], from:'19:00', to:'07:00'}]
     */
    schedule: z.array(ScheduleWindowSchema).optional(),
    /** Passthrough: các trường tuỳ worker, ví dụ ollama_url. */
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

const DEFAULT_MACHINE_FILE =
  os.platform() === 'win32'
    ? 'C:\\ProgramData\\ag-farm\\machine.yaml'
    : '/etc/ag-farm/machine.yaml';

/** Đọc và kiểm cấu hình từ file YAML. */
export function loadConfig(filePath: string): WorkerConfig {
  const raw = readFileSync(filePath, 'utf8');
  const parsed = parseYaml(raw) as unknown;
  const cfg = WorkerConfigSchema.parse(parsed);

  if (!cfg.token && !cfg.token_file) {
    throw new Error('Cau hinh thieu: phai co token hoac token_file');
  }
  if (!cfg.machine_file) {
    (cfg as Record<string, unknown>)['machine_file'] = DEFAULT_MACHINE_FILE;
  }
  return cfg;
}

/** Đọc token từ cấu hình hoặc từ file. */
export function resolveToken(config: WorkerConfig): string {
  if (config.token) return config.token;
  if (config.token_file) return readFileSync(config.token_file, 'utf8').trim();
  throw new Error('Khong tim thay token');
}

// ---- Kiểm lịch chạy ----

/**
 * Trả về true nếu `now` nằm trong ít nhất một cửa sổ lịch.
 * Cửa sổ qua đêm (from > to) chia làm hai nhánh: [from, 24:00) và [00:00, to).
 * Không có cửa sổ nào → chạy 24/7 → true.
 */
export function isWithinSchedule(windows: ScheduleWindow[], now: Date = new Date()): boolean {
  if (!windows.length) return true;

  const day = now.getDay();
  const hhmm =
    String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

  for (const w of windows) {
    if (!w.days.includes(day)) continue;
    const { from, to } = w;
    // Cửa sổ qua đêm: from > to (ví dụ 19:00 → 07:00)
    if (from > to) {
      if (hhmm >= from || hhmm < to) return true;
    } else {
      if (hhmm >= from && hhmm < to) return true;
    }
  }
  return false;
}
