import { z } from 'zod';
import { InputNameSchema } from '../common';

// ---------------------------------------------------------------------------------------------
// scan.prep: chuẩn bị đầu vào cho Studio ngay ở ag-go, một lần cho mỗi footage. Tải `source` (bản sạch nhỏ nhất ag-go
// có) → ffprobe → dò cảnh và dựng cảnh theo ĐÚNG luật của Studio (`buildShots` của ag-studio
// `packages/core/src/media/scene.ts`: gộp cảnh < min_shot_s, chia cảnh > max_shot_s, mốc cắt theo lưới 0,1 s) →
// khung giữa mỗi cảnh (`scale=<frame_width>:-2`) → tờ cảnh (ffmpeg `tile=<cols>x<rows>`, `sheet_shots` cảnh mỗi tờ)
// → `audio.wav` 16 kHz mono pcm_s16le khi có tiếng (để ag-go gửi tiếp `studio.transcribe`).
// Đầu ra: `prep.json` (`ScanPrepManifest`), `frames/NNN.jpg` (pad3, từ 1), `sheets/NN.jpg` (pad2, từ 1), `audio.wav`.
// ---------------------------------------------------------------------------------------------

export const ScanPrepParamsSchema = z.strictObject({
  /** Ngưỡng `scene` của ffmpeg (0–1), như Studio. */
  scene_threshold: z.number().min(0).max(1).default(0.3),
  /** Cảnh ngắn hơn (giây) gộp vào cảnh trước (cảnh đầu: gộp vào cảnh sau). */
  min_shot_s: z.number().positive().default(1),
  /** Cảnh dài hơn (giây) chia đều thành ceil(dài / max) phần. */
  max_shot_s: z.number().positive().default(20),
  /** Bề ngang khung giữa cảnh (px); chiều cao giữ tỉ lệ, chẵn. */
  frame_width: z.number().int().min(64).max(1920).default(480),
  /** Số cột của một tờ cảnh. */
  sheet_cols: z.number().int().min(1).max(8).default(4),
  /** Số cảnh tối đa mỗi tờ, theo thứ tự cảnh. */
  sheet_shots: z.number().int().min(1).max(64).default(16),
  /** `false`: không xuất `audio.wav` (kể cả khi video có tiếng). */
  audio: z.boolean().default(true),
});
export type ScanPrepParams = z.infer<typeof ScanPrepParamsSchema>;

export const ScanPrepPayloadSchema = z.strictObject({
  asset_id: z.uuid(),
  /** Tên input của video; ag-go ký GET của nó như `source` của scan.extract. */
  source: InputNameSchema,
  params: ScanPrepParamsSchema.default(ScanPrepParamsSchema.parse({})),
});
export type ScanPrepPayload = z.infer<typeof ScanPrepPayloadSchema>;

export const SCAN_PREP_MANIFEST_SCHEMA = 'ag.scan.prep/v1';
export const SCAN_PREP_MANIFEST_PATH = 'prep.json';
export const SCAN_PREP_AUDIO_PATH = 'audio.wav';

/** `frames/001.jpg`: khung giữa cảnh thứ `n` (từ 1). */
export function scanPrepFramePath(n: number): string {
  return `frames/${String(n).padStart(3, '0')}.jpg`;
}

/** `sheets/01.jpg`: tờ cảnh thứ `n` (từ 1). */
export function scanPrepSheetPath(n: number): string {
  return `sheets/${String(n).padStart(2, '0')}.jpg`;
}

export const ScanPrepManifestSchema = z.strictObject({
  schema: z.literal(SCAN_PREP_MANIFEST_SCHEMA),
  asset_id: z.uuid(),
  media: z.strictObject({
    duration_s: z.number(),
    width: z.number().int(),
    height: z.number().int(),
    fps: z.number().nullable(),
    has_audio: z.boolean(),
  }),
  /** Luật dựng cảnh đã dùng (từ `params`). */
  scene: z.strictObject({ threshold: z.number(), min_shot_s: z.number(), max_shot_s: z.number() }),
  shots: z.array(
    z.strictObject({
      n: z.number().int().min(1),
      /** Giây theo timeline của `source`, làm tròn 3 chữ số. */
      in: z.number(),
      out: z.number(),
      /** `frames/001.jpg` (pad3, từ 1). */
      frame: z.string(),
    }),
  ),
  /** `sheets/01.jpg` (pad2, từ 1) và số `n` của các cảnh trên tờ, theo thứ tự ô. */
  sheets: z.array(z.strictObject({ file: z.string(), shots: z.array(z.number().int()) })),
  /** `audio.wav` (16 kHz mono pcm_s16le), hoặc `null` khi không có tiếng hay `params.audio` là false. */
  audio: z.string().nullable(),
  /** Phiên bản công cụ, ví dụ `{ ffmpeg, worker_version }`. */
  tools: z.record(z.string(), z.string()).optional(),
});
export type ScanPrepManifest = z.infer<typeof ScanPrepManifestSchema>;
