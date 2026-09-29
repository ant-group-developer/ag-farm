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
    default:
      return 'default';
  }
}

/** Nhãn tiếng Việt của trạng thái job. */
export function statusLabel(status: JobStatus): string {
  switch (status) {
    case 'queued':
      return 'Chờ';
    case 'leased':
      return 'Đang chạy';
    case 'completed':
      return 'Hoàn tất';
    case 'failed':
      return 'Thất bại';
    case 'cancelled':
      return 'Đã hủy';
    default:
      return status;
  }
}
