import type { JobStatus } from '../../types/api';

const TERMINAL: Set<JobStatus> = new Set(['completed', 'failed', 'cancelled']);

/** True khi ít nhất một job trong danh sách đang ở trạng thái không phải terminal. */
export function hasActiveJobs(statuses: JobStatus[]): boolean {
  return statuses.some((s) => !TERMINAL.has(s));
}

/**
 * Trả về interval refetch (ms) cho React Query.
 * - Nếu có job đang chạy: dùng `activeMs` (mặc định 5000).
 * - Ngược lại: false (tắt polling).
 */
export function pollInterval(statuses: JobStatus[], activeMs = 5000): number | false {
  return hasActiveJobs(statuses) ? activeMs : false;
}
