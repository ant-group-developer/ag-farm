/**
 * Loại job worker báo cho hub (heartbeat) và xin khi claim.
 */
import { JOB_TYPE_SPECS, meetsRequirements } from '@ag-farm/protocol';
import type { Capabilities, JobType } from '@ag-farm/protocol';

/**
 * - `configured` (khoá `kinds` trong config.yaml) có thì đó là danh sách ép: giữ những loại có handler (có thể rỗng:
 *   worker không nhận việc, như trước).
 * - Không có: mọi loại có handler mà máy đáp ứng điều kiện gốc của loại đó (`JOB_TYPE_SPECS[k].baseRequirements`:
 *   GPU, Python có torch, NVENC, yt-dlp…). Bản worker mới thêm handler hay máy vừa cài thêm công cụ thì loại job mới
 *   tự có, không phải sửa config; admin hub tắt loại nào thì chặn ở hub.
 * Không ép mà máy không đủ điều kiện loại nào thì báo mọi loại có handler: hub cần ít nhất một loại để máy hiện
 * Online, và hub vẫn tự kiểm điều kiện của từng job khi giao.
 */
export function workerKinds(
  handlers: Partial<Record<JobType, unknown>>,
  capabilities: Capabilities,
  configured?: readonly JobType[],
): JobType[] {
  const handled = (Object.keys(handlers) as JobType[]).filter((k) => handlers[k] && JOB_TYPE_SPECS[k]);
  if (configured) return configured.filter((k) => handled.includes(k));
  const able = handled.filter((k) => meetsRequirements(capabilities, JOB_TYPE_SPECS[k].baseRequirements));
  return able.length > 0 ? able : handled;
}
