import { z } from 'zod';

export const JOB_TYPES = [
  'scan.extract',
  'scan.ai',
  'studio.tts',
  'studio.render_preview',
  'studio.render_final',
] as const;
export const JobTypeSchema = z.enum(JOB_TYPES);
export type JobType = z.infer<typeof JobTypeSchema>;

/** `interactive` = có người đang chờ trên Studio; `batch` = việc nền (quét, backfill). */
export const LANES = ['interactive', 'batch'] as const;
export const LaneSchema = z.enum(LANES);
export type Lane = z.infer<typeof LaneSchema>;

export const JOB_STATUSES = ['queued', 'leased', 'completed', 'failed', 'cancelled'] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'cancelled'];

/** Id chủ job, ví dụ `ag-go`, `studio`. */
export const OwnerIdSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9-]*$/);

function hasDotDotSegment(value: string): boolean {
  return value.split('/').some((segment) => segment === '..' || segment === '.' || segment === '');
}

/**
 * Đường dẫn tương đối dưới thư mục output của job, ví dụ `keyframes/0001-1.jpg`.
 * Không có `/` đầu, không có `..`, `.` hay đoạn rỗng, không có `\`.
 */
export const RelativePathSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9._\-/]+$/)
  .refine((value) => !hasDotDotSegment(value), { message: 'Path must not contain empty, . or .. segments' });

/**
 * Tên input logic do chủ job định nghĩa: `source`, `artifact:keyframes/0001-1.jpg`,
 * `segment:<uuid>`, `library:music/a.mp3`. Phần sau `:` theo cùng luật với {@link RelativePathSchema}.
 */
export const InputNameSchema = z
  .string()
  .min(1)
  .max(320)
  .regex(/^[a-z][a-z0-9_]*(:[A-Za-z0-9._\-/]+)?$/)
  .refine(
    (value) => {
      const colon = value.indexOf(':');
      return colon < 0 || !hasDotDotSegment(value.slice(colon + 1));
    },
    { message: 'Input path must not contain empty, . or .. segments' },
  );

export function splitInputName(name: string): { kind: string; path: string | null } {
  const colon = name.indexOf(':');
  return colon < 0
    ? { kind: name, path: null }
    : { kind: name.slice(0, colon), path: name.slice(colon + 1) };
}

export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

/** Vài con số tóm tắt kết quả; dữ liệu đầy đủ nằm trong manifest ở bucket của chủ job. */
export const ResultSummarySchema = z.record(
  z.string().max(60),
  z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
);

export const JobResultSchema = z.strictObject({
  manifest: RelativePathSchema.nullable(),
  summary: ResultSummarySchema.default({}),
});
export type JobResult = z.infer<typeof JobResultSchema>;

export const JobErrorSchema = z.strictObject({
  code: z.string().min(1).max(80),
  message: z.string().max(2000),
  retryable: z.boolean(),
});
export type JobError = z.infer<typeof JobErrorSchema>;
