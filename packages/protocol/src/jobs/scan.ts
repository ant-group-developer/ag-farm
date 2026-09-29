import { z } from 'zod';
import { InputNameSchema, RelativePathSchema } from '../common';

// ---------------------------------------------------------------------------------------------
// scan.extract: tải file gốc → proxy 720p → dò cắt cảnh → chia đoạn → keyframe + chỉ số kỹ thuật
// Input: `source` (file gốc). Output: dưới thư mục analysis của chủ job; manifest `extract.json`.
// ---------------------------------------------------------------------------------------------

export const ScanExtractParamsSchema = z.strictObject({
  /** Cửa sổ chia đoạn (giây). */
  window_s: z.number().positive().default(4),
  /** Trần độ dài một đoạn sau khi gộp (giây). */
  max_segment_s: z.number().positive().default(20),
  /** Đoạn ngắn hơn (giây) gộp vào đoạn bên cạnh giống hơn. */
  min_segment_s: z.number().nonnegative().default(1.5),
  /** Hai cửa sổ liền kề gộp khi khoảng cách Hamming dHash ≤ ngưỡng này (0–64). */
  merge_dhash_max_distance: z.int().min(0).max(64).default(10),
  /** Ngưỡng `scene` của ffmpeg (0–1). */
  scene_threshold: z.number().min(0).max(1).default(0.3),
  keyframes_per_segment: z.int().min(1).max(3).default(3),
  /** Cạnh dài của keyframe (px). */
  keyframe_px: z.int().min(160).max(1920).default(640),
  proxy: z
    .strictObject({
      enabled: z.boolean().default(true),
      height: z.int().min(240).max(1080).default(720),
      crf: z.int().min(16).max(40).default(26),
      gop_s: z.number().positive().default(1),
    })
    .default({ enabled: true, height: 720, crf: 26, gop_s: 1 }),
  contact_sheet: z
    .strictObject({
      enabled: z.boolean().default(true),
      columns: z.int().min(1).max(12).default(6),
      tile_px: z.int().min(80).max(640).default(320),
    })
    .default({ enabled: true, columns: 6, tile_px: 320 }),
  /** Ngưỡng coi một đoạn là "chết" về kỹ thuật. */
  dead: z
    .strictObject({
      black_ratio_min: z.number().min(0).max(1).default(0.9),
      frozen_ratio_min: z.number().min(0).max(1).default(0.95),
      /** Điểm mờ (blurdetect, càng cao càng mờ) từ ngưỡng này trở lên coi là mờ hẳn. */
      blur_min: z.number().nonnegative().default(12),
    })
    .default({ black_ratio_min: 0.9, frozen_ratio_min: 0.95, blur_min: 12 }),
});
export type ScanExtractParams = z.infer<typeof ScanExtractParamsSchema>;

export const ScanExtractPayloadSchema = z.strictObject({
  asset: z.strictObject({
    id: z.uuid(),
    kind: z.enum(['video', 'image']),
    mime_type: z.string().max(120),
    size_bytes: z.int().nonnegative().nullable(),
    checksum_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    duration_ms: z.int().nonnegative().nullable(),
    width: z.int().positive().nullable(),
    height: z.int().positive().nullable(),
  }),
  params: ScanExtractParamsSchema.default(ScanExtractParamsSchema.parse({})),
  extract_version: z.string().min(1).max(40),
});
export type ScanExtractPayload = z.infer<typeof ScanExtractPayloadSchema>;

export const OrientationSchema = z.enum(['landscape', 'portrait', 'square']);
export type Orientation = z.infer<typeof OrientationSchema>;

export const KeyframeSchema = z.strictObject({
  output: RelativePathSchema,
  t_ms: z.int().nonnegative(),
  width: z.int().positive(),
  height: z.int().positive(),
  /** dHash 64 bit dạng 16 ký tự hex. */
  dhash: z.string().regex(/^[0-9a-f]{16}$/),
});
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const SegmentTechnicalSchema = z.strictObject({
  /** Độ sáng trung bình 0–1 (signalstats YAVG / 255). */
  brightness: z.number().min(0).max(1).nullable(),
  /** Điểm mờ trung bình của blurdetect; càng cao càng mờ. */
  blur: z.number().nonnegative().nullable(),
  black_ratio: z.number().min(0).max(1),
  frozen_ratio: z.number().min(0).max(1),
  /** Tỉ lệ im lặng; `null` khi không có audio. */
  silence_ratio: z.number().min(0).max(1).nullable(),
  dead: z.boolean(),
  dead_reason: z.enum(['black', 'frozen', 'blurry']).nullable(),
});
export type SegmentTechnical = z.infer<typeof SegmentTechnicalSchema>;

export const ExtractSegmentSchema = z.strictObject({
  index: z.int().nonnegative(),
  /** Mốc thời gian theo timeline file gốc (ms). Ảnh tĩnh: 0 và 0. */
  start_ms: z.int().nonnegative(),
  end_ms: z.int().nonnegative(),
  boundary_reason: z.enum(['scene_cut', 'window', 'max_length', 'end', 'still']),
  orientation: OrientationSchema,
  keyframes: z.array(KeyframeSchema).min(1).max(3),
  technical: SegmentTechnicalSchema,
});
export type ExtractSegment = z.infer<typeof ExtractSegmentSchema>;

export const EXTRACT_MANIFEST_SCHEMA = 'ag.scan.extract/v1';
export const EXTRACT_MANIFEST_PATH = 'extract.json';

export const ExtractManifestSchema = z.strictObject({
  schema: z.literal(EXTRACT_MANIFEST_SCHEMA),
  asset_id: z.uuid(),
  extract_version: z.string(),
  media: z.strictObject({
    kind: z.enum(['video', 'image']),
    duration_ms: z.int().nonnegative(),
    width: z.int().positive(),
    height: z.int().positive(),
    fps: z.number().positive().nullable(),
    has_audio: z.boolean(),
    /** Góc xoay trong metadata (0/90/180/270); width/height ở trên đã tính xoay. */
    rotation: z.int(),
  }),
  proxy: z
    .strictObject({
      output: RelativePathSchema,
      width: z.int().positive(),
      height: z.int().positive(),
      size_bytes: z.int().nonnegative(),
    })
    .nullable(),
  contact_sheet: z
    .strictObject({
      output: RelativePathSchema,
      columns: z.int().positive(),
      rows: z.int().positive(),
    })
    .nullable(),
  segments: z.array(ExtractSegmentSchema).min(1),
  tools: z.strictObject({
    ffmpeg: z.string().nullable(),
    worker_version: z.string(),
  }),
});
export type ExtractManifest = z.infer<typeof ExtractManifestSchema>;

// ---------------------------------------------------------------------------------------------
// scan.ai: Qwen-VL (Ollama) mô tả một cụm đoạn từ keyframe. Input: keyframe của các đoạn.
// Output: `ai-<chunk>.json`.
// ---------------------------------------------------------------------------------------------

export const SHOT_SIZES = ['extreme_wide', 'wide', 'medium', 'close_up', 'extreme_close_up', 'unknown'] as const;
export const CAMERA_MOTIONS = ['static', 'pan', 'tilt', 'zoom', 'dolly', 'handheld', 'aerial', 'unknown'] as const;
export const TIMES_OF_DAY = ['day', 'night', 'golden_hour', 'indoor', 'unknown'] as const;
export const SETTINGS = ['indoor', 'outdoor', 'mixed', 'unknown'] as const;
export const PEOPLE_COUNTS = ['none', 'one', 'few', 'many', 'crowd'] as const;

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

const ShortListSchema = (max: number) => z.array(z.string().min(1).max(60)).max(max);

export const SegmentDescriptionSchema = z.strictObject({
  caption_vi: z
    .string()
    .min(1)
    .max(400)
    .refine((value) => wordCount(value) <= 40, { message: 'caption_vi must be at most 40 words' }),
  caption_en: z
    .string()
    .min(1)
    .max(300)
    .refine((value) => wordCount(value) <= 30, { message: 'caption_en must be at most 30 words' }),
  tags: ShortListSchema(20),
  keywords_vi: ShortListSchema(20),
  subjects: ShortListSchema(10),
  actions: ShortListSchema(10),
  shot_size: z.enum(SHOT_SIZES),
  camera_motion: z.enum(CAMERA_MOTIONS),
  time_of_day: z.enum(TIMES_OF_DAY),
  setting: z.enum(SETTINGS),
  people_count: z.enum(PEOPLE_COUNTS),
  visible_text: z.string().max(300),
  has_watermark: z.boolean(),
  usable: z.boolean(),
  usable_reason: z.string().max(200),
  quality: z.int().min(0).max(5),
});
export type SegmentDescription = z.infer<typeof SegmentDescriptionSchema>;

/** Kích thước cụm tối đa cho một job scan.ai: việc Studio chờ GPU lâu nhất là hết một cụm. */
export const SCAN_AI_MAX_CHUNK = 30;

export const ScanAiPayloadSchema = z.strictObject({
  asset_id: z.uuid(),
  chunk: z.int().nonnegative(),
  model: z.string().min(1).max(200),
  prompt_version: z.string().min(1).max(40),
  /** Ngữ cảnh gợi ý, có thể sai; prompt phải ghi rõ điều đó. */
  context: z
    .strictObject({
      project_names: z.array(z.string().max(200)).max(10).default([]),
      category_names: z.array(z.string().max(200)).max(10).default([]),
      province_names: z.array(z.string().max(200)).max(10).default([]),
    })
    .default({ project_names: [], category_names: [], province_names: [] }),
  segments: z
    .array(
      z.strictObject({
        segment_id: z.uuid(),
        index: z.int().nonnegative(),
        start_ms: z.int().nonnegative(),
        end_ms: z.int().nonnegative(),
        /** Tên input của keyframe, ví dụ `artifact:keyframes/0001-1.jpg`. */
        keyframes: z.array(InputNameSchema).min(1).max(3),
      }),
    )
    .min(1)
    .max(SCAN_AI_MAX_CHUNK),
  options: z
    .strictObject({
      keep_alive: z.string().max(20).default('2m'),
      repair_attempts: z.int().min(0).max(3).default(1),
    })
    .default({ keep_alive: '2m', repair_attempts: 1 }),
});
export type ScanAiPayload = z.infer<typeof ScanAiPayloadSchema>;

export const AI_MANIFEST_SCHEMA = 'ag.scan.ai/v1';
export function aiManifestPath(chunk: number): string {
  return `ai-${String(chunk).padStart(4, '0')}.json`;
}

export const AiManifestSchema = z.strictObject({
  schema: z.literal(AI_MANIFEST_SCHEMA),
  asset_id: z.uuid(),
  chunk: z.int().nonnegative(),
  model: z.string(),
  prompt_version: z.string(),
  items: z.array(
    z.strictObject({
      segment_id: z.uuid(),
      description: SegmentDescriptionSchema.nullable(),
      error: z.string().max(2000).nullable(),
      duration_ms: z.int().nonnegative(),
    }),
  ),
});
export type AiManifest = z.infer<typeof AiManifestSchema>;
