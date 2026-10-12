/**
 * Gói phát hành worker: `/dist/latest.json` của hub (thư mục `FARM_RELEASES_DIR`) nói bản mới nhất của từng gói.
 * install.ps1 cài theo nó; worker tự cập nhật đọc nó để biết có bản mới hơn của gói mình không.
 */
import { z } from 'zod';
import { IsoDateTimeSchema } from './common';

/** `1.2.3` hoặc `1.2.3-rc.1` (không nhận `+build`). */
export const ReleaseVersionSchema = z
  .string()
  .max(60)
  .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, { message: 'Version must look like 1.2.3 or 1.2.3-rc.1' });

/** Tên gói: `ag-render-worker`, `ag-scan-worker`, ... */
export const ReleasePackageNameSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z][a-z0-9-]*$/);

export const ReleaseEntrySchema = z.object({
  version: ReleaseVersionSchema,
  /** Tên file zip nằm cạnh latest.json. */
  file: z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+\.zip$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size_bytes: z.int().nonnegative(),
  built_at: IsoDateTimeSchema.optional(),
});
export type ReleaseEntry = z.infer<typeof ReleaseEntrySchema>;

/** Đọc lỏng (`object`, không strict): hub mới thêm khoá thì worker cũ vẫn đọc được. */
export const ReleaseManifestSchema = z.object({
  packages: z.record(z.string(), ReleaseEntrySchema).default({}),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

function parseVersion(v: string): { nums: number[]; pre: string[] } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/**
 * So hai phiên bản kiểu semver: âm nếu `a` cũ hơn `b`, 0 nếu bằng, dương nếu mới hơn. Bản `-rc` đứng trước bản chính
 * cùng số. Chuỗi không đọc được coi như cũ hơn mọi bản đọc được (worker báo `0.0.0`/rác thì vẫn thấy có bản mới).
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    const d = pa.nums[i]! - pb.nums[i]!;
    if (d !== 0) return d;
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx - ny;
    } else if (nx !== null) {
      return -1;
    } else if (ny !== null) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
