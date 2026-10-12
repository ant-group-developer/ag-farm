import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReleaseEntrySchema } from '@ag-farm/protocol';
import type { ReleaseManifest } from '@ag-farm/protocol';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { releasesDir } from '../../config/releases-dir';

/** Gói phát hành worker trong `FARM_RELEASES_DIR` (`latest.json` + zip), cái mà `/dist/` phục vụ cho máy worker. */
@Injectable()
export class ReleasesService {
  constructor(private readonly config: ConfigService) {}

  dir(): string {
    return releasesDir(this.config.get<string>('FARM_RELEASES_DIR'));
  }

  /** `latest.json` hiện tại: chưa có file thì rỗng; mục hỏng (tay sửa sai) bị bỏ thay vì làm hỏng cả trang Máy. */
  async latest(): Promise<ReleaseManifest> {
    let text: string;
    try {
      text = await readFile(join(this.dir(), 'latest.json'), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { packages: {} };
      throw err;
    }
    const raw = JSON.parse(text.replace(/^﻿/, '')) as { packages?: Record<string, unknown> };
    const packages: ReleaseManifest['packages'] = {};
    for (const [name, entry] of Object.entries(raw?.packages ?? {})) {
      const parsed = ReleaseEntrySchema.safeParse(entry);
      if (parsed.success) packages[name] = parsed.data;
    }
    return { packages };
  }
}
