import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AdminGuard } from '../../auth/admin.guard';

/**
 * Phát hành gói worker: `Authorization: Release <FARM_RELEASE_KEY>` (script `release.mjs --upload` ở máy build), hoặc
 * admin đăng nhập như mọi API admin (`Bearer` Auth0). Hub không đặt `FARM_RELEASE_KEY` thì chỉ cách thứ hai.
 */
@Injectable()
export class ReleaseUploadGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly admin: AdminGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const [scheme, token] = (request.header('authorization') ?? '').trim().split(/\s+/, 2);
    if (scheme?.toLowerCase() === 'release') {
      const key = this.config.get<string>('FARM_RELEASE_KEY');
      if (key && token && sameSecret(token, key)) return true;
      throw new UnauthorizedException('Invalid release key');
    }
    return this.admin.canActivate(context);
  }
}

/** So hai bí mật không lộ độ dài/vị trí khác nhau qua thời gian chạy. */
function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
