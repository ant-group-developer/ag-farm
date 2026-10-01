import { z } from 'zod';
import { RequirementsSchema } from './capabilities';
import {
  IsoDateTimeSchema,
  JobErrorSchema,
  JobResultSchema,
  JobStatusSchema,
  JobTypeSchema,
  LaneSchema,
  OwnerIdSchema,
} from './common';

export const SubmitJobRequestSchema = z.strictObject({
  type: JobTypeSchema,
  /** Thiếu thì lấy lane của loại job (`JOB_TYPE_SPECS[type].lane`). */
  lane: LaneSchema.optional(),
  priority: z.int().min(-100).max(100).default(0),
  requirements: RequirementsSchema.default({}),
  affinity_key: z.string().max(200).nullable().default(null),
  /** Kiểm theo schema payload của từng loại job (xem `JOB_TYPE_SPECS`). */
  payload: z.unknown(),
  max_attempts: z.int().min(1).max(20).default(3),
  /** Gửi lại cùng `correlation_id` trả về job cũ, không tạo job mới. */
  correlation_id: z.string().min(1).max(200),
  not_before: IsoDateTimeSchema.nullable().default(null),
  /** Nhóm để tạm dừng / chạy tiếp / huỷ cả loạt, ví dụ `batch:<id>` của một đợt quét. */
  group_key: z.string().min(1).max(200).nullable().default(null),
});
export type SubmitJobRequest = z.input<typeof SubmitJobRequestSchema>;

export const JobViewSchema = z.strictObject({
  id: z.uuid(),
  owner: OwnerIdSchema,
  type: JobTypeSchema,
  lane: LaneSchema,
  status: JobStatusSchema,
  priority: z.int(),
  correlation_id: z.string(),
  affinity_key: z.string().nullable(),
  group_key: z.string().nullable(),
  attempt_count: z.int().nonnegative(),
  max_attempts: z.int().positive(),
  node_id: z.uuid().nullable(),
  progress_percent: z.number().nullable(),
  progress_stage: z.string().nullable(),
  result: JobResultSchema.nullable(),
  error: JobErrorSchema.nullable(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
  finished_at: IsoDateTimeSchema.nullable(),
  acked_at: IsoDateTimeSchema.nullable(),
});
export type JobView = z.infer<typeof JobViewSchema>;

export const SubmitJobResponseSchema = z.strictObject({
  job: JobViewSchema,
  /** `false` khi `correlation_id` đã có job. */
  created: z.boolean(),
});
export type SubmitJobResponse = z.infer<typeof SubmitJobResponseSchema>;

/** Query của `GET /v1/owner/jobs`. Mọi giá trị là chuỗi (query string). */
export const ListJobsQuerySchema = z.strictObject({
  /** Danh sách phân tách bằng dấu phẩy, ví dụ `completed,failed`. */
  status: z.string().max(200).optional(),
  type: z.string().max(200).optional(),
  /** `1`: chỉ job đã kết thúc mà chủ job chưa ack. */
  unacked: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** Con trỏ lấy từ `next_cursor` của trang trước. */
  after: z.string().max(200).optional(),
});
export type ListJobsQuery = z.input<typeof ListJobsQuerySchema>;

export const ListJobsResponseSchema = z.strictObject({
  jobs: z.array(JobViewSchema),
  next_cursor: z.string().nullable(),
});
export type ListJobsResponse = z.infer<typeof ListJobsResponseSchema>;

/**
 * `POST /v1/owner/jobs/{pause|resume|cancel}`: theo danh sách id hoặc cả nhóm `group_key`.
 * - pause: `queued` → `paused`; `leased` → `paused` (worker nhận 409 `job_paused` ở lần progress kế tiếp,
 *   lần thử đang chạy không bị tính).
 * - resume: `paused` → `queued`.
 * - cancel: `queued`/`paused`/`leased` → `cancelled`.
 * Job ở trạng thái khác được bỏ qua.
 */
export const JobControlRequestSchema = z
  .strictObject({
    ids: z.array(z.uuid()).min(1).max(1000).optional(),
    group_key: z.string().min(1).max(200).optional(),
  })
  .refine((v) => (v.ids ? 1 : 0) + (v.group_key ? 1 : 0) === 1, { message: 'Give exactly one of ids or group_key' });
export type JobControlRequest = z.infer<typeof JobControlRequestSchema>;

export const JobControlResponseSchema = z.strictObject({
  /** Số job đã đổi trạng thái. */
  affected: z.int().nonnegative(),
});
export type JobControlResponse = z.infer<typeof JobControlResponseSchema>;
