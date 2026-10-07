import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FarmJobEntity } from '../../database/entities/farm-job.entity';
import { FarmNodeEntity } from '../../database/entities/farm-node.entity';
import { FarmOwnerEntity } from '../../database/entities/farm-owner.entity';
import { OwnerKeyGuard } from '../../auth/owner-key.guard';
import { OwnerController } from './owner.controller';
import { OwnerService } from './owner.service';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([FarmJobEntity, FarmOwnerEntity, FarmNodeEntity])],
  controllers: [OwnerController],
  providers: [OwnerService, OwnerKeyGuard],
})
export class OwnerModule {}
