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
 * Phát hành lên farm:
 *   --publish --upload <hub>   đẩy zip lên hub (`POST /v1/admin/releases`); hub kiểm sha256, chỉ nhận bản mới hơn,
 *                              ghi zip + latest.json vào FARM_RELEASES_DIR. Khoá lấy từ biến môi trường
 *                              FARM_RELEASE_KEY (đổi tên biến: --key-env <TÊN>), không bao giờ in ra.
 *   --publish <thư mục>        chép zip vào một thư mục phát hành (vd. bản sao FARM_RELEASES_DIR trên máy này) và ghi
 *                              phiên bản, sha256 vào latest.json ở đó.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, openAsBlob, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Biến môi trường chứa khoá phát hành của hub (`FARM_RELEASE_KEY` của hub) khi không có `--key-env`. */
export const DEFAULT_RELEASE_KEY_ENV = 'FARM_RELEASE_KEY';

function argAfter(argv, flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return { present: false, value: null };
  const next = argv[i + 1];
  return { present: true, value: next && !next.startsWith('--') ? next : null };
}

/** Đường dẫn thư mục phát hành lấy từ `--publish <dir>` trong argv, hoặc null (cả khi `--publish --upload <hub>`). */
export function publishDirFromArgv(argv = process.argv) {
  return argAfter(argv, '--publish').value;
}

/**
 * Cách phát hành trong argv: `{ publishDir, uploadUrl, keyEnv }`. `--upload <hub>` (thường đi với `--publish`) đẩy lên
 * hub; `--publish <dir>` chép vào thư mục. Không có gì: chỉ đóng gói.
 */
export function publishOptionsFromArgv(argv = process.argv) {
  const upload = argAfter(argv, '--upload');
  if (upload.present && !upload.value) throw new Error('--upload can dia chi hub, vd. --upload https://api-farm.ant-group.net');
  const keyEnv = argAfter(argv, '--key-env').value ?? DEFAULT_RELEASE_KEY_ENV;
  return { publishDir: publishDirFromArgv(argv), uploadUrl: upload.value, keyEnv };
}

/**
 * Đẩy một gói lên hub. Khoá chỉ đi trong header `Authorization: Release <khoá>`, không in, không ghi log. Trả bản ghi
 * hub lưu trong latest.json; lỗi (bản không mới hơn, sha256 sai, sai khoá, quá lớn) ném Error có câu của hub.
 * @param {{ hubUrl: string, zipPath: string, packageName: string, version: string, sha256: string, builtAt?: string, key: string, fetchImpl?: typeof fetch }} o
 */
export async function uploadRelease(o) {
  const form = new FormData();
  form.append('package', o.packageName);
  form.append('version', o.version);
  form.append('sha256', o.sha256);
  if (o.builtAt) form.append('built_at', o.builtAt);
  form.append('file', await openAsBlob(o.zipPath, { type: 'application/zip' }), basename(o.zipPath));
  const url = `${o.hubUrl.replace(/\/+$/, '')}/v1/admin/releases`;
  const res = await (o.fetchImpl ?? fetch)(url, { method: 'POST', headers: { Authorization: `Release ${o.key}` }, body: form });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // nginx/proxy trả HTML
  }
  if (!res.ok) {
    const err = body?.error ?? body ?? {};
    const reason = err.message || text.slice(0, 300) || res.statusText;
    throw new Error(`Hub tu choi goi ${o.packageName} ${o.version}: HTTP ${res.status}${err.code ? ` ${err.code}` : ''} - ${reason}`);
  }
  return body && typeof body === 'object' && 'data' in body && 'success' in body ? body.data : body;
}

/**
 * @param {{ repoRoot: string, releaseRoot: string, name: string, packageName: string, version: string, publishDir?: string | null, uploadUrl?: string | null, keyEnv?: string }} o
 *   repoRoot: repo worker (lấy binary ffmpeg đã cài); releaseRoot: thư mục `release/` chứa `<name>/`;
 *   name: `<packageName>-<version>`.
 */
export async function finishRelease(o) {
  const out = join(o.releaseRoot, o.name);
  const isWindows = process.platform === 'win32';

  // Đẩy lên hub: kiểm có khoá trước khi đóng gói vài phút. Chỉ nói tên biến, không bao giờ in giá trị.
  const keyEnv = o.keyEnv ?? DEFAULT_RELEASE_KEY_ENV;
  const key = o.uploadUrl ? process.env[keyEnv] : undefined;
  if (o.uploadUrl && !key) {
    throw new Error(`Thieu bien moi truong ${keyEnv}: dat khoa phat hanh cua hub (FARM_RELEASE_KEY trong .env cua hub) vao bien nay roi chay lai`);
  }

  // 1. Binary native cài sẵn trong gói (trước đây máy đích phải `npm install`). `--ignore-scripts`: script
  //    postinstall của ffmpeg-static tải ffmpeg từ GitHub (rất chậm); binary đó đã có trong node_modules của
  //    repo worker trên máy build, chép sang.
  execFileSync(isWindows ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], {
    cwd: out,
    stdio: 'inherit',
    shell: isWindows,
  });
  const ffmpegName = isWindows ? 'ffmpeg.exe' : 'ffmpeg';
  const ffmpegOut = join(out, 'node_modules', 'ffmpeg-static', ffmpegName);
  if (existsSync(join(out, 'node_modules', 'ffmpeg-static')) && !existsSync(ffmpegOut)) {
    const local = join(o.repoRoot, 'node_modules', 'ffmpeg-static', ffmpegName);
    if (existsSync(local)) {
      copyFileSync(local, ffmpegOut);
    } else {
      execFileSync(process.execPath, ['install.js'], { cwd: join(out, 'node_modules', 'ffmpeg-static'), stdio: 'inherit' });
    }
  }

  // ffprobe-static mang binary cho mọi hệ điều hành (~340 MB): gói Windows chỉ giữ win32/x64.
  const ffprobeBin = join(out, 'node_modules', 'ffprobe-static', 'bin');
  if (isWindows && existsSync(ffprobeBin)) {
    for (const platform of ['darwin', 'linux']) rmSync(join(ffprobeBin, platform), { recursive: true, force: true });
    rmSync(join(ffprobeBin, 'win32', 'ia32'), { recursive: true, force: true });
  }

  // 2. Node chạy worker: đúng bản của máy build
  if (isWindows) {
    mkdirSync(join(out, 'runtime'), { recursive: true });
    copyFileSync(process.execPath, join(out, 'runtime', 'node.exe'));
  } else {
    console.warn('Khong build tren Windows: goi khong co runtime/node.exe, install.ps1 se khong chay duoc goi nay.');
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
  const builtAt = new Date().toISOString();
  console.log(`Da tao ${zip} (${(size / 1024 / 1024).toFixed(1)} MB, sha256 ${sha256})`);

  // 5. Phát hành lên farm
  if (o.uploadUrl) {
    console.log(`Dang day ${o.name}.zip len ${o.uploadUrl} ...`);
    const entry = await uploadRelease({
      hubUrl: o.uploadUrl,
      zipPath: zip,
      packageName: o.packageName,
      version: o.version,
      sha256,
      builtAt,
      key,
    });
    console.log(`Da phat hanh ${o.packageName} ${entry?.version ?? o.version} len ${o.uploadUrl} (${entry?.file ?? `${o.name}.zip`}); may worker tu cap nhat o lan kiem ke tiep`);
  }
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
      built_at: builtAt,
    };
    writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
    console.log(`Da phat hanh ${o.name} vao ${o.publishDir}`);
  }
  return { zip, sha256, size };
}
