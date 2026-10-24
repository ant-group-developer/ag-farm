/**
 * "Lấy log" (trang Máy của farm): gom log của máy worker để gửi hub — log worker (`<roleDir>\logs\worker*.log`), cài đặt
 * (`<InstallDir>\logs\setup*.log`) và bộ cập nhật (`<InstallDir>\updater\updater.log`), lọc theo khoảng giờ admin chọn.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { NODE_LOG_MAX_TEXT_BYTES } from '@ag-farm/protocol';

/** Không có khoảng giờ thì lấy chừng này byte cuối của mỗi file. */
export const NODE_LOG_TAIL_BYTES = 2 * 1024 * 1024;
/** Một file đọc tối đa chừng này byte cuối (worker.log quay vòng ở 20 MB). */
const MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * Thư mục log của máy cài bằng install.ps1, suy từ `--config <roleDir>\config.yaml` của tiến trình (run.cmd luôn truyền):
 * `<roleDir>\logs`, `<InstallDir>\logs`, `<InstallDir>\updater`. Không có `--config` thì rỗng (không gửi log).
 */
export function defaultLogDirs(argv: readonly string[] = process.argv): string[] {
  const i = argv.indexOf('--config');
  const config = i >= 0 ? argv[i + 1] : undefined;
  if (!config) return [];
  const roleDir = dirname(resolve(config));
  const installDir = dirname(roleDir);
  return [join(roleDir, 'logs'), join(installDir, 'logs'), join(installDir, 'updater')];
}

const JSON_TIME = /"time":"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)"/;
const LEADING_TIME = /^\[?(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)/;

/**
 * Lúc của một dòng log (ms): `"time":"…Z"` của log JSON worker, hoặc `[yyyy-MM-dd HH:mm:ss]` đầu dòng (setup.log,
 * updater.log, theo giờ máy). Null khi dòng không ghi giờ (dòng tiếp của một lỗi nhiều dòng).
 */
export function lineTime(line: string): number | null {
  const json = JSON_TIME.exec(line);
  if (json) return Date.parse(json[1]!);
  const lead = LEADING_TIME.exec(line);
  if (lead) {
    const t = new Date(`${lead[1]}T${lead[2]}`).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export interface CollectLogsOptions {
  dirs: readonly string[];
  /** Chỉ dòng từ/tới lúc này (ISO); cả hai null: phần cuối của mỗi file. */
  since: string | null;
  until: string | null;
  tailBytes?: number;
  maxBytes?: number;
}

/** Các file `.log` của một thư mục (thiếu thư mục thì rỗng), cũ trước. */
async function logFiles(dir: string): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ path: string; mtimeMs: number; size: number }> = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.log')) continue;
    try {
      const s = await stat(join(dir, name));
      if (s.isFile()) out.push({ path: join(dir, name), mtimeMs: s.mtimeMs, size: s.size });
    } catch {
      // file vừa quay vòng: bỏ
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** `limit` byte cuối của file, bắt đầu từ đầu một dòng. */
async function tail(path: string, size: number, limit: number): Promise<string> {
  const buf = await readFile(path);
  if (size <= limit) return buf.toString('utf8');
  const part = buf.subarray(buf.length - limit).toString('utf8');
  const nl = part.indexOf('\n');
  return nl >= 0 ? part.slice(nl + 1) : part;
}

/**
 * Log của máy thành một văn bản: mỗi file một phần `===== <đường dẫn> (<n> dòng) =====`. Có khoảng giờ thì chỉ giữ dòng
 * trong khoảng (dòng không ghi giờ theo dòng có giờ trước nó) và bỏ file sửa lần cuối trước `since`; không có thì
 * `tailBytes` cuối mỗi file. Quá `maxBytes` thì giữ phần cuối (mới nhất).
 */
export async function collectLogs(o: CollectLogsOptions): Promise<string> {
  const since = o.since ? Date.parse(o.since) : null;
  const until = o.until ? Date.parse(o.until) : null;
  const ranged = since !== null || until !== null;
  const tailBytes = o.tailBytes ?? NODE_LOG_TAIL_BYTES;
  const maxBytes = o.maxBytes ?? NODE_LOG_MAX_TEXT_BYTES;
  const parts: string[] = [
    `# ag-farm logs of ${hostname()} at ${new Date().toISOString()}` +
      (ranged ? `, lines from ${o.since ?? '-'} to ${o.until ?? '-'}` : `, last ${Math.round(tailBytes / 1024)} KB of each file`),
  ];
  for (const dir of o.dirs) {
    for (const f of await logFiles(dir)) {
      if (since !== null && f.mtimeMs < since) continue;
      let text: string;
      try {
        text = await tail(f.path, f.size, ranged ? MAX_FILE_BYTES : tailBytes);
      } catch (err) {
        parts.push(`===== ${f.path} (could not read: ${String(err)}) =====`);
        continue;
      }
      let lines = text.split(/\r?\n/);
      if (lines.at(-1) === '') lines.pop();
      if (ranged) {
        let at: number | null = null;
        lines = lines.filter((line) => {
          at = lineTime(line) ?? at;
          if (at === null) return since === null;
          return (since === null || at >= since) && (until === null || at <= until);
        });
      }
      parts.push(`===== ${f.path} (${lines.length} lines) =====`, ...lines);
    }
  }
  const all = `${parts.join('\n')}\n`;
  if (Buffer.byteLength(all) <= maxBytes) return all;
  const kept = Buffer.from(all).subarray(-maxBytes).toString('utf8');
  return `# (cut: only the last ${Math.round(maxBytes / 1024 / 1024)} MB are kept)\n${kept.slice(kept.indexOf('\n') + 1)}`;
}
