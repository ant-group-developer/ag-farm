import { describe, expect, it } from 'vitest';
import { hasActiveJobs, pollInterval } from '../shared/lib/poll';
import type { JobStatus } from '../types/api';

describe('hasActiveJobs', () => {
  it('returns false when all jobs are terminal', () => {
    const statuses: JobStatus[] = ['completed', 'failed', 'cancelled'];
    expect(hasActiveJobs(statuses)).toBe(false);
  });

  it('returns true when any job is queued', () => {
    expect(hasActiveJobs(['queued', 'completed'])).toBe(true);
  });

  it('returns true when any job is leased', () => {
    expect(hasActiveJobs(['leased'])).toBe(true);
  });

  it('returns false for empty list', () => {
    expect(hasActiveJobs([])).toBe(false);
  });
});

describe('pollInterval', () => {
  it('returns activeMs when there are active jobs', () => {
    expect(pollInterval(['queued'], 5000)).toBe(5000);
  });

  it('returns false when all jobs are terminal', () => {
    expect(pollInterval(['completed', 'failed'])).toBe(false);
  });

  it('uses custom interval', () => {
    expect(pollInterval(['leased'], 3000)).toBe(3000);
  });

  it('returns false for empty list', () => {
    expect(pollInterval([])).toBe(false);
  });
});
