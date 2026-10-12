import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ACCOUNT_ME_CLIENT, AccountMeClientImpl, AdminGuard } from '../../auth/admin.guard';
import { ReleasesController } from './releases.controller';
import { ReleasesService } from './releases.service';

@Module({
  imports: [ConfigModule],
  controllers: [ReleasesController],
  providers: [
    ReleasesService,
    AccountMeClientImpl,
    { provide: ACCOUNT_ME_CLIENT, useExisting: AccountMeClientImpl },
    AdminGuard,
  ],
  exports: [ReleasesService],
})
export class ReleasesModule {}
