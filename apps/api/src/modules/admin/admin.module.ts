import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FarmJobEntity } from '../../database/entities/farm-job.entity';
import { FarmNodeEntity } from '../../database/entities/farm-node.entity';
import { FarmOwnerEntity } from '../../database/entities/farm-owner.entity';
import { ACCOUNT_ME_CLIENT, AccountMeClientImpl, AdminGuard } from '../../auth/admin.guard';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { EnrollModule } from '../enroll/enroll.module';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([FarmNodeEntity, FarmJobEntity, FarmOwnerEntity]),
    EnrollModule,
  ],
  controllers: [AdminController],
  providers: [
    AdminService,
    AccountMeClientImpl,
    { provide: ACCOUNT_ME_CLIENT, useExisting: AccountMeClientImpl },
    AdminGuard,
  ],
})
export class AdminModule {}
