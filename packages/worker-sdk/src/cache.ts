/**
 * Cache file nguồn keyed theo cache_key (hash tên file).
 * getOrDownload: in-process + lock-file guard chống download song song cùng key.
 * LRU eviction: xoá file cũ nhất (theo mtime) khi vượt max_gb.
 * Touch mtime khi cache hit để duy trì LRU ordering.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { closeSync } from 'node:fs';
import { join } from 'node:path';

const GB = 1024 * 1024 * 1024;

export class Cache {
  /** In-process guard: cache_key → Promise đang tải */
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly cacheDir: string,
    private readonly maxGb: number,
  ) {
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(join(cacheDir, 'locks'), { recursive: true });
  }

  /**
   * Trả về đường dẫn file cache (sẵn có hoặc vừa tải về).
   * `fetcher`: async function nhận dest path và download file vào đó.
   * Nếu hai call cùng key chạy song song thì call sau chờ call đầu xong.
   */
  async getOrDownload(
    cacheKey: string,
    _sizeHint: number | null,
    fetcher: (dest: string) => Promise<void>,
  ): Promise<string> {
    const safeName = this.keyToFilename(cacheKey);
    const filePath = join(this.cacheDir, safeName);

    // Hit: touch mtime để LRU biết dùng gần đây
    if (existsSync(filePath)) {
      this.touchMtime(filePath);
      return filePath;
    }

    // In-process guard
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const p = this.downloadWithLock(cacheKey, filePath, fetcher);
    this.inFlight.set(cacheKey, p);
    try {
      return await p;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  // ---- private ----

  private async downloadWithLock(
    cacheKey: string,
    filePath: string,
    fetcher: (dest: string) => Promise<void>,
  ): Promise<string> {
    const lockPath = join(this.cacheDir, 'locks', `${this.keyToFilename(cacheKey)}.lock`);

    // Lock file chống multi-process
    let lockAcquired = false;
    let waitMs = 100;
    const maxWaitMs = 30_000;
    const deadline = Date.now() + maxWaitMs;

    while (!lockAcquired && Date.now() < deadline) {
      try {
        const fd = openSync(lockPath, 'wx');
        writeFileSync(lockPath, String(process.pid));
        try { closeSync(fd); } catch { /* ignore */ }
        lockAcquired = true;
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') {
          // Kiểm xem file cache đã có chưa (lock từ process khác download xong)
          if (existsSync(filePath)) {
            this.touchMtime(filePath);
            return filePath;
          }
          await sleep(waitMs);
          waitMs = Math.min(waitMs * 2, 2000);
        } else {
          throw e;
        }
      }
    }

    // Kiểm lại sau khi có lock
    if (existsSync(filePath)) {
      if (lockAcquired) this.releaseLock(lockPath);
      this.touchMtime(filePath);
      return filePath;
    }

    try {
      const tmpPath = `${filePath}.tmp`;
      await fetcher(tmpPath);
      renameSync(tmpPath, filePath);

      // Eviction
      await this.evict();
      return filePath;
    } finally {
      if (lockAcquired) this.releaseLock(lockPath);
    }
  }

  private releaseLock(lockPath: string): void {
    try {
      unlinkSync(lockPath);
    } catch {
      // Ignore
    }
  }

  private keyToFilename(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  private touchMtime(filePath: string): void {
    try {
      const now = new Date();
      utimesSync(filePath, now, now);
    } catch {
      // ignore
    }
  }

  private async evict(): Promise<void> {
    const entries = readdirSync(this.cacheDir)
      .filter((name) => !name.endsWith('.lock') && !name.endsWith('.tmp'))
      .map((name) => {
        const p = join(this.cacheDir, name);
        try {
          const s = statSync(p);
          return { path: p, size: s.size, mtime: s.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((e): e is { path: string; size: number; mtime: number } => e !== null);

    let totalBytes = entries.reduce((s, e) => s + e.size, 0);
    const maxBytes = this.maxGb * GB;

    if (totalBytes <= maxBytes) return;

    // Sort by mtime ascending (LRU first)
    entries.sort((a, b) => a.mtime - b.mtime);

    for (const entry of entries) {
      if (totalBytes <= maxBytes) break;
      try {
        unlinkSync(entry.path);
        totalBytes -= entry.size;
      } catch {
        // ignore
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

