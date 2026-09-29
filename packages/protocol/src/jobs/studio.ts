import { z } from 'zod';
import { InputNameSchema, RelativePathSchema } from '../common';

/**
 * Job của Studio (owner `studio`, lane `interactive`), chạy trên ag-render-worker.
 *
 * Quy ước input: mọi file worker cần đều là tên input logic mà `sign_url` của Studio hiểu:
 * - `stage:<đường dẫn>`: file của production do Studio đẩy lên (composition, WAV lời dẫn…);
 * - `library:<đường dẫn>`: thư viện của team (giọng mẫu, nhạc, font, logo);
 * - `segment:<id>`: đoạn footage của ag-go; Studio xin ag-go `resolve` và trả URL gốc, proxy hoặc
 *   preview có watermark tuỳ quyền, kèm `source` trong kết quả ký.
 */

// ---------------------------------------------------------------------------------------------
// studio.tts: đọc từng câu lời dẫn thành WAV (OmniVoice). Output `tts.json` + `tts/<line_id>.wav`.
// ---------------------------------------------------------------------------------------------

export const StudioTtsPayloadSchema = z.strictObject({
  production_id: z.string().min(1).max(100),
  language: z.string().min(2).max(10),
  voice: z.strictObject({
    /** Giọng mẫu để clone, ví dụ `library:voices/nam-mien-bac.wav`; `null` = giọng mặc định. */
    reference: InputNameSchema.nullable(),
    /** Lời đọc của giọng mẫu (OmniVoice cần khi clone). */
    reference_text: z.string().max(2000).nullable(),
    speed: z.number().min(0.5).max(2).default(1),
  }),
  lines: z
    .array(
      z.strictObject({
        line_id: z.string().regex(/^L\d{3}$/),
        text: z.string().min(1).max(1200),
        pause_seconds: z.number().min(0).max(5).nullable().default(null),
      }),
    )
    .min(1)
    .max(300),
  /** Căn thời gian từng từ bằng WhisperX (phụ đề theo từ). */
  align_words: z.boolean().default(false),
});
export type StudioTtsPayload = z.infer<typeof StudioTtsPayloadSchema>;

export const TTS_MANIFEST_SCHEMA = 'ag.studio.tts/v1';
export const TTS_MANIFEST_PATH = 'tts.json';

export const TtsManifestSchema = z.strictObject({
  schema: z.literal(TTS_MANIFEST_SCHEMA),
  production_id: z.string(),
  language: z.string(),
  lines: z.array(
    z.strictObject({
      line_id: z.string(),
      /** Ví dụ `tts/L001.wav`. */
      output: RelativePathSchema,
      duration_s: z.number().nonnegative(),
      words: z
        .array(z.strictObject({ word: z.string(), start: z.number(), end: z.number() }))
        .default([]),
    }),
  ),
  engine: z.strictObject({ name: z.string(), version: z.string().nullable() }),
});
export type TtsManifest = z.infer<typeof TtsManifestSchema>;

// ---------------------------------------------------------------------------------------------
// studio.render_preview / studio.render_final: dựng MP4 từ composition.
// Output `render.json` + file video ở `output`.
// ---------------------------------------------------------------------------------------------

export const StudioRenderPayloadSchema = z.strictObject({
  production_id: z.string().min(1).max(100),
  /** Revision timeline được dựng. */
  revision: z.int().nonnegative(),
  /**
   * composition.json của Studio (thường `stage:renders/<rev>/composition.json`). Mọi trường đường dẫn
   * trong đó (source_path, wav, music.path, logo.path, brand.dir/fonts_dir) là tên input logic.
   */
  composition: InputNameSchema,
  canvas: z.strictObject({ width: z.int().min(160).max(7680), height: z.int().min(160).max(7680) }),
  /** Chừa dư mỗi đầu khi cắt đoạn nguồn (giây), để chuyển cảnh có đủ hình. */
  handle_seconds: z.number().min(0).max(5).default(1),
  /** File video kết quả, ví dụ `renders/12/final.mp4`. */
  output: RelativePathSchema,
});
export type StudioRenderPayload = z.infer<typeof StudioRenderPayloadSchema>;

export const RENDER_MANIFEST_SCHEMA = 'ag.studio.render/v1';
export const RENDER_MANIFEST_PATH = 'render.json';

export const RenderManifestSchema = z.strictObject({
  schema: z.literal(RENDER_MANIFEST_SCHEMA),
  production_id: z.string(),
  revision: z.int().nonnegative(),
  output: RelativePathSchema,
  width: z.int().positive(),
  height: z.int().positive(),
  duration_s: z.number().nonnegative(),
  size_bytes: z.int().nonnegative(),
  /** Có đoạn nào dựng từ preview có watermark không (user thiếu quyền tải gốc). */
  watermarked: z.boolean(),
  sources: z.array(
    z.strictObject({
      input: InputNameSchema,
      source_kind: z.enum(['original', 'proxy', 'preview']),
      watermarked: z.boolean(),
    }),
  ),
  warnings: z.array(z.string()).default([]),
});
export type RenderManifest = z.infer<typeof RenderManifestSchema>;
