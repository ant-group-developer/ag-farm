import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MachineMetricsService } from './machine-metrics.service';

@Module({
  imports: [ConfigModule],
  providers: [MachineMetricsService],
  exports: [MachineMetricsService],
})
export class MachinesModule {}
