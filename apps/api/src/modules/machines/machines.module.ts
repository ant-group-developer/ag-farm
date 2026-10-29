import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MachineMetricsService } from './machine-metrics.service';
import { NodeLogsService } from './node-logs.service';

@Module({
  imports: [ConfigModule],
  providers: [MachineMetricsService, NodeLogsService],
  exports: [MachineMetricsService, NodeLogsService],
})
export class MachinesModule {}
