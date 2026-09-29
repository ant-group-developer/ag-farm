import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FarmJobEntity } from '../../database/entities/farm-job.entity';
import { ReaperService } from './reaper.service';

@Module({
  imports: [TypeOrmModule.forFeature([FarmJobEntity])],
  providers: [ReaperService],
  exports: [ReaperService],
})
export class ReaperModule {}
