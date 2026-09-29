import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { validateEnv } from './config/env';
import { FarmJobEntity } from './database/entities/farm-job.entity';
import { FarmNodeEntity } from './database/entities/farm-node.entity';
import { FarmOwnerEntity } from './database/entities/farm-owner.entity';
import { Initial1000000000000 } from './database/migrations/1000000000000-initial';
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
        entities: [FarmOwnerEntity, FarmNodeEntity, FarmJobEntity],
        migrations: [Initial1000000000000],
        migrationsRun: false,
        synchronize: false,
      }),
    }),
    WorkerModule,
    OwnerModule,
    AdminModule,
    ReaperModule,
  ],
})
export class AppModule {}
