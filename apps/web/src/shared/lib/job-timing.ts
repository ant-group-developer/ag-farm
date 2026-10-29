import type { JobView } from '../../types/api';

export interface JobTiming {
  /** Lúc worker nhận lần thử gần nhất; `null` khi job chưa chạy lần nào. */
  start: string | null;
  /** Lúc kết thúc; `null` khi đang chạy hoặc chưa chạy. */
  end: string | null;
  /** Thời gian chạy (ms): đang chạy thì tính tới `now`; `null` khi không biết. */
  durationMs: number | null;
  /** Thời gian chờ trong hàng đợi trước khi được nhận (ms). */
  waitMs: number | null;
  running: boolean;
}

/**
 * Job chạy từ `started_at` (hub ghi lại mỗi lần giao, nên là lần thử gần nhất) đến `finished_at`. Job quay lại hàng
 * đợi (lease hết hạn, tạm dừng) vẫn còn `started_at` cũ: lần chạy đó dở dang nên không tính.
 */
export function jobTiming(job: JobView, now: number = Date.now()): JobTiming {
  const start = job.started_at ?? null;
  const waitMs = start ? Math.max(0, Date.parse(start) - Date.parse(job.created_at)) : null;
  if (start && job.status === 'leased') {
    return { start, end: null, durationMs: Math.max(0, now - Date.parse(start)), waitMs, running: true };
  }
  if (start && job.finished_at && job.status !== 'queued' && job.status !== 'paused') {
    const durationMs = Math.max(0, Date.parse(job.finished_at) - Date.parse(start));
    return { start, end: job.finished_at, durationMs, waitMs, running: false };
  }
  return { start: null, end: job.finished_at, durationMs: null, waitMs: null, running: false };
}

/** `0:05`, `12:34`, `1:02:03`. */
export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
