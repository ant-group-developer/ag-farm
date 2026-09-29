/**
 * Tiện ích chạy tiến trình con.
 * runProcess: spawn async, có timeout, kill cả cây (Windows: taskkill /T /F; POSIX: kill -PGID).
 * childEnvWithoutSecrets: lọc bỏ biến môi trường có tên chứa bí mật.
 */
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import { execFile } from 'node:child_process';

export interface RunProcessOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
}

/**
 * Chạy lệnh và trả về khi hoàn thành.
 * Nếu timeout hoặc signal bị hủy thì kill cả cây tiến trình.
 */
export async function runProcess(
  cmd: string,
  args: string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  const { timeoutMs, signal, cwd, env, onStdoutLine, onStderrLine } = options;
  const isWindows = os.platform() === 'win32';

  // POSIX: spawn detached để có process group riêng
  const child = spawn(cmd, args, {
    cwd,
    env: env ?? process.env,
    detached: !isWindows,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (!isWindows) {
    // Tạo process group ngay khi spawn xong
    child.unref();
  }

  let stdoutBuf = '';
  let stderrBuf = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    while (true) {
      const nl = stdoutBuf.indexOf('\n');
      if (nl < 0) break;
      onStdoutLine?.(stdoutBuf.slice(0, nl).trimEnd());
      stdoutBuf = stdoutBuf.slice(nl + 1);
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
    while (true) {
      const nl = stderrBuf.indexOf('\n');
      if (nl < 0) break;
      onStderrLine?.(stderrBuf.slice(0, nl).trimEnd());
      stderrBuf = stderrBuf.slice(nl + 1);
    }
  });

  const killTree = (): void => {
    if (child.killed) return;
    if (isWindows) {
      // taskkill kills the entire tree including subprocesses
      execFile('taskkill', ['/PID', String(child.pid!), '/T', '/F'], () => {
        // Không cần kết quả
      });
    } else {
      try {
        // Giết cả process group (POSIX, detached=true nên pid > 0 = pgid)
        if (child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        child.kill('SIGKILL');
      }
    }
  };

  return new Promise<ProcessResult>((resolve) => {
    let done = false;

    const finish = (exitCode: number | null, sig: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Flush remaining lines
      if (stdoutBuf) onStdoutLine?.(stdoutBuf.trimEnd());
      if (stderrBuf) onStderrLine?.(stderrBuf.trimEnd());
      resolve({ exitCode, signal: sig });
    };

    const onAbort = () => {
      killTree();
      finish(null, 'SIGKILL');
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        killTree();
        finish(null, 'SIGKILL');
      }, timeoutMs);
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    child.on('close', (code, sig) => {
      finish(code, sig);
    });
    child.on('error', () => {
      finish(null, null);
    });
  });
}

/**
 * Trả về bản sao env đã lọc bỏ token/key/secret.
 * Dựa theo child-env.ts của harness: DENYLIST theo prefix tên biến (case-insensitive).
 * Loại bỏ thêm: TOKEN, SECRET, KEY, PASSWORD, CREDENTIAL kèm dấu _ ở xung quanh
 * để tránh rò ag-farm token hoặc R2 key sang tiến trình con.
 */
export function childEnvWithoutSecrets(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const DENY_PATTERNS = [
    /^HARNESS_SECRET_/i,
    /^AG_FARM_TOKEN/i,
    /^AG_FARM_SECRET/i,
    // Thêm pattern tuỳ ý nếu worker-sdk được mở rộng
  ];

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const upper = k.toUpperCase();
    if (DENY_PATTERNS.some((p) => p.test(upper))) continue;
    out[k] = v;
  }
  return out;
}
