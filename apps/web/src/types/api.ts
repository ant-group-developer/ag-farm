/** Types derived from the admin API (/v1/admin). All snake_case per the API contract. */

export type JobType =
  | 'scan.extract'
  | 'scan.ai'
  | 'studio.tts'
  | 'studio.render_preview'
  | 'studio.render_final';

export const JOB_TYPES: JobType[] = [
  'scan.extract',
  'scan.ai',
  'studio.tts',
  'studio.render_preview',
  'studio.render_final',
];

export type JobStatus = 'queued' | 'leased' | 'completed' | 'failed' | 'cancelled';
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
  attempt_count: number;
  max_attempts: number;
  node_id: string | null;
  progress_percent: number | null;
  progress_stage: string | null;
  result: JobResult | null;
  error: JobError | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  acked_at: string | null;
  /** Payload from detail endpoint */
  payload?: unknown;
}

export interface JobListResponse {
  jobs: JobView[];
  next_cursor: string | null;
}

export interface StatsResponse {
  jobs: Array<{ status: JobStatus; type: JobType; count: number }>;
  nodes: { total: number; online: number };
}

export interface OwnerView {
  id: string;
  sign_url: string;
  allowed_types: JobType[];
  default_lane: Lane;
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
  status?: 'active' | 'disabled';
}

export interface CreateOwnerRequest {
  id: string;
  sign_url: string;
  allowed_types: JobType[];
  default_lane?: Lane;
}

export interface PatchOwnerRequest {
  sign_url?: string;
  allowed_types?: JobType[];
  default_lane?: Lane;
}

export interface AdminListJobsQuery {
  status?: string;
  type?: string;
  owner?: string;
  limit?: number;
  after?: string;
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
