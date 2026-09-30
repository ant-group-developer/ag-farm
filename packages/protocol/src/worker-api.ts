import { z } from 'zod';
import { CapabilitiesSchema, SlotsSchema } from './capabilities';
import {
  IsoDateTimeSchema,
  JobErrorSchema,
  JobResultSchema,
  JobTypeSchema,
  LaneSchema,
  OwnerIdSchema,
} from './common';

export const HeartbeatRequestSchema = z.strictObject({
  agent_version: z.string().min(1).max(60),
  kinds: z.array(JobTypeSchema).min(1),
  capabilities: CapabilitiesSchema,
  free_slots: SlotsSchema,
  running_job_ids: z.array(z.uuid()).max(64),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;

export const HeartbeatResponseSchema = z.strictObject({
  node_id: z.uuid(),
  server_time: IsoDateTimeSchema,
  /** `disabled`: worker phải ngừng nhận việc (việc đang chạy vẫn nộp được tới khi lease hết). */
  status: z.enum(['active', 'disabled']),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponseSchema>;

export const ClaimRequestSchema = z.strictObject({
  kinds: z.array(JobTypeSchema).min(1),
  free_slots: SlotsSchema,
  /** Worker chỉ còn slot dành riêng cho việc Studio thì gửi `['interactive']`. */
  lanes: z.array(LaneSchema).min(1).optional(),
  /** Các `affinity_key` worker đang có dữ liệu trong cache. */
  cached_affinity: z.array(z.string().max(200)).max(200).default([]),
});
export type ClaimRequest = z.input<typeof ClaimRequestSchema>;

export const ClaimedJobSchema = z.strictObject({
  id: z.uuid(),
  owner: OwnerIdSchema,
  type: JobTypeSchema,
  lane: LaneSchema,
  attempt: z.int().positive(),
  payload: z.unknown(),
  lease_token: z.string().min(16).max(200),
  lease_expires_at: IsoDateTimeSchema,
  /** Vé JWT gửi kèm mỗi lần gọi `sign_url`. */
  ticket: z.string().min(20),
  sign_url: z.url(),
});
export type ClaimedJob = z.infer<typeof ClaimedJobSchema>;

export const ClaimResponseSchema = z.strictObject({
  job: ClaimedJobSchema.nullable(),
  /**
   * Khi không giao được job: số job interactive đang chờ mà node đáp ứng được nhưng thiếu slot, theo loại
   * slot. Worker dùng nó để báo các worker batch cùng máy nhường slot. Hub chỉ gửi khi có ít nhất một job
   * (worker cũ parse strict nên không được thấy khoá lạ).
   */
  waiting_interactive: z.strictObject({ cpu: z.int().nonnegative(), gpu: z.int().nonnegative() }).optional(),
});
export type ClaimResponse = z.infer<typeof ClaimResponseSchema>;

export const ProgressRequestSchema = z.strictObject({
  lease_token: z.string().min(16).max(200),
  percent: z.number().min(0).max(100).optional(),
  stage: z.string().max(100).optional(),
});
export type ProgressRequest = z.infer<typeof ProgressRequestSchema>;

export const ProgressResponseSchema = z.strictObject({
  lease_expires_at: IsoDateTimeSchema,
  ticket: z.string().min(20),
});
export type ProgressResponse = z.infer<typeof ProgressResponseSchema>;

export const CompleteRequestSchema = z.strictObject({
  lease_token: z.string().min(16).max(200),
  result: JobResultSchema,
});
export type CompleteRequest = z.input<typeof CompleteRequestSchema>;

export const FailRequestSchema = z.strictObject({
  lease_token: z.string().min(16).max(200),
  error: JobErrorSchema,
});
export type FailRequest = z.infer<typeof FailRequestSchema>;

/**
 * Lỗi 409 từ progress/complete/fail: lease đã mất (hết hạn, bị reaper lấy lại) hoặc job đã huỷ.
 * Worker phải dừng job ngay, không nộp nữa.
 */
export const LeaseLostResponseSchema = z.strictObject({
  error: z.enum(['lease_lost', 'job_cancelled']),
  message: z.string(),
});
export type LeaseLostResponse = z.infer<typeof LeaseLostResponseSchema>;
