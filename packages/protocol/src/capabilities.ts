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
  os: z.enum(['windows', 'linux']).optional(),
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
  if (requirements.ollama_models?.length) {
    const available = new Set(capabilities.engines.ollama_models.map(normalizeModelName));
    if (!requirements.ollama_models.every((model) => available.has(normalizeModelName(model)))) {
      return false;
    }
  }
  return true;
}

/** Ollama coi `qwen2.5vl` và `qwen2.5vl:latest` là một. */
export function normalizeModelName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  return trimmed.includes(':') ? trimmed : `${trimmed}:latest`;
}
