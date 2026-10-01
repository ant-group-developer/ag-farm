import { config as loadEnv } from 'dotenv';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { FarmJobEntity } from './entities/farm-job.entity';
import { FarmNodeEntity } from './entities/farm-node.entity';
import { FarmOwnerEntity } from './entities/farm-owner.entity';
import { FarmEnrollmentEntity } from './entities/farm-enrollment.entity';
import { Initial1000000000000 } from './migrations/1000000000000-initial';
import { Enrollments1100000000000 } from './migrations/1100000000000-enrollments';
import { JobPause1200000000000 } from './migrations/1200000000000-job-pause';
import { AdminListIndexes1300000000000 } from './migrations/1300000000000-admin-list-indexes';
import { StudioExportPremiere1400000000000 } from './migrations/1400000000000-studio-export-premiere';
import { DropOwnerDefaultLane1500000000000 } from './migrations/1500000000000-drop-owner-default-lane';

loadEnv();

const url = process.env['DATABASE_URL'];
if (!url) {
  throw new Error('DATABASE_URL is required');
}

export const AppDataSource = new DataSource({
  type: 'postgres',
  url,
  poolSize: Number(process.env['DATABASE_POOL_MAX'] ?? 10),
  connectTimeoutMS: 10_000,
  entities: [FarmOwnerEntity, FarmNodeEntity, FarmJobEntity, FarmEnrollmentEntity],
  migrations: [Initial1000000000000, Enrollments1100000000000, JobPause1200000000000, AdminListIndexes1300000000000, StudioExportPremiere1400000000000, DropOwnerDefaultLane1500000000000],
  synchronize: false,
});
