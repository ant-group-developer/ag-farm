/**
 * Thư mục làm việc của job (`work_dir/<job id>`): worker ghi pid của mình vào `.owner` khi tạo, lúc khởi động xoá các
 * thư mục mà process ghi nó đã không còn (worker bị tắt ngang để lại). Nhiều worker trên một máy có thể dùng chung
 * `work_dir`, nên không xoá thư mục của một worker khác đang chạy.
 */
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OWNER_FILE = '.owner';
const JOB_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Thư mục không có `.owner` (worker bản trước) chỉ xoá khi đã cũ thế này. */
const UNMARKED_MAX_AGE_MS = 24 * 60 * 60_000;

export function markWorkDir(dir: string, pid = process.pid): void {
  try {
    writeFileSync(join(dir, OWNER_FILE), String(pid));
  } catch {
    // không ghi được thì lần khởi động sau coi như thư mục chưa đánh dấu
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: process có, chỉ là không được gửi tín hiệu
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Xoá các thư mục job bị bỏ lại trong `workDir`; trả tên các thư mục đã xoá. */
export function cleanStaleWorkDirs(
  workDir: string,
  opts: { now?: number; isAlive?: (pid: number) => boolean } = {},
): string[] {
  const now = opts.now ?? Date.now();
  const isAlive = opts.isAlive ?? alive;
  let names: string[];
  try {
    names = readdirSync(workDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!JOB_DIR_RE.test(name)) continue;
    const dir = join(workDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      let stale: boolean;
      try {
        const pid = Number(readFileSync(join(dir, OWNER_FILE), 'utf8').trim());
        stale = !Number.isInteger(pid) || pid <= 0 || (pid !== process.pid && !isAlive(pid));
      } catch {
        stale = now - statSync(dir).mtimeMs > UNMARKED_MAX_AGE_MS;
      }
      if (!stale) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // thư mục đang bị khoá (Windows) hay vừa bị xoá: để lần sau
    }
  }
  return removed;
}
