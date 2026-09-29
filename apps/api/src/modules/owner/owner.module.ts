import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FarmJobEntity } from '../../database/entities/farm-job.entity';
import { FarmOwnerEntity } from '../../database/entities/farm-owner.entity';
import { OwnerKeyGuard } from '../../auth/owner-key.guard';
import { OwnerController } from './owner.controller';
import { OwnerService } from './owner.service';

@Module({
  imports: [TypeOrmModule.forFeature([FarmJobEntity, FarmOwnerEntity])],
  controllers: [OwnerController],
  providers: [OwnerService, OwnerKeyGuard],
})
export class OwnerModule {}
