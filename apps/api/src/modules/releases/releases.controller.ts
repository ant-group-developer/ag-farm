import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../../auth/admin.guard';
import { ReleasesService } from './releases.service';

@Controller('v1/admin/releases')
export class ReleasesController {
  constructor(private readonly svc: ReleasesService) {}

  /** Bản mới nhất của từng gói worker (trang Máy so với phiên bản máy đang chạy). */
  @UseGuards(AdminGuard)
  @Get('latest')
  async latest() {
    return this.svc.latest();
  }
}
