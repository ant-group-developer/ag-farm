import { z } from 'zod';
import { IsoDateTimeSchema, InputNameSchema, RelativePathSchema } from './common';

/**
 * Hợp đồng ký URL mà mọi chủ job phải cài ở `sign_url` của mình.
 * Worker gửi `Authorization: Ticket <vé>` và danh sách thao tác; chủ job kiểm vé,
 * chỉ ký những input/output thuộc đúng job trong vé, rồi trả kết quả theo đúng thứ tự.
 * Một thao tác không được phép thì cả request trả 403.
 */
const ContentTypeSchema = z.string().min(3).max(120);
const UploadIdSchema = z.string().min(1).max(1024);

export const SignOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('get'), input: InputNameSchema }),
  z.strictObject({ op: z.literal('put'), output: RelativePathSchema, content_type: ContentTypeSchema }),
  z.strictObject({
    op: z.literal('mp_create'),
    output: RelativePathSchema,
    content_type: ContentTypeSchema,
  }),
  z.strictObject({
    op: z.literal('mp_part_urls'),
    output: RelativePathSchema,
    upload_id: UploadIdSchema,
    parts: z.array(z.int().min(1).max(10000)).min(1).max(100),
  }),
  z.strictObject({
    op: z.literal('mp_complete'),
    output: RelativePathSchema,
    upload_id: UploadIdSchema,
    parts: z
      .array(z.strictObject({ part_number: z.int().min(1).max(10000), etag: z.string().min(1).max(200) }))
      .min(1)
      .max(10000),
  }),
  z.strictObject({ op: z.literal('mp_abort'), output: RelativePathSchema, upload_id: UploadIdSchema }),
]);
export type SignOp = z.infer<typeof SignOpSchema>;

export const SignRequestSchema = z.strictObject({
  ops: z.array(SignOpSchema).min(1).max(100),
});
export type SignRequest = z.infer<typeof SignRequestSchema>;

/** Thông tin thêm về nguồn khi input là footage (`segment:<id>`): gốc, proxy hay preview có watermark. */
export const SourceMetaSchema = z.strictObject({
  source_kind: z.enum(['original', 'proxy', 'preview']),
  watermarked: z.boolean(),
  /** Khoảng dùng được trong file (ms), nếu input là một đoạn. */
  start_ms: z.int().nonnegative().nullable(),
  end_ms: z.int().nonnegative().nullable(),
});
export type SourceMeta = z.infer<typeof SourceMetaSchema>;

export const SignResultSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('get'),
    input: InputNameSchema,
    url: z.url(),
    expires_at: IsoDateTimeSchema,
    size_bytes: z.int().nonnegative().nullable(),
    content_type: z.string().nullable(),
    /** Khoá cache ổn định (vd. sha256 của file gốc); `null` thì worker không cache. */
    cache_key: z.string().max(200).nullable(),
    source: SourceMetaSchema.nullable(),
  }),
  z.strictObject({
    op: z.literal('put'),
    output: RelativePathSchema,
    url: z.url(),
    expires_at: IsoDateTimeSchema,
    /** Header worker phải gửi kèm PUT (vd. Content-Type). */
    headers: z.record(z.string(), z.string()),
  }),
  z.strictObject({ op: z.literal('mp_create'), output: RelativePathSchema, upload_id: UploadIdSchema }),
  z.strictObject({
    op: z.literal('mp_part_urls'),
    output: RelativePathSchema,
    upload_id: UploadIdSchema,
    expires_at: IsoDateTimeSchema,
    urls: z.array(z.strictObject({ part_number: z.int().min(1).max(10000), url: z.url() })),
  }),
  z.strictObject({ op: z.literal('mp_complete'), output: RelativePathSchema }),
  z.strictObject({ op: z.literal('mp_abort'), output: RelativePathSchema }),
]);
export type SignResult = z.infer<typeof SignResultSchema>;

export const SignResponseSchema = z.strictObject({
  results: z.array(SignResultSchema),
});
export type SignResponse = z.infer<typeof SignResponseSchema>;

/** Phần của multipart: R2/S3 đòi mọi phần trừ phần cuối ≥ 5 MiB. */
export const MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;
/** File nhỏ hơn ngưỡng này thì PUT một lần. */
export const MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;
