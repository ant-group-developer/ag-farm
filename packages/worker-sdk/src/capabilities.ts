/**
 * Tự dò năng lực của máy: os/cpu/ram, GPU qua nvidia-smi,
 * ffmpeg, Ollama models, Python+torch, yt-dlp.
 * Tất cả đều có timeout ngắn; lỗi → coi như không có.
 */
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import { promisify } from 'node:util';
import type { Capabilities } from '@ag-farm/protocol';

const execFileAsync = promisify(execFile);

const DETECT_TIMEOUT_MS = 8_000;

// ---- OS / CPU / RAM ----

function detectOs(): 'windows' | 'linux' | 'darwin' {
  const p = os.platform();
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'darwin';
  return 'linux';
}

// ---- GPU ----

interface GpuInfo {
  name: string;
  vram_mb: number;
  nvenc: boolean;
  nvdec: boolean;
}

async function detectGpus(): Promise<GpuInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: DETECT_TIMEOUT_MS },
    );
    const gpus: GpuInfo[] = [];
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split(',');
      const namePart = parts[0]?.trim() ?? '';
      const vramPart = parts[1]?.trim() ?? '0';
      const vram = parseInt(vramPart, 10);
      if (!namePart) continue;
      gpus.push({
        name: namePart,
        vram_mb: Number.isFinite(vram) ? vram : 0,
        nvenc: false, // sẽ điền sau khi kiểm ffmpeg
        nvdec: false,
      });
    }
    return gpus;
  } catch {
    return [];
  }
}

// ---- ffmpeg ----

async function detectFfmpeg(ffmpegPath = 'ffmpeg'): Promise<{
  version: string | null;
  nvenc: boolean;
  nvdec: boolean;
}> {
  try {
    // Lấy dòng version
    let version: string | null = null;
    try {
      const r = await execFileAsync(ffmpegPath, ['-version'], {
        timeout: DETECT_TIMEOUT_MS,
      });
      const m = r.stdout.match(/ffmpeg version (\S+)/);
      version = m?.[1] ?? r.stdout.split('\n')[0]?.trim() ?? null;
    } catch {
      return { version: null, nvenc: false, nvdec: false };
    }

    // Kiểm nvenc
    let nvenc = false;
    try {
      const r = await execFileAsync(ffmpegPath, ['-encoders'], {
        timeout: DETECT_TIMEOUT_MS,
      });
      nvenc = r.stdout.includes('h264_nvenc');
    } catch {
      // không có encoders
    }

    // Kiểm nvdec
    let nvdec = false;
    try {
      const r = await execFileAsync(ffmpegPath, ['-hwaccels'], {
        timeout: DETECT_TIMEOUT_MS,
      });
      nvdec = r.stdout.toLowerCase().includes('cuda');
    } catch {
      // không có hwaccels
    }

    return { version, nvenc, nvdec };
  } catch {
    return { version: null, nvenc: false, nvdec: false };
  }
}

// ---- Ollama ----

async function detectOllamaModels(ollamaUrl = 'http://localhost:11434'): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DETECT_TIMEOUT_MS);
    try {
      const res = await fetch(`${ollamaUrl}/api/tags`, { signal: controller.signal });
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: Array<{ name?: string }> };
      return (data.models ?? []).map((m) => m.name ?? '').filter(Boolean);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return [];
  }
}

// ---- Python / torch ----

export type PythonExec = (file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;

const PYTHON_TORCH_PROBE = ['-c', 'import torch,sys;print(sys.version.split()[0])'];
/** Một lần import torch nguội (lúc máy vừa bật, ổ chậm) mất hơn 8 s của các phép dò khác. */
const PYTHON_DETECT_TIMEOUT_MS = 30_000;

/**
 * Phiên bản Python của máy nếu nó import được torch. Có `pythonBin` thì chỉ dò đúng file đó (venv của handler),
 * không lùi về PATH: máy khai `python` phải là máy chạy được chính interpreter mà handler sẽ dùng.
 * Không có thì thử `python` rồi `python3` trên PATH.
 */
export async function detectPython(pythonBin?: string, exec: PythonExec = execFileAsync): Promise<string | null> {
  const candidates = pythonBin ? [pythonBin] : ['python', 'python3'];
  for (const file of candidates) {
    try {
      const { stdout } = await exec(file, PYTHON_TORCH_PROBE, { timeout: PYTHON_DETECT_TIMEOUT_MS });
      const version = String(stdout).trim();
      if (version) return version;
    } catch {
      // thử interpreter kế tiếp
    }
  }
  return null;
}

// ---- yt-dlp ----

/** yt-dlp cài bằng pip là một exe gọi Python: lần chạy nguội chậm hơn ffmpeg. */
const YTDLP_DETECT_TIMEOUT_MS = 20_000;

/** Phiên bản yt-dlp (`yt-dlp --version`, vd `2026.08.19`) của đúng file `ytdlpBin`, hoặc `null`. */
export async function detectYtdlp(ytdlpBin: string, exec: PythonExec = execFileAsync): Promise<string | null> {
  try {
    const { stdout } = await exec(ytdlpBin, ['--version'], { timeout: YTDLP_DETECT_TIMEOUT_MS });
    const version = String(stdout).trim().split(/\r?\n/)[0]?.trim();
    return version ? version.slice(0, 100) : null;
  } catch {
    return null;
  }
}

// ---- Public API ----

export interface CapabilitiesOptions {
  /**
   * ffmpeg worker thật sự dùng (vd bản `ffmpeg-static` kèm trong gói). Không có thì dò `ffmpeg` trên PATH, thường
   * không có trên máy worker (máy sẽ khai `ffmpeg: null`, NVENC false).
   */
  ffmpegPath?: string;
  ollamaUrl?: string;
  /** Nếu false thì bỏ qua Python/torch (mặc định false). */
  detectPythonTorch?: boolean;
  /** Interpreter handler sẽ chạy (vd `extra.python_bin`); không có thì dò `python`/`python3` trên PATH. */
  pythonBin?: string;
  /**
   * yt-dlp worker sẽ chạy (đường dẫn, hoặc `yt-dlp` trên PATH). Có thì dò và khai `engines.ytdlp` khi chạy được;
   * không có thì không dò. Không tìm thấy thì không gửi trường này (hub cũ không biết nó).
   */
  ytdlpBin?: string;
}

export async function detectCapabilities(options: CapabilitiesOptions = {}): Promise<Capabilities> {
  const [gpus, ffmpegInfo, ollamaModels, python, ytdlp] = await Promise.all([
    detectGpus(),
    detectFfmpeg(options.ffmpegPath),
    detectOllamaModels(options.ollamaUrl),
    options.detectPythonTorch ? detectPython(options.pythonBin) : Promise.resolve<string | null>(null),
    options.ytdlpBin ? detectYtdlp(options.ytdlpBin) : Promise.resolve<string | null>(null),
  ]);

  // Cập nhật nvenc/nvdec cho từng GPU
  const gpusWithCodec: Capabilities['gpus'] = gpus.map((g) => ({
    ...g,
    nvenc: ffmpegInfo.nvenc,
    nvdec: ffmpegInfo.nvdec,
  }));

  return {
    os: detectOs(),
    cpu_cores: os.cpus().length,
    ram_mb: Math.floor(os.totalmem() / (1024 * 1024)),
    gpus: gpusWithCodec,
    engines: {
      ffmpeg: ffmpegInfo.version,
      ollama_models: ollamaModels,
      python,
      ...(ytdlp ? { ytdlp } : {}),
    },
  };
}
