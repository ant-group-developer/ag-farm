import { Body, Controller, Get, HttpCode, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { rm } from 'node:fs/promises';
import { AdminGuard } from '../../auth/admin.guard';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ReleaseUploadGuard } from './release-upload.guard';
import { PublishReleaseSchema, ReleasesService } from './releases.service';
import type { UploadedZip } from './releases.service';

@Controller('v1/admin/releases')
export class ReleasesController {
  constructor(private readonly svc: ReleasesService) {}

  /** Bản mới nhất của từng gói worker (trang Máy so với phiên bản máy đang chạy). */
  @UseGuards(AdminGuard)
  @Get('latest')
  async latest() {
    return this.svc.latest();
  }

  /**
   * Phát hành một gói worker (`release.mjs --publish --upload <hub>`): multipart `file` (zip) + `package`, `version`,
   * `sha256` (của zip), tuỳ chọn `built_at`. Từ chối bản không mới hơn bản đang có (409 `version_not_newer`), sha256
   * không khớp (400 `sha256_mismatch`), file quá `FARM_RELEASE_MAX_MB` (413). Máy worker thấy bản mới ở lần kiểm kế tiếp.
   */
  @UseGuards(ReleaseUploadGuard)
  @UseInterceptors(FileInterceptor('file'))
  @Post()
  @HttpCode(201)
  async publish(@UploadedFile() file: UploadedZip | undefined, @Body() body: unknown) {
    let dto;
    try {
      dto = new ZodValidationPipe(PublishReleaseSchema).transform(body);
    } catch (err) {
      if (file) await rm(file.path, { force: true });
      throw err;
    }
    return this.svc.publish(dto, file);
  }
}
