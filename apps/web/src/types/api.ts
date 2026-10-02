/** Types derived from the admin API (/v1/admin). All snake_case per the API contract. */

export type JobType =
  | 'scan.extract'
  | 'scan.ai'
  | 'studio.tts'
  | 'studio.render_preview'
  | 'studio.render_final'
  | 'studio.export_premiere';

export const JOB_TYPES: JobType[] = [
  'scan.extract',
  'scan.ai',
  'studio.tts',
  'studio.render_preview',
  'studio.render_final',
  'studio.export_premiere',
];

export type JobStatus = 'queued' | 'leased' | 'paused' | 'completed' | 'failed' | 'cancelled';
export const TERMINAL_JOB_STATUSES: JobStatus[] = ['completed', 'failed', 'cancelled'];

export type Lane = 'interactive' | 'batch';

export interface Gpu {
  name: string;
  vram_mb: number;
  nvenc: boolean;
  nvdec: boolean;
}

export interface NodeCapabilities {
  os: 'windows' | 'linux' | 'darwin';
  cpu_cores: number;
  ram_mb: number;
  gpus: Gpu[];
  engines: {
    ffmpeg: string | null;
    ollama_models: string[];
    python: string | null;
  };
}

export interface FreeSlots {
  cpu: number;
  gpu: number;
}

export interface NodeView {
  id: string;
  name: string;
  machine: string;
  kinds: JobType[];
  /** Admin-set allowed kinds; null = all reported kinds are allowed */
  allowed_kinds: JobType[] | null;
  status: 'active' | 'disabled';
  os: string | null;
  cpu_cores: number | null;
  ram_mb: number | null;
  gpus: Gpu[] | null;
  engines: NodeCapabilities['engines'] | null;
  capabilities: NodeCapabilities | null;
  free_slots: FreeSlots | null;
  running_job_ids: string[];
  limits: unknown | null;
  schedule: unknown | null;
  last_seen_at: string | null;
  agent_version: string | null;
  created_at: string;
  updated_at: string;
  /** Computed by server: last_seen_at within NODE_OFFLINE_AFTER_SECONDS */
  online: boolean;
}

export interface JobError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface JobResult {
  manifest: string | null;
  summary: Record<string, string | number | boolean | null>;
}

export interface JobView {
  id: string;
  owner: string;
  type: JobType;
  lane: Lane;
  status: JobStatus;
  priority: number;
  correlation_id: string;
  affinity_key: string | null;
  group_key: string | null;
  attempt_count: number;
  max_attempts: number;
  node_id: string | null;
  /** Node name — populated in admin endpoints */
  node_name?: string | null;
  progress_percent: number | null;
  progress_stage: string | null;
  result: JobResult | null;
  error: JobError | null;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  finished_at: string | null;
  acked_at: string | null;
  /** Payload — returned by admin endpoints */
  payload?: unknown;
  /** Requirements — returned by admin GET /jobs/:id */
  requirements?: Record<string, unknown>;
  /** not_before — returned by admin GET /jobs/:id */
  not_before?: string | null;
  /** lease_expires_at — returned by admin GET /jobs/:id and list */
  lease_expires_at?: string | null;
}

/** Paged response envelope used by admin list endpoints (jobs, nodes, owners). */
export interface PagedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type JobSortBy = 'createdAt' | 'updatedAt' | 'priority' | 'status' | 'type';
export type NodeSortBy = 'name' | 'lastSeenAt' | 'createdAt';
export type OwnerSortBy = 'name' | 'createdAt';
export type SortOrder = 'asc' | 'desc';

export interface AdminListJobsQuery {
  page?: number;
  pageSize?: number;
  sortBy?: JobSortBy;
  sortOrder?: SortOrder;
  status?: string;
  type?: string;
  owner?: string;
  node?: string;
  q?: string;
}

export interface AdminListNodesQuery {
  page?: number;
  pageSize?: number;
  sortBy?: NodeSortBy;
  sortOrder?: SortOrder;
  status?: 'active' | 'disabled';
  q?: string;
}

export interface AdminListOwnersQuery {
  page?: number;
  pageSize?: number;
  sortBy?: OwnerSortBy;
  sortOrder?: SortOrder;
  q?: string;
}

export interface StatsResponse {
  jobs: Array<{ status: JobStatus; type: JobType; count: number }>;
  nodes: { total: number; online: number };
}

export interface OwnerView {
  id: string;
  sign_url: string;
  allowed_types: JobType[];
  created_at: string;
  updated_at: string;
}

export interface CreateNodeRequest {
  name: string;
  machine?: string;
  kinds: JobType[];
}

export interface PatchNodeRequest {
  name?: string;
  kinds?: JobType[];
  allowed_kinds?: JobType[] | null;
  status?: 'active' | 'disabled';
}

export interface CreateOwnerRequest {
  id: string;
  sign_url: string;
  allowed_types: JobType[];
}

export interface PatchOwnerRequest {
  sign_url?: string;
  allowed_types?: JobType[];
}

// ---- Cài máy worker bằng mã (xem ag-farm/packages/protocol/src/enroll.ts) ----

export type WorkerRole = 'scan' | 'render';

export interface CreateEnrollmentRequest {
  machine: string;
  roles: WorkerRole[];
}

export interface CreateEnrollmentResponse {
  id: string;
  machine: string;
  roles: WorkerRole[];
  /** Chỉ trả một lần. */
  code: string;
  expires_at: string;
  /** Địa chỉ hub cho máy worker (FARM_PUBLIC_URL), null nếu hub chưa cấu hình. */
  public_url: string | null;
}
