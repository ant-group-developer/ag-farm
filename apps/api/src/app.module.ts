import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { validateEnv } from './config/env';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { ApiResponseInterceptor } from './common/api-response.interceptor';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { FarmJobEntity } from './database/entities/farm-job.entity';
import { FarmNodeEntity } from './database/entities/farm-node.entity';
import { FarmOwnerEntity } from './database/entities/farm-owner.entity';
import { FarmEnrollmentEntity } from './database/entities/farm-enrollment.entity';
import { Initial1000000000000 } from './database/migrations/1000000000000-initial';
import { Enrollments1100000000000 } from './database/migrations/1100000000000-enrollments';
import { JobPause1200000000000 } from './database/migrations/1200000000000-job-pause';
import { AdminListIndexes1300000000000 } from './database/migrations/1300000000000-admin-list-indexes';
import { StudioExportPremiere1400000000000 } from './database/migrations/1400000000000-studio-export-premiere';
import { DropOwnerDefaultLane1500000000000 } from './database/migrations/1500000000000-drop-owner-default-lane';
import { StudioTranscribe1600000000000 } from './database/migrations/1600000000000-studio-transcribe';
import { StatsFinishedIndex1700000000000 } from './database/migrations/1700000000000-stats-finished-index';
import { NodePriorityOrder1800000000000 } from './database/migrations/1800000000000-node-priority-order';
import { NodeBlockedKinds1900000000000 } from './database/migrations/1900000000000-node-blocked-kinds';
import { NodeSelfUpdate2000000000000 } from './database/migrations/2000000000000-node-self-update';
import { MachineMetrics2100000000000 } from './database/migrations/2100000000000-machine-metrics';
import { StudioReferenceFetch2200000000000 } from './database/migrations/2200000000000-studio-reference-fetch';
import { AgGoPrep2300000000000 } from './database/migrations/2300000000000-ag-go-prep';
import { StudioBeats2400000000000 } from './database/migrations/2400000000000-studio-beats';
import { NodeLogs2500000000000 } from './database/migrations/2500000000000-node-logs';
import { OwnerWebUrl2600000000000 } from './database/migrations/2600000000000-owner-web-url';
import { NodePool2700000000000 } from './database/migrations/2700000000000-node-pool';
import { EnrollModule } from './modules/enroll/enroll.module';
import { HealthController } from './health.controller';
import { AdminModule } from './modules/admin/admin.module';
import { OwnerModule } from './modules/owner/owner.module';
import { ReaperModule } from './modules/reaper/reaper.module';
import { ReleasesModule } from './modules/releases/releases.module';
import { WorkerModule } from './modules/worker/worker.module';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      validate: (config) => validateEnv(config as NodeJS.ProcessEnv),
      isGlobal: true,
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.getOrThrow<string>('DATABASE_URL'),
        poolSize: config.get<number>('DATABASE_POOL_MAX') ?? 10,
        connectTimeoutMS: 10_000,
        entities: [FarmOwnerEntity, FarmNodeEntity, FarmJobEntity, FarmEnrollmentEntity],
        migrations: [Initial1000000000000, Enrollments1100000000000, JobPause1200000000000, AdminListIndexes1300000000000, StudioExportPremiere1400000000000, DropOwnerDefaultLane1500000000000, StudioTranscribe1600000000000, StatsFinishedIndex1700000000000, NodePriorityOrder1800000000000, NodeBlockedKinds1900000000000, NodeSelfUpdate2000000000000, MachineMetrics2100000000000, StudioReferenceFetch2200000000000, AgGoPrep2300000000000, StudioBeats2400000000000, NodeLogs2500000000000, OwnerWebUrl2600000000000, NodePool2700000000000],
        migrationsRun: false,
        synchronize: false,
      }),
    }),
    WorkerModule,
    OwnerModule,
    AdminModule,
    ReaperModule,
    EnrollModule,
    ReleasesModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ApiResponseInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
