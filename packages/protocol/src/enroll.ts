/**
 * Cài máy worker bằng mã cài đặt: admin tạo mã trên web farm, script cài trên máy worker đổi mã lấy token
 * cho từng vai trò (mỗi vai trò là một node riêng trên hub). Token không phải chép tay giữa các máy.
 */
import { z } from 'zod';
import { IsoDateTimeSchema, JobTypeSchema } from './common';

export const WORKER_ROLES = ['scan', 'render'] as const;
export const WorkerRoleSchema = z.enum(WORKER_ROLES);
export type WorkerRole = z.infer<typeof WorkerRoleSchema>;

/** Loại job mỗi vai trò nhận; cũng là tên gói phát hành cài cho vai trò đó. */
export const ROLE_KINDS = {
  scan: ['scan.extract', 'scan.ai'],
  render: ['studio.render_preview', 'studio.render_final', 'studio.tts'],
} as const satisfies Record<WorkerRole, readonly z.infer<typeof JobTypeSchema>[]>;

export const ROLE_PACKAGES = {
  scan: 'ag-scan-worker',
  render: 'ag-render-worker',
} as const satisfies Record<WorkerRole, string>;

/** Mã cài đặt còn hiệu lực trong chừng này (giờ). */
export const ENROLLMENT_TTL_HOURS = 24;

/** Tên máy: dùng làm tiền tố tên node (`<machine>-scan`), chỉ chữ, số, `-`, `_`. */
export const MachineNameSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

export const CreateEnrollmentRequestSchema = z.strictObject({
  machine: MachineNameSchema,
  roles: z.array(WorkerRoleSchema).min(1).max(WORKER_ROLES.length),
});
export type CreateEnrollmentRequest = z.infer<typeof CreateEnrollmentRequestSchema>;

export const CreateEnrollmentResponseSchema = z.strictObject({
  id: z.uuid(),
  machine: MachineNameSchema,
  roles: z.array(WorkerRoleSchema),
  /** Chỉ trả một lần; hub lưu sha256. */
  code: z.string().min(20),
  expires_at: IsoDateTimeSchema,
  /** Địa chỉ hub mà máy worker gọi tới (`FARM_PUBLIC_URL`), null nếu hub chưa cấu hình. */
  public_url: z.string().nullable(),
});
export type CreateEnrollmentResponse = z.infer<typeof CreateEnrollmentResponseSchema>;

export const EnrollRequestSchema = z.strictObject({
  code: z.string().min(20).max(200),
  os: z.enum(['windows', 'linux', 'darwin']),
  cpu_cores: z.int().positive().max(1024),
  ram_mb: z.int().positive(),
  gpus: z.array(z.strictObject({ name: z.string().max(200), vram_mb: z.int().nonnegative() })).max(16).default([]),
});
export type EnrollRequest = z.input<typeof EnrollRequestSchema>;

export const EnrolledNodeSchema = z.strictObject({
  role: WorkerRoleSchema,
  package: z.string(),
  node_id: z.uuid(),
  name: z.string(),
  kinds: z.array(JobTypeSchema),
  token: z.string().min(20),
});
export type EnrolledNode = z.infer<typeof EnrolledNodeSchema>;

/** Model Ollama máy quét phải có: trùng `ANALYSIS_MODEL` của chủ job (hub cấu hình `FARM_OLLAMA_MODELS`). */
const OllamaModelsSchema = z.array(z.string().min(1).max(200)).max(20);

export const EnrollResponseSchema = z.strictObject({
  machine: MachineNameSchema,
  nodes: z.array(EnrolledNodeSchema).min(1),
  ollama_models: OllamaModelsSchema,
});
export type EnrollResponse = z.infer<typeof EnrollResponseSchema>;

/** `GET /v1/worker/me` (token node): script cài chờ tới khi worker vừa cài đã gửi heartbeat. */
export const WorkerMeResponseSchema = z.strictObject({
  node_id: z.uuid(),
  name: z.string(),
  status: z.enum(['active', 'disabled']),
  agent_version: z.string().nullable(),
  last_seen_at: IsoDateTimeSchema.nullable(),
  ollama_models: OllamaModelsSchema,
});
export type WorkerMeResponse = z.infer<typeof WorkerMeResponseSchema>;
