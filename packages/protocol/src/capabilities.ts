import { z } from 'zod';

export const GpuSchema = z.strictObject({
  name: z.string().max(200),
  vram_mb: z.int().nonnegative(),
  nvenc: z.boolean(),
  nvdec: z.boolean(),
});
export type Gpu = z.infer<typeof GpuSchema>;

export const CapabilitiesSchema = z.strictObject({
  os: z.enum(['windows', 'linux', 'darwin']),
  cpu_cores: z.int().positive(),
  ram_mb: z.int().positive(),
  gpus: z.array(GpuSchema).max(16),
  engines: z.strictObject({
    /** Dòng phiên bản ffmpeg, `null` nếu không có. */
    ffmpeg: z.string().max(300).nullable(),
    ollama_models: z.array(z.string().max(200)).max(200),
    /** Phiên bản Python có torch dùng được, `null` nếu không có. */
    python: z.string().max(100).nullable(),
    /**
     * Phiên bản yt-dlp worker chạy được (`yt-dlp --version`). Tuỳ chọn: worker không dò thì không gửi. Hub build trước
     * khi có trường này từ chối heartbeat có nó (`strictObject`): lên hub trước rồi mới lên worker.
     */
    ytdlp: z.string().max(100).nullable().optional(),
    /**
     * Mức tính năng composition Studio mà máy render dựng được (`RENDER_FEATURE_LEVEL` của `@ag-studio/render`, tăng
     * mỗi khi composition có trường mới). Không gửi = 0. Hub build trước khi có trường này từ chối nó: lên hub trước.
     */
    studio_render: z.int().nonnegative().optional(),
  }),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const SlotsSchema = z.strictObject({
  cpu: z.int().nonnegative(),
  gpu: z.int().nonnegative(),
});
export type Slots = z.infer<typeof SlotsSchema>;

/** Điều kiện job đòi ở máy. Mọi trường là tuỳ chọn; thiếu nghĩa là không đòi. */
export const RequirementsSchema = z.strictObject({
  gpu: z.boolean().optional(),
  min_vram_mb: z.int().positive().optional(),
  nvenc: z.boolean().optional(),
  /** Mọi model trong danh sách phải có sẵn trong Ollama của máy. */
  ollama_models: z.array(z.string().max(200)).max(10).optional(),
  python: z.boolean().optional(),
  /** Máy có yt-dlp (`engines.ytdlp`). */
  ytdlp: z.boolean().optional(),
  os: z.enum(['windows', 'linux']).optional(),
  /**
   * Chỉ máy có id này nhận job (chủ job ghim một máy cụ thể, xem `GET /v1/owner/nodes`). Hub và worker build trước
   * khi có trường này từ chối requirements có nó (`strictObject`).
   */
  node_id: z.uuid().optional(),
  /**
   * Máy khai `engines.studio_render` ít nhất bằng số này: composition dùng trường mới thì máy render bản cũ (bộ kiểm
   * strict của nó từ chối) không nhận job. Hub build trước khi có trường này từ chối requirements có nó.
   */
  studio_render_min: z.int().positive().optional(),
});
export type Requirements = z.infer<typeof RequirementsSchema>;

/** Máy có đáp ứng `requirements` không. Hub dùng khi claim; worker có thể dùng để tự kiểm. */
export function meetsRequirements(capabilities: Capabilities, requirements: Requirements): boolean {
  if (requirements.os && capabilities.os !== requirements.os) return false;
  const gpus = capabilities.gpus;
  if (requirements.gpu && gpus.length === 0) return false;
  if (requirements.min_vram_mb !== undefined) {
    const min = requirements.min_vram_mb;
    if (!gpus.some((gpu) => gpu.vram_mb >= min)) return false;
  }
  if (requirements.nvenc && !gpus.some((gpu) => gpu.nvenc)) return false;
  if (requirements.python && !capabilities.engines.python) return false;
  if (requirements.ytdlp && !capabilities.engines.ytdlp) return false;
  if (requirements.studio_render_min !== undefined && (capabilities.engines.studio_render ?? 0) < requirements.studio_render_min) {
    return false;
  }
  if (requirements.ollama_models?.length) {
    const available = new Set(capabilities.engines.ollama_models.map(normalizeModelName));
    if (!requirements.ollama_models.every((model) => available.has(normalizeModelName(model)))) {
      return false;
    }
  }
  return true;
}

/** `meetsRequirements` cộng thêm việc ghim máy: job có `node_id` chỉ cho đúng máy đó. Hub dùng khi claim. */
export function nodeMeetsRequirements(nodeId: string, capabilities: Capabilities, requirements: Requirements): boolean {
  if (requirements.node_id && requirements.node_id !== nodeId) return false;
  return meetsRequirements(capabilities, requirements);
}

/** Ollama coi `qwen2.5vl` và `qwen2.5vl:latest` là một. */
export function normalizeModelName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  return trimmed.includes(':') ? trimmed : `${trimmed}:latest`;
}
