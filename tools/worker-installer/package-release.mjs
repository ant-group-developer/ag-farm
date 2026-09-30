/**
 * Bước cuối chung của `scripts/release.mjs` ở ag-scan-worker và ag-render-worker: biến thư mục phát hành
 * (dist/worker.mjs + package.json + deploy/) thành gói tự đủ mà install.ps1 cài được trên máy trắng.
 *
 *   <name>/
 *     runtime/node.exe   Node của máy build (máy đích không cần cài Node)
 *     node_modules/      binary native (ffmpeg-static, ffprobe-static, sharp) cho win32-x64
 *     run.cmd            supervisor: Task Scheduler chạy, worker chết thì chạy lại
 *     dist/, deploy/, package.json, ...
 *   <name>.zip
 *
 * Với `--publish <thư mục>`: chép zip vào thư mục phát hành của farm (FARM_RELEASES_DIR, phục vụ ở /dist/)
 * và ghi phiên bản, sha256 vào latest.json ở đó.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Đường dẫn thư mục phát hành lấy từ `--publish <dir>` trong argv, hoặc null. */
export function publishDirFromArgv(argv = process.argv) {
  const i = argv.indexOf('--publish');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

/**
 * @param {{ releaseRoot: string, name: string, packageName: string, version: string, publishDir?: string | null }} o
 *   releaseRoot: thư mục `release/` chứa `<name>/`; name: `<packageName>-<version>`.
 */
export function finishRelease(o) {
  const out = join(o.releaseRoot, o.name);
  const isWindows = process.platform === 'win32';

  // 1. Binary native cài sẵn trong gói (trước đây máy đích phải `npm install`)
  execFileSync(isWindows ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], {
    cwd: out,
    stdio: 'inherit',
    shell: isWindows,
  });

  // 2. Node chạy worker: đúng bản của máy build
  if (isWindows) {
    mkdirSync(join(out, 'runtime'), { recursive: true });
    copyFileSync(process.execPath, join(out, 'runtime', 'node.exe'));
  } else {
    console.warn('Không build trên Windows: gói không có runtime/node.exe, install.ps1 sẽ không chạy được gói này.');
  }

  // 3. Supervisor. cmd.exe cần CRLF (nhảy nhãn `goto` lỗi với LF).
  const runCmd = readFileSync(join(here, 'run.cmd'), 'utf8').replace(/\r?\n/g, '\r\n');
  writeFileSync(join(out, 'run.cmd'), runCmd, 'utf8');

  // 4. Zip. Trên Windows dùng bsdtar của hệ thống: tar của Git Bash hiểu "E:" là máy từ xa.
  const zip = `${out}.zip`;
  rmSync(zip, { force: true });
  const tar = isWindows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-a', '-c', '-f', `${o.name}.zip`, o.name], { cwd: o.releaseRoot, stdio: 'inherit' });
  const sha256 = createHash('sha256').update(readFileSync(zip)).digest('hex');
  const size = statSync(zip).size;
  console.log(`Đã tạo ${zip} (${(size / 1024 / 1024).toFixed(1)} MB, sha256 ${sha256})`);

  // 5. Phát hành lên farm
  if (o.publishDir) {
    mkdirSync(o.publishDir, { recursive: true });
    copyFileSync(zip, join(o.publishDir, `${o.name}.zip`));
    const latestPath = join(o.publishDir, 'latest.json');
    const latest = existsSync(latestPath) ? JSON.parse(readFileSync(latestPath, 'utf8')) : { packages: {} };
    latest.packages ??= {};
    latest.packages[o.packageName] = {
      version: o.version,
      file: `${o.name}.zip`,
      sha256,
      size_bytes: size,
      built_at: new Date().toISOString(),
    };
    writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
    console.log(`Đã phát hành ${o.name} vào ${o.publishDir}`);
  }
  return { zip, sha256, size };
}
