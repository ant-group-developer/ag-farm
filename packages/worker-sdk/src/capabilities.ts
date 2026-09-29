/**
 * Tự dò năng lực của máy: os/cpu/ram, GPU qua nvidia-smi,
 * ffmpeg, Ollama models, Python+torch.
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

async function detectPython(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'python',
      ['-c', 'import torch,sys;print(sys.version.split()[0])'],
      { timeout: DETECT_TIMEOUT_MS },
    );
    return stdout.trim() || null;
  } catch {
    try {
      const { stdout } = await execFileAsync(
        'python3',
        ['-c', 'import torch,sys;print(sys.version.split()[0])'],
        { timeout: DETECT_TIMEOUT_MS },
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
}

// ---- Public API ----

export interface CapabilitiesOptions {
  ffmpegPath?: string;
  ollamaUrl?: string;
  /** Nếu false thì bỏ qua Python/torch (mặc định false). */
  detectPythonTorch?: boolean;
}

export async function detectCapabilities(options: CapabilitiesOptions = {}): Promise<Capabilities> {
  const [gpus, ffmpegInfo, ollamaModels, python] = await Promise.all([
    detectGpus(),
    detectFfmpeg(options.ffmpegPath),
    detectOllamaModels(options.ollamaUrl),
    options.detectPythonTorch ? detectPython() : Promise.resolve<string | null>(null),
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
    },
  };
}
