import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { formatLogSize, logRangeBody, logsWaiting } from '../modules/nodes/node-logs';
import type { NodeLogView } from '../types/api';

const log = (status: NodeLogView['status']): NodeLogView => ({
  id: status, node_id: 'n', status, since: null, until: null, requested_at: '2026-10-24T00:00:00.000Z', uploaded_at: null, size_bytes: null, error: null,
});

describe('node logs', () => {
  it('sends the picked range as ISO times, an empty side as null', () => {
    const from = dayjs('2026-10-23T10:15:00+07:00');
    expect(logRangeBody([from, null])).toEqual({ since: '2026-10-23T03:15:00.000Z', until: null });
    expect(logRangeBody(null)).toEqual({ since: null, until: null });
  });

  it('says a log size in B, KB or MB', () => {
    expect(formatLogSize(null)).toBe('-');
    expect(formatLogSize(850)).toBe('850 B');
    expect(formatLogSize(12 * 1024)).toBe('12 KB');
    expect(formatLogSize(3.44 * 1024 * 1024)).toBe('3.4 MB');
  });

  it('keeps asking the hub only while a request waits for the worker', () => {
    expect(logsWaiting([log('uploaded'), log('requested')])).toBe(true);
    expect(logsWaiting([log('uploaded'), log('failed')])).toBe(false);
    expect(logsWaiting(undefined)).toBe(false);
  });
});
