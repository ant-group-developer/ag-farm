import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FarmJobEntity } from '../../database/entities/farm-job.entity';
import { MachinesModule } from '../machines/machines.module';
import { ReaperService } from './reaper.service';

@Module({
  imports: [TypeOrmModule.forFeature([FarmJobEntity]), MachinesModule],
  providers: [ReaperService],
  exports: [ReaperService],
})
export class ReaperModule {}
