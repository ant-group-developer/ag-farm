/** Types derived from the admin API (/v1/admin). All snake_case per the API contract. */

export type JobType =
  | 'scan.extract'
  | 'scan.ai'
  | 'scan.prep'
  | 'studio.tts'
  | 'studio.render_preview'
  | 'studio.render_final'
  | 'studio.export_premiere'
  | 'studio.transcribe'
  | 'studio.reference_fetch'
  | 'studio.beats';

export const JOB_TYPES: JobType[] = [
  'scan.extract',
  'scan.ai',
  'scan.prep',
  'studio.tts',
  'studio.render_preview',
  'studio.render_final',
  'studio.export_premiere',
  'studio.transcribe',
  'studio.reference_fetch',
  'studio.beats',
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
    /** yt-dlp version; absent from workers that do not probe it. */
    ytdlp?: string | null;
  };
}

export interface FreeSlots {
  cpu: number;
  gpu: number;
}

/** One "Lấy log" request of a worker (`GET /v1/admin/nodes/:id/logs`). */
export interface NodeLogView {
  id: string;
  node_id: string;
  status: 'requested' | 'uploaded' | 'failed';
  since: string | null;
  until: string | null;
  requested_at: string;
  uploaded_at: string | null;
  /** Size of the logs, uncompressed. */
  size_bytes: number | null;
  error: string | null;
}

export interface NodeView {
  id: string;
  name: string;
  machine: string;
  kinds: JobType[];
  /** Job types the admin turned off on this node; the node takes every other kind it reports. */
  blocked_kinds: JobType[];
  /** Pool máy (chi nhánh): chỉ nhận job của pool đó; null = máy chung. */
  pool: string | null;
  status: 'active' | 'disabled';
  /** Thứ tự nhận việc, số nhỏ trước: máy xếp trước còn slot thì nhận job trước máy xếp sau. */
  priority_order: number;
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
  /** The worker updates itself when the farm publishes a newer release (default on). */
  auto_update: boolean;
  /** Last time an admin pressed "Update now". */
  update_requested_at: string | null;
  /** Self-update state from the worker's latest heartbeat that carried one; null for workers without self-update. */
  update: NodeUpdateStatus | null;
  update_at: string | null;
  /** Latest machine reading (CPU, RAM, disks, network, GPU); absent from hubs before metrics, null before the first one. */
  metrics?: MachineMetrics | null;
  /** When the hub got `metrics`; older than 2 minutes means the reading is stale. */
  metrics_at?: string | null;
  created_at: string;
  updated_at: string;
  /** Computed by server: last_seen_at within NODE_OFFLINE_AFTER_SECONDS */
  online: boolean;
}

export interface DiskMetrics {
  /** `C:` on Windows, the directory on Linux. */
  path: string;
  free_mb: number;
  total_mb: number;
}

export interface GpuMetrics {
  index: number;
  util_pct?: number;
  vram_used_mb?: number;
  vram_total_mb?: number;
  temp_c?: number;
}

/** What a worker measured on its machine; anything it could not measure is left out. */
export interface MachineMetrics {
  cpu_pct?: number;
  ram_used_mb?: number;
  ram_total_mb?: number;
  disks?: DiskMetrics[];
  /** Bytes per second, all network cards of the machine. */
  net_rx_bps?: number;
  net_tx_bps?: number;
  gpus?: GpuMetrics[];
  uptime_s?: number;
}

export type MetricRange = '1h' | '24h' | '7d';

export interface MachineMetricGpuPoint {
  index: number;
  util_pct: number | null;
  vram_used_mb: number | null;
  vram_total_mb: number | null;
  temp_c: number | null;
}

/** One chart point: averages over the bucket (disk: lowest free; GPU temperature: highest); null when nothing came in. */
export interface MachineMetricPoint {
  t: string;
  cpu_pct: number | null;
  ram_used_mb: number | null;
  ram_total_mb: number | null;
  disk_free_mb: number | null;
  disk_total_mb: number | null;
  net_rx_bps: number | null;
  net_tx_bps: number | null;
  gpus: MachineMetricGpuPoint[];
}

export interface MachineMetricsSeries {
  machine: string;
  range: MetricRange;
  bucket_seconds: number;
  from: string;
  to: string;
  points: MachineMetricPoint[];
}

export type NodeUpdateState = 'idle' | 'draining' | 'installing' | 'failed';

export interface NodeUpdateStatus {
  state: NodeUpdateState;
  target_version?: string;
  /** Why it failed (with the last line of setup.log), or how the last update went. */
  message?: string;
  since?: string;
}

export interface ReleaseEntry {
  version: string;
  file: string;
  sha256: string;
  size_bytes: number;
  built_at?: string;
}

/** The hub's /dist/latest.json: the newest release of each worker package. */
export interface ReleaseManifest {
  packages: Record<string, ReleaseEntry>;
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
export type NodeSortBy = 'priorityOrder' | 'name' | 'lastSeenAt' | 'createdAt';
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

/** Đơn vị gom nhóm của biểu đồ theo thời gian (GET /v1/admin/stats/period). */
export type StatsBucket = 'hour' | 'day' | 'month';

export interface StatsPeriodQuery {
  /** ISO, tính từ (gồm) */
  from: string;
  /** ISO, đến (không gồm) */
  to: string;
  bucket: StatsBucket;
  /** Múi giờ IANA để chia ngày/tháng theo lịch người xem */
  tz: string;
}

/** Số job trong kỳ: tạo ra theo created_at, kết thúc theo finished_at; thời gian chạy của job hoàn tất (lần chạy cuối). */
export interface StatsPeriodTotals {
  created: number;
  completed: number;
  failed: number;
  cancelled: number;
  avg_duration_ms: number | null;
  p95_duration_ms: number | null;
}

export interface StatsPeriodPoint {
  /** Đầu ô theo giờ địa phương của tz, dạng YYYY-MM-DDTHH:mm:ss (không có offset) */
  t: string;
  created: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface StatsPeriodResponse {
  range: StatsPeriodQuery;
  summary: StatsPeriodTotals;
  /** Đủ mọi ô trong kỳ, kể cả ô trống */
  series: StatsPeriodPoint[];
  by_type: Array<StatsPeriodTotals & { type: JobType }>;
}

export interface OwnerView {
  id: string;
  sign_url: string;
  allowed_types: JobType[];
  /** Domain web của ứng dụng, vd. `https://studio.example.com`; web admin ghép đường dẫn trang video / dự án. */
  web_url: string | null;
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
  blocked_kinds?: JobType[];
  status?: 'active' | 'disabled';
  priority_order?: number;
  auto_update?: boolean;
  /** Pool (a branch's own machines); null or "": the shared machines. */
  pool?: string | null;
}

export interface CreateOwnerRequest {
  id: string;
  sign_url: string;
  allowed_types: JobType[];
  web_url?: string | null;
}

export interface PatchOwnerRequest {
  sign_url?: string;
  allowed_types?: JobType[];
  web_url?: string | null;
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
