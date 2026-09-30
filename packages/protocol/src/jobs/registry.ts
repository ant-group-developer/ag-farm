import { z } from 'zod';
import type { JobType, Lane } from '../common';
import { RequirementsSchema, type Requirements } from '../capabilities';
import { ScanAiPayloadSchema, ScanExtractPayloadSchema } from './scan';
import { StudioRenderPayloadSchema, StudioTtsPayloadSchema, StudioExportPremierePayloadSchema } from './studio';

export type SlotKind = 'cpu' | 'gpu';

export type JobTypeSpec = {
  /** Chủ job được phép gửi loại này. */
  owner: string;
  lane: Lane;
  /** Loại slot của máy mà job chiếm khi chạy. */
  slot: SlotKind;
  payload: z.ZodType;
  /** Điều kiện tối thiểu hub luôn áp, cộng với `requirements` chủ job gửi. */
  baseRequirements: Requirements;
};

export const JOB_TYPE_SPECS: Record<JobType, JobTypeSpec> = {
  'scan.extract': {
    owner: 'ag-go',
    lane: 'batch',
    slot: 'cpu',
    payload: ScanExtractPayloadSchema,
    baseRequirements: {},
  },
  'scan.ai': {
    owner: 'ag-go',
    lane: 'batch',
    slot: 'gpu',
    payload: ScanAiPayloadSchema,
    baseRequirements: { gpu: true },
  },
  'studio.tts': {
    owner: 'studio',
    lane: 'interactive',
    slot: 'gpu',
    payload: StudioTtsPayloadSchema,
    baseRequirements: { gpu: true, python: true },
  },
  'studio.render_preview': {
    owner: 'studio',
    lane: 'interactive',
    slot: 'cpu',
    payload: StudioRenderPayloadSchema,
    baseRequirements: {},
  },
  'studio.render_final': {
    owner: 'studio',
    lane: 'interactive',
    slot: 'cpu',
    payload: StudioRenderPayloadSchema,
    baseRequirements: {},
  },
  'studio.export_premiere': {
    owner: 'studio',
    lane: 'interactive',
    slot: 'cpu',
    payload: StudioExportPremierePayloadSchema,
    baseRequirements: {},
  },
};

/** Gộp điều kiện gốc của loại job với điều kiện chủ job gửi (chủ job chỉ được siết thêm). */
export function mergeRequirements(type: JobType, extra: Requirements): Requirements {
  const base = JOB_TYPE_SPECS[type].baseRequirements;
  const merged: Requirements = { ...extra };
  if (base.gpu) merged.gpu = true;
  if (base.python) merged.python = true;
  if (base.nvenc) merged.nvenc = true;
  if (base.os) merged.os = base.os;
  if (base.min_vram_mb !== undefined) {
    merged.min_vram_mb = Math.max(base.min_vram_mb, extra.min_vram_mb ?? 0);
  }
  if (base.ollama_models?.length) {
    merged.ollama_models = [...new Set([...(extra.ollama_models ?? []), ...base.ollama_models])];
  }
  return RequirementsSchema.parse(merged);
}
