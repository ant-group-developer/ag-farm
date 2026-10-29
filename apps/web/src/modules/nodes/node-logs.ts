import type { Dayjs } from 'dayjs';
import type { NodeLogView } from '../../types/api';

/** What `POST /v1/admin/nodes/:id/logs` gets from the picked range: no range is the end of each log file. */
export function logRangeBody(range: [Dayjs | null, Dayjs | null] | null): { since: string | null; until: string | null } {
  return {
    since: range?.[0] ? range[0].toISOString() : null,
    until: range?.[1] ? range[1].toISOString() : null,
  };
}

/** A log's size for people: 850 B, 12 KB, 3.4 MB. */
export function formatLogSize(bytes: number | null): string {
  if (bytes === null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

/** The list keeps asking the hub while a request still waits for the worker. */
export function logsWaiting(items: NodeLogView[] | undefined): boolean {
  return (items ?? []).some((l) => l.status === 'requested');
}
