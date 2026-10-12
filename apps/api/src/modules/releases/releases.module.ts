import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { join } from 'node:path';
import { ACCOUNT_ME_CLIENT, AccountMeClientImpl, AdminGuard } from '../../auth/admin.guard';
import { releasesDir } from '../../config/releases-dir';
import { IncomingZipStorage } from './incoming-storage';
import { ReleaseUploadGuard } from './release-upload.guard';
import { ReleasesController } from './releases.controller';
import { INCOMING_DIR, ReleasesService } from './releases.service';

@Module({
  imports: [
    ConfigModule,
    // Gói tải lên ghi thẳng ra đĩa (cạnh thư mục phát hành: đổi tên là xong), không giữ trong RAM.
    MulterModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        storage: new IncomingZipStorage(() => join(releasesDir(config.get<string>('FARM_RELEASES_DIR')), INCOMING_DIR)),
        limits: {
          fileSize: Number(config.get('FARM_RELEASE_MAX_MB') ?? 1024) * 1024 * 1024,
          files: 1,
          fields: 10,
          fieldSize: 1024,
        },
      }),
    }),
  ],
  controllers: [ReleasesController],
  providers: [
    ReleasesService,
    AccountMeClientImpl,
    { provide: ACCOUNT_ME_CLIENT, useExisting: AccountMeClientImpl },
    AdminGuard,
    ReleaseUploadGuard,
  ],
  exports: [ReleasesService],
})
export class ReleasesModule {}
