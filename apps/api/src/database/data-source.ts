import { config as loadEnv } from 'dotenv';
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { FarmJobEntity } from './entities/farm-job.entity';
import { FarmNodeEntity } from './entities/farm-node.entity';
import { FarmOwnerEntity } from './entities/farm-owner.entity';
import { Initial1000000000000 } from './migrations/1000000000000-initial';

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
  entities: [FarmOwnerEntity, FarmNodeEntity, FarmJobEntity],
  migrations: [Initial1000000000000],
  synchronize: false,
});
