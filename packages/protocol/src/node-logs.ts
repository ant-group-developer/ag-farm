import { z } from 'zod';
import { IsoDateTimeSchema } from './common';

/**
 * "Lấy log" của một máy worker (trang Máy): admin xin log của một node, có thể chỉ trong một khoảng giờ; worker hỏi
 * `GET /v1/worker/logs/request` mỗi phút, gom log của mình (worker.log, setup.log, updater.log, lọc theo giờ) rồi gửi
 * `POST /v1/worker/logs/:id` (gzip). Hub giữ 14 ngày; admin tải về dạng text.
 */
export const NODE_LOG_API = {
  request: '/v1/worker/logs/request',
  upload: (id: string) => `/v1/worker/logs/${id}`,
} as const;

/** Body gửi lên tối đa (gzip). Log 20 MB nén còn cỡ 2 MB; trần này để một khoảng giờ dài vẫn lọt. */
export const NODE_LOG_MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
/** Log gom được tối đa trước khi nén: quá thì giữ phần cuối (mới nhất). */
export const NODE_LOG_MAX_TEXT_BYTES = 64 * 1024 * 1024;

export const NodeLogRequestSchema = z.strictObject({
  id: z.uuid(),
  /** Chỉ lấy dòng từ/tới lúc này (null: không giới hạn phía đó; cả hai null: phần cuối của mỗi file). */
  since: IsoDateTimeSchema.nullable(),
  until: IsoDateTimeSchema.nullable(),
});
export type NodeLogRequest = z.infer<typeof NodeLogRequestSchema>;

/** `GET /v1/worker/logs/request`: lần xin log cũ nhất còn chờ của node này, hoặc null. */
export const NodeLogRequestResponseSchema = z.strictObject({
  request: NodeLogRequestSchema.nullable(),
});
export type NodeLogRequestResponse = z.infer<typeof NodeLogRequestResponseSchema>;

/** `POST /v1/admin/nodes/:id/logs`. */
export const CreateNodeLogRequestSchema = z.strictObject({
  since: IsoDateTimeSchema.nullable().optional(),
  until: IsoDateTimeSchema.nullable().optional(),
});
export type CreateNodeLogRequest = z.infer<typeof CreateNodeLogRequestSchema>;

export const NODE_LOG_STATUSES = ['requested', 'uploaded', 'failed'] as const;

/** Một lần xin log, như trang Máy hiện. */
export const NodeLogViewSchema = z.strictObject({
  id: z.uuid(),
  node_id: z.uuid(),
  status: z.enum(NODE_LOG_STATUSES),
  since: IsoDateTimeSchema.nullable(),
  until: IsoDateTimeSchema.nullable(),
  requested_at: IsoDateTimeSchema,
  uploaded_at: IsoDateTimeSchema.nullable(),
  /** Cỡ log (chưa nén). */
  size_bytes: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
});
export type NodeLogView = z.infer<typeof NodeLogViewSchema>;
