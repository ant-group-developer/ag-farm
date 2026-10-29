import { describe, expect, it } from 'vitest';
import { formatDuration, jobTiming } from '../shared/lib/job-timing';
import type { JobView } from '../types/api';

function job(over: Partial<JobView>): JobView {
  return {
    id: 'j1',
    owner: 'ag-go',
    type: 'scan.extract',
    lane: 'batch',
    status: 'queued',
    priority: 0,
    correlation_id: 'c',
    affinity_key: null,
    group_key: null,
    attempt_count: 0,
    max_attempts: 3,
    node_id: null,
    progress_percent: null,
    progress_stage: null,
    result: null,
    error: null,
    created_at: '2026-10-28T10:00:00.000Z',
    updated_at: '2026-10-28T10:00:00.000Z',
    started_at: null,
    finished_at: null,
    acked_at: null,
    ...over,
  };
}

describe('jobTiming', () => {
  it('job xong: chạy từ started_at đến finished_at, chờ từ created_at', () => {
    const timing = jobTiming(
      job({ status: 'completed', started_at: '2026-10-28T10:00:30.000Z', finished_at: '2026-10-28T10:03:35.000Z' }),
    );
    expect(timing).toEqual({
      start: '2026-10-28T10:00:30.000Z',
      end: '2026-10-28T10:03:35.000Z',
      durationMs: 185_000,
      waitMs: 30_000,
      running: false,
    });
  });

  it('job đang chạy: tính tới bây giờ', () => {
    const now = Date.parse('2026-10-28T10:01:00.000Z');
    const timing = jobTiming(job({ status: 'leased', started_at: '2026-10-28T10:00:00.000Z' }), now);
    expect(timing.running).toBe(true);
    expect(timing.end).toBeNull();
    expect(timing.durationMs).toBe(60_000);
  });

  it('job chưa chạy hoặc quay lại hàng đợi: không có thời gian chạy', () => {
    expect(jobTiming(job({})).durationMs).toBeNull();
    expect(jobTiming(job({ status: 'queued', started_at: '2026-10-28T10:00:00.000Z' })).durationMs).toBeNull();
    expect(jobTiming(job({ status: 'cancelled', finished_at: '2026-10-28T10:05:00.000Z' })).durationMs).toBeNull();
  });
});

describe('formatDuration', () => {
  it('phút:giây, giờ khi quá một giờ', () => {
    expect(formatDuration(5_400)).toBe('0:05');
    expect(formatDuration(754_000)).toBe('12:34');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
  });
});
