import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FarmJobEntity } from '../../database/entities/farm-job.entity';
import { FarmNodeEntity } from '../../database/entities/farm-node.entity';
import { FarmOwnerEntity } from '../../database/entities/farm-owner.entity';
import { NodeTokenGuard } from '../../auth/node-token.guard';
import { MachinesModule } from '../machines/machines.module';
import { WorkerController } from './worker.controller';
import { WorkerService } from './worker.service';

@Module({
  imports: [TypeOrmModule.forFeature([FarmNodeEntity, FarmJobEntity, FarmOwnerEntity]), MachinesModule],
  controllers: [WorkerController],
  providers: [WorkerService, NodeTokenGuard],
})
export class WorkerModule {}
