import { describe, expect, it } from 'vitest';
import { statusColor, statusLabel } from '../shared/lib/status';
import type { JobStatus } from '../types/api';

const STATUSES: JobStatus[] = ['queued', 'leased', 'completed', 'failed', 'cancelled'];

describe('statusColor', () => {
  it('maps every known status to a non-empty colour', () => {
    for (const s of STATUSES) {
      const colour = statusColor(s);
      expect(typeof colour).toBe('string');
      expect(colour.length).toBeGreaterThan(0);
    }
  });

  it('queued -> default', () => expect(statusColor('queued')).toBe('default'));
  it('leased -> processing', () => expect(statusColor('leased')).toBe('processing'));
  it('completed -> success', () => expect(statusColor('completed')).toBe('success'));
  it('failed -> error', () => expect(statusColor('failed')).toBe('error'));
  it('cancelled -> warning', () => expect(statusColor('cancelled')).toBe('warning'));
});

describe('statusLabel', () => {
  it('returns a non-empty string for every status', () => {
    for (const s of STATUSES) {
      expect(statusLabel(s).length).toBeGreaterThan(0);
    }
  });

  it('returns the raw value for unknown status', () => {
    expect(statusLabel('unknown' as JobStatus)).toBe('unknown');
  });
});
