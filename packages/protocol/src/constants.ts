/** Lease kéo dài bao lâu sau mỗi lần claim hoặc progress. */
export const LEASE_SECONDS = 120;
/** Worker gửi progress (gia hạn lease) theo chu kỳ này. */
export const PROGRESS_INTERVAL_SECONDS = 30;
/** Worker gửi heartbeat theo chu kỳ này; hub coi máy offline khi quá 3 chu kỳ. */
export const HEARTBEAT_INTERVAL_SECONDS = 30;
/** Vé hết hạn sau lease thêm chừng này giây, để lần gọi ký URL cuối không hụt. */
export const TICKET_GRACE_SECONDS = 60;

export const AUTH_SCHEMES = {
  /** Worker → ag-farm. */
  node: 'Node',
  /** Chủ job (ag-go-api, ag-studio) → ag-farm. */
  owner: 'Owner',
  /** Worker → chủ job, để xin URL ký. */
  ticket: 'Ticket',
} as const;

export const WORKER_API = {
  heartbeat: '/v1/worker/heartbeat',
  claim: '/v1/worker/claim',
  progress: (jobId: string) => `/v1/worker/jobs/${jobId}/progress`,
  complete: (jobId: string) => `/v1/worker/jobs/${jobId}/complete`,
  fail: (jobId: string) => `/v1/worker/jobs/${jobId}/fail`,
} as const;

export const OWNER_API = {
  jobs: '/v1/owner/jobs',
  job: (jobId: string) => `/v1/owner/jobs/${jobId}`,
  ack: (jobId: string) => `/v1/owner/jobs/${jobId}/ack`,
  cancel: (jobId: string) => `/v1/owner/jobs/${jobId}/cancel`,
} as const;
