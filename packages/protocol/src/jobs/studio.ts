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
  /**
   * Chừa dư mỗi đầu khi cắt đoạn nguồn (giây), để chuyển cảnh có đủ hình.
   * Không còn dùng khi composition chỉ dùng `asset:` inputs (GĐ2+), nhưng vẫn giữ để payload cũ còn parse được.
   */
  handle_seconds: z.number().min(0).max(5).default(1),
  /** File video kết quả, ví dụ `renders/12/final.mp4`. */
  output: RelativePathSchema,
  /**
   * Thumbnail cần dựng sau khi render_final xong.
   * Mỗi entry: lấy frame tại `t_s` giây trong video kết quả, đốt `text` vào, lưu JPEG.
   * Đường dẫn output: thumbnailOutputPath(payload.output, i) (i = 1..n).
   */
  thumbnails: z.array(
    z.strictObject({
      t_s: z.number().min(0),
      text: z.string().min(1).max(40),
    }),
  ).max(3).default([]),
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
  /** Thumbnail đã dựng sau render_final. Rỗng nếu không có thumbnail nào được yêu cầu. */
  thumbnails: z.array(
    z.strictObject({
      output: RelativePathSchema,
      t_s: z.number().min(0),
      width: z.int().positive(),
      height: z.int().positive(),
    }),
  ).default([]),
});
export type RenderManifest = z.infer<typeof RenderManifestSchema>;

/**
 * Tạo đường dẫn output cho thumbnail thứ `n` (1-based) của video `output`.
 * Ví dụ: `renders/ep1/final-att.mp4` → `renders/ep1/final-att.thumb-1.jpg`
 * Đây là hợp đồng đặt tên giữa protocol và Studio (Studio map tên này thành stage output).
 */
export function thumbnailOutputPath(output: string, n: number): string {
  return output.replace(/\.mp4$/, `.thumb-${n}.jpg`);
}

// ---------------------------------------------------------------------------------------------
// studio.export_premiere: xuất tập phim thành project Adobe Premiere Pro (.zip).
// Output `premiere.json` + file zip ở `output`.
// ---------------------------------------------------------------------------------------------

export const StudioExportPremierePayloadSchema = z.strictObject({
  production_id: z.string().min(1).max(100),
  episode_id: z.string().min(1).max(100),
  /** composition.json của Studio (giống như render, asset: inputs). */
  composition: InputNameSchema,
  /** Loại media: proxy 720p hay bản gốc. */
  media: z.enum(['proxy', 'original']),
  /** Tên sequence trong Premiere (≤ 200 ký tự). */
  name: z.string().min(1).max(200),
  /** Chapter markers (≤ 100). */
  markers: z
    .array(
      z.strictObject({
        t_s: z.number().min(0),
        title: z.string().min(1).max(100),
      }),
    )
    .max(100)
    .default([]),
  /**
   * Tên hiển thị của từng video (`asset:<id>` → tên), để file trong `media/` của zip mang tên video thay vì
   * id. Thiếu tên thì worker dùng id.
   */
  media_names: z
    .record(InputNameSchema, z.string().min(1).max(200))
    .refine((m) => Object.keys(m).length <= 500, 'at most 500 media names')
    .default({}),
  /** Đường dẫn file zip kết quả, ví dụ `episodes/<eid>/premiere/<job>.zip`. */
  output: RelativePathSchema,
  /**
   * Kiểu dựng của tập. Studio chỉ gửi `cut` (cắt theo shot: clip có điểm vào/ra, chuyển cảnh, lời dẫn). Worker cũ
   * (trước khi đọc được timeline v4) không biết trường này nên từ chối payload (`strictObject`), thay vì xuất một
   * project bỏ mất điểm cắt, chuyển cảnh và lời dẫn mà không báo.
   */
  edit_style: z.enum(['whole', 'cut']).optional(),
});
export type StudioExportPremierePayload = z.infer<typeof StudioExportPremierePayloadSchema>;

export const PREMIERE_MANIFEST_SCHEMA = 'ag.studio.premiere/v1';
export const PREMIERE_MANIFEST_PATH = 'premiere.json';

export const PremiereManifestSchema = z.strictObject({
  schema: z.literal(PREMIERE_MANIFEST_SCHEMA),
  output: RelativePathSchema,
  size_bytes: z.int().nonnegative(),
  media: z.enum(['proxy', 'original']),
  files: z.array(
    z.strictObject({
      path: z.string(),
      size_bytes: z.int().nonnegative(),
      source_kind: z.enum(['original', 'proxy', 'preview']),
      watermarked: z.boolean(),
    }),
  ),
  warnings: z.array(z.string()).default([]),
});
export type PremiereManifest = z.infer<typeof PremiereManifestSchema>;

// ---------------------------------------------------------------------------------------------
// studio.transcribe: nhận dạng lời nói trong footage (WhisperX), cho kiểu dựng cắt theo shot.
// Studio tách sẵn tiếng của từng nguồn thành WAV 16 kHz mono (`stage:audio/<source_id>.wav`), nên máy farm
// không phải tải file video gốc. Output `transcribe.json`.
// ---------------------------------------------------------------------------------------------

export const StudioTranscribePayloadSchema = z
  .strictObject({
    production_id: z.string().min(1).max(100),
    /** Tên mô hình faster-whisper. */
    model: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[A-Za-z0-9._-]+$/)
      .default('large-v3'),
    sources: z
      .array(
        z.strictObject({
          /** Id nguồn của Studio, trả lại nguyên trong manifest. */
          source_id: z
            .string()
            .min(1)
            .max(100)
            .regex(/^[A-Za-z0-9_-]+$/),
          /** WAV 16 kHz mono, ví dụ `stage:audio/src_01HZX.wav`. */
          audio: InputNameSchema,
          /** Mã ngôn ngữ (`vi`, `en`); `null` = để mô hình tự nhận. */
          language: z.string().min(2).max(10).nullable().default(null),
        }),
      )
      .min(1)
      .max(200),
    /** Căn mốc từng từ bằng mô hình căn chỉnh của WhisperX; tắt thì chỉ có mốc theo câu. */
    align_words: z.boolean().default(true),
  })
  .refine((p) => new Set(p.sources.map((s) => s.source_id)).size === p.sources.length, {
    message: 'source_id must be unique',
    path: ['sources'],
  });
export type StudioTranscribePayload = z.infer<typeof StudioTranscribePayloadSchema>;

export const TRANSCRIBE_MANIFEST_SCHEMA = 'ag.studio.transcribe/v1';
export const TRANSCRIBE_MANIFEST_PATH = 'transcribe.json';

const TranscribeWordSchema = z.strictObject({
  word: z.string().min(1),
  start: z.number().min(0),
  end: z.number().min(0),
  score: z.number().min(0).max(1).optional(),
});

export const TranscribeManifestSchema = z.strictObject({
  schema: z.literal(TRANSCRIBE_MANIFEST_SCHEMA),
  production_id: z.string(),
  engine: z.strictObject({ name: z.string(), version: z.string().nullable() }),
  sources: z.array(
    z.strictObject({
      source_id: z.string(),
      /** Ngôn ngữ nhận ra (hoặc đã cho); `null` khi nguồn không có lời. */
      language: z.string().nullable(),
      /** `word` khi căn được từng từ, `segment` khi chỉ có mốc theo câu. */
      alignment: z.enum(['word', 'segment']),
      segments: z.array(
        z.strictObject({
          start: z.number().min(0),
          end: z.number().min(0),
          text: z.string(),
          words: z.array(TranscribeWordSchema).default([]),
        }),
      ),
    }),
  ),
});
export type TranscribeManifest = z.infer<typeof TranscribeManifestSchema>;
