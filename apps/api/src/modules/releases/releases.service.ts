import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ROLE_PACKAGES, ReleaseEntrySchema, ReleaseVersionSchema, compareVersions } from '@ag-farm/protocol';
import type { ReleaseEntry, ReleaseManifest } from '@ag-farm/protocol';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { releasesDir } from '../../config/releases-dir';

/** Gói được phát hành qua API: đúng các gói installer cài cho từng vai trò. */
export const RELEASE_PACKAGES = Object.values(ROLE_PACKAGES) as [string, ...string[]];

/** Trường đi kèm file zip trong `POST /v1/admin/releases` (multipart). */
export const PublishReleaseSchema = z.strictObject({
  package: z.enum(RELEASE_PACKAGES),
  version: ReleaseVersionSchema,
  sha256: z
    .string()
    .trim()
    .transform((s) => s.toLowerCase())
    .pipe(z.string().regex(/^[0-9a-f]{64}$/, { message: 'sha256 must be 64 hex characters' })),
  built_at: z.iso.datetime({ offset: true }).optional(),
});
export type PublishReleaseDto = z.infer<typeof PublishReleaseSchema>;

/** File multer vừa ghi tạm (`diskStorage`). */
export interface UploadedZip {
  path: string;
  size: number;
  originalname?: string;
}

/** Thư mục tạm cho file đang tải lên: cùng ổ với thư mục phát hành nên đổi tên là tức thì và nguyên vẹn. */
export const INCOMING_DIR = '.incoming';

/** Gói phát hành worker trong `FARM_RELEASES_DIR` (`latest.json` + zip), cái mà `/dist/` phục vụ cho máy worker. */
@Injectable()
export class ReleasesService {
  /** Các lần phát hành chạy lần lượt: hai lần cùng lúc không ghi đè latest.json của nhau. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: ConfigService) {}

  dir(): string {
    return releasesDir(this.config.get<string>('FARM_RELEASES_DIR'));
  }

  /** `latest.json` hiện tại: chưa có file thì rỗng; mục hỏng (tay sửa sai) bị bỏ thay vì làm hỏng cả trang Máy. */
  async latest(): Promise<ReleaseManifest> {
    const raw = await this.readRaw();
    const packages: ReleaseManifest['packages'] = {};
    for (const [name, entry] of Object.entries(raw.packages ?? {})) {
      const parsed = ReleaseEntrySchema.safeParse(entry);
      if (parsed.success) packages[name] = parsed.data;
    }
    return { packages };
  }

  /**
   * Nhận một gói đã tải lên: kiểm sha256, chỉ nhận bản mới hơn bản đang có của gói đó, đặt zip vào thư mục phát hành
   * (`<package>-<version>.zip`) rồi ghi latest.json (file tạm + đổi tên, máy worker không bao giờ đọc nửa file). Các
   * gói khác và khoá lạ trong latest.json giữ nguyên. File tạm luôn bị xoá.
   */
  async publish(dto: PublishReleaseDto, file: UploadedZip | undefined): Promise<ReleaseEntry> {
    try {
      if (!file) throw new BadRequestException({ code: 'file_required', message: 'Attach the release zip as "file"' });
      const actual = await sha256File(file.path);
      if (actual !== dto.sha256) {
        throw new BadRequestException({
          code: 'sha256_mismatch',
          message: `The uploaded file's sha256 is ${actual}, not ${dto.sha256}: the upload broke or the wrong file was sent`,
        });
      }
      return await this.serial(async () => {
        const raw = await this.readRaw();
        const current = ReleaseEntrySchema.safeParse(raw.packages?.[dto.package]);
        if (current.success && compareVersions(dto.version, current.data.version) <= 0) {
          throw new ConflictException({
            code: 'version_not_newer',
            message: `${dto.package} ${dto.version} is not newer than the published ${current.data.version}`,
            details: { current: current.data.version },
          });
        }
        const entry: ReleaseEntry = {
          version: dto.version,
          file: `${dto.package}-${dto.version}.zip`,
          sha256: actual,
          size_bytes: file.size,
          built_at: dto.built_at ?? new Date().toISOString(),
        };
        const dir = this.dir();
        await rename(file.path, join(dir, entry.file));
        const next = { ...raw, packages: { ...(raw.packages ?? {}), [dto.package]: entry } };
        const tmp = join(dir, `latest.json.${randomBytes(4).toString('hex')}.tmp`);
        await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
        await rename(tmp, join(dir, 'latest.json'));
        return entry;
      });
    } finally {
      if (file) await rm(file.path, { force: true });
    }
  }

  private async readRaw(): Promise<{ packages?: Record<string, unknown>; [key: string]: unknown }> {
    let text: string;
    try {
      text = await readFile(join(this.dir(), 'latest.json'), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { packages: {} };
      throw err;
    }
    const raw = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { packages?: Record<string, unknown> })
      : { packages: {} };
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}
