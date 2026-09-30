import i18n from 'i18next';
import type { JobStatus } from '../../types/api';

/** Map trạng thái job sang màu badge Ant Design. */
export function statusColor(status: JobStatus): string {
  switch (status) {
    case 'queued':
      return 'default';
    case 'leased':
      return 'processing';
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'warning';
    case 'paused':
      return 'default';
    default:
      return 'default';
  }
}

const KNOWN_STATUSES: readonly string[] = ['queued', 'leased', 'paused', 'completed', 'failed', 'cancelled'];

/** Nhãn của trạng thái job theo ngôn ngữ đang dùng; trạng thái lạ thì trả nguyên giá trị. */
export function statusLabel(status: JobStatus): string {
  return KNOWN_STATUSES.includes(status) ? i18n.t(`status.${status}`) : status;
}
