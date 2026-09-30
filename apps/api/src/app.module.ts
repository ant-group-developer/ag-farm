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
import { EnrollModule } from './modules/enroll/enroll.module';
import { HealthController } from './health.controller';
import { AdminModule } from './modules/admin/admin.module';
import { OwnerModule } from './modules/owner/owner.module';
import { ReaperModule } from './modules/reaper/reaper.module';
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
        migrations: [Initial1000000000000, Enrollments1100000000000, JobPause1200000000000],
        migrationsRun: false,
        synchronize: false,
      }),
    }),
    WorkerModule,
    OwnerModule,
    AdminModule,
    ReaperModule,
    EnrollModule,
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
