import { resolve } from 'node:path';

/**
 * Thư mục gói phát hành worker (zip + latest.json), phục vụ ở `/dist/`: `FARM_RELEASES_DIR`, không có thì `releases/`
 * ở gốc repo (dist/config/ hay src/config/ của apps/api cùng độ sâu).
 */
export function releasesDir(configured: string | undefined): string {
  return configured && configured.trim() ? configured : resolve(__dirname, '..', '..', '..', '..', 'releases');
}
