import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

type Done = (err: Error | null, info?: { path: string; size: number }) => void;

/**
 * Nơi multer ghi gói đang tải lên (giao diện `StorageEngine` của multer): file `.zip.part` tên ngẫu nhiên trong
 * `dirOf()`, tạo thư mục lúc có file đầu tiên (không phải lúc hub khởi động: thư mục phát hành chỉ đọc không làm hub
 * chết). Multer gọi `_removeFile` khi upload hỏng giữa chừng (quá dung lượng, mất kết nối).
 */
export class IncomingZipStorage {
  constructor(private readonly dirOf: () => string) {}

  _handleFile(_req: unknown, file: { stream: Readable }, cb: Done): void {
    const dir = this.dirOf();
    mkdir(dir, { recursive: true }).then(
      () => {
        const path = join(dir, `${randomBytes(8).toString('hex')}.zip.part`);
        const out = createWriteStream(path);
        let size = 0;
        file.stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
        });
        out.on('error', (err) => cb(err));
        out.on('finish', () => cb(null, { path, size }));
        file.stream.pipe(out);
      },
      (err: Error) => cb(err),
    );
  }

  _removeFile(_req: unknown, file: { path?: string }, cb: (err: Error | null) => void): void {
    if (!file.path) {
      cb(null);
      return;
    }
    rm(file.path, { force: true }).then(
      () => cb(null),
      (err: Error) => cb(err),
    );
  }
}
