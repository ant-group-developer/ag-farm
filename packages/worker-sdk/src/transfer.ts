/**
 * Tải và upload file qua URL ký.
 * downloadToFile: resume qua HTTP Range, retry transient, gọi refreshUrl() khi URL hết hạn.
 * uploadOutput: PUT đơn lẻ hoặc multipart tùy kích thước.
 * uploadJson: upload JSON nhỏ bằng PUT.
 */
import { createReadStream, createWriteStream, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  MULTIPART_PART_SIZE_BYTES,
  MULTIPART_THRESHOLD_BYTES,
} from '@ag-farm/protocol';
import type { SignClient } from './sign-client';

const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 500;

function isTransientError(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DownloadOptions {
  expectedSize?: number | null;
  signal?: AbortSignal;
  onProgress?: (downloaded: number, total: number | null) => void;
  /** Gọi khi URL hết hạn (403/400); trả về URL mới. */
  refreshUrl?: () => Promise<string>;
}

/**
 * Tải file về `dest`, hỗ trợ resume qua `.part` file.
 * Retry transient; gọi refreshUrl() khi 400/403 (URL hết hạn).
 */
export async function downloadToFile(
  url: string,
  dest: string,
  options: DownloadOptions = {},
): Promise<void> {
  const { signal, onProgress, refreshUrl } = options;
  const partPath = `${dest}.part`;

  await mkdir(dirname(dest), { recursive: true });

  let currentUrl = url;
  let attempt = 0;

  while (true) {
    let rangeStart = 0;
    if (existsSync(partPath)) {
      rangeStart = statSync(partPath).size;
    }

    const headers: Record<string, string> = {};
    if (rangeStart > 0) {
      headers['Range'] = `bytes=${rangeStart}-`;
    }

    let res: Response;
    try {
      res = await fetch(currentUrl, { headers, signal });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      attempt++;
      await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1));
      continue;
    }

    // URL hết hạn
    if ((res.status === 400 || res.status === 403) && refreshUrl) {
      currentUrl = await refreshUrl();
      attempt = 0;
      continue;
    }

    if (isTransientError(res.status)) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Download failed after ${MAX_RETRIES} retries: HTTP ${res.status}`);
      }
      attempt++;
      await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1));
      continue;
    }

    if (res.status === 416) {
      // Range not satisfiable: file đã tải xong
      if (existsSync(partPath)) renameSync(partPath, dest);
      return;
    }

    if (!res.ok) {
      throw new Error(`Download failed: HTTP ${res.status}`);
    }

    // Nếu server trả 200 (không hỗ trợ Range) thì ghi lại từ đầu
    const append = res.status === 206;
    if (!append) rangeStart = 0;

    const contentLength = res.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength, 10) + rangeStart : null;

    const ws = createWriteStream(partPath, { flags: append ? 'a' : 'w' });
    let downloaded = rangeStart;

    try {
      if (!res.body) throw new Error('No response body');
      const reader = res.body.getReader();
      await new Promise<void>((resolve, reject) => {
        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                ws.write(value);
                downloaded += value.length;
                onProgress?.(downloaded, total);
              }
            }
            ws.end();
            ws.once('finish', resolve);
            ws.once('error', reject);
          } catch (e) {
            ws.destroy(e as Error);
            reject(e);
          }
        };
        void pump();
      });

      renameSync(partPath, dest);
      return;
    } catch (err) {
      ws.destroy();
      // Transient → retry (giữ .part file để resume)
      if (attempt >= MAX_RETRIES) throw err;
      attempt++;
      await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1));
    }
  }
}

// ---- Upload ----

async function putFile(url: string, filePath: string, headers: Record<string, string>): Promise<void> {
  const stat = statSync(filePath);
  const stream = createReadStream(filePath);
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      ...headers,
      'Content-Length': String(stat.size),
    },
    body: stream as unknown as import('node:stream').Readable,
    // @ts-ignore duplex needed for Node 18+ streaming body
    duplex: 'half',
  } as RequestInit);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PUT failed: HTTP ${res.status} - ${text}`);
  }
}

async function readFilePart(filePath: string, offset: number, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const rs = createReadStream(filePath, { start: offset, end: offset + length - 1 });
    rs.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    rs.on('end', () => resolve(Buffer.concat(chunks)));
    rs.on('error', reject);
  });
}

export interface UploadOutputOptions {
  signal?: AbortSignal;
  onProgress?: (uploaded: number, total: number) => void;
}

/**
 * Upload file output:
 * - Nhỏ hơn MULTIPART_THRESHOLD_BYTES → PUT đơn lẻ
 * - Lớn hơn → multipart (mp_create, part URLs theo lô ≤100, PUT từng phần, mp_complete)
 * - mp_abort khi lỗi
 */
export async function uploadOutput(
  signClient: SignClient,
  localPath: string,
  outputPath: string,
  contentType: string,
  options: UploadOutputOptions = {},
): Promise<void> {
  const { onProgress } = options;
  const stat = statSync(localPath);
  const totalSize = stat.size;

  if (totalSize < MULTIPART_THRESHOLD_BYTES) {
    // Single PUT
    const { url, headers } = await signClient.putOutput(outputPath, contentType);
    await putFile(url, localPath, headers);
    onProgress?.(totalSize, totalSize);
    return;
  }

  // Multipart
  const createResults = await signClient.sign([
    { op: 'mp_create', output: outputPath, content_type: contentType },
  ]);
  const createResult = createResults[0];
  if (!createResult || createResult.op !== 'mp_create') {
    throw new Error('mp_create failed');
  }
  const uploadId = createResult.upload_id;

  const numParts = Math.ceil(totalSize / MULTIPART_PART_SIZE_BYTES);
  const etags: Array<{ part_number: number; etag: string }> = [];

  try {
    // Lấy URL từng lô ≤100 part
    const BATCH = 100;
    let partNumbers: number[] = [];
    for (let i = 1; i <= numParts; i++) partNumbers.push(i);

    let urlMap: Map<number, string> = new Map();
    for (let batchStart = 0; batchStart < partNumbers.length; batchStart += BATCH) {
      const batch = partNumbers.slice(batchStart, batchStart + BATCH);
      const urlResults = await signClient.sign([
        {
          op: 'mp_part_urls',
          output: outputPath,
          upload_id: uploadId,
          parts: batch,
        },
      ]);
      const urlResult = urlResults[0];
      if (!urlResult || urlResult.op !== 'mp_part_urls') {
        throw new Error('mp_part_urls failed');
      }
      for (const { part_number, url } of urlResult.urls) {
        urlMap.set(part_number, url);
      }
    }

    // Upload từng phần
    let uploaded = 0;
    for (let partNum = 1; partNum <= numParts; partNum++) {
      const offset = (partNum - 1) * MULTIPART_PART_SIZE_BYTES;
      const length = Math.min(MULTIPART_PART_SIZE_BYTES, totalSize - offset);
      const partData = await readFilePart(localPath, offset, length);
      const partUrl = urlMap.get(partNum);
      if (!partUrl) throw new Error(`No URL for part ${partNum}`);

      const res = await fetch(partUrl, {
        method: 'PUT',
        headers: { 'Content-Length': String(partData.length) },
        body: partData,
      });
      if (!res.ok) {
        throw new Error(`Part ${partNum} PUT failed: HTTP ${res.status}`);
      }
      const etag = res.headers.get('etag') ?? res.headers.get('ETag') ?? '';
      etags.push({ part_number: partNum, etag: etag.replace(/"/g, '') });

      uploaded += partData.length;
      onProgress?.(uploaded, totalSize);
    }

    // Complete
    await signClient.sign([
      {
        op: 'mp_complete',
        output: outputPath,
        upload_id: uploadId,
        parts: etags,
      },
    ]);
  } catch (err) {
    // Abort
    try {
      await signClient.sign([
        { op: 'mp_abort', output: outputPath, upload_id: uploadId },
      ]);
    } catch {
      // Ignore abort errors
    }
    throw err;
  }
}

/** Upload một object JSON nhỏ bằng PUT. */
export async function uploadJson(
  signClient: SignClient,
  outputPath: string,
  data: unknown,
): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  const { url, headers } = await signClient.putOutput(outputPath, 'application/json');

  const buf = Buffer.from(json, 'utf8');
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Length': String(buf.length) },
    body: buf,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Upload JSON failed: HTTP ${res.status} - ${text}`);
  }
}
