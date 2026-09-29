/**
 * Tạo hoặc cập nhật chủ job và in khoá một lần.
 * Chạy: OWNER_ID=ag-go OWNER_SIGN_URL=https://... yarn workspace @ag-farm/api owner:key
 */
import 'dotenv/config';
import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { FarmOwnerEntity } from '../database/entities/farm-owner.entity';
import { FarmJobEntity } from '../database/entities/farm-job.entity';
import { FarmNodeEntity } from '../database/entities/farm-node.entity';
import { Initial1000000000000 } from '../database/migrations/1000000000000-initial';

async function main() {
  const ownerId = process.env['OWNER_ID'];
  const signUrl = process.env['OWNER_SIGN_URL'];
  const allowedTypes = (process.env['OWNER_ALLOWED_TYPES'] ?? '').split(',').filter(Boolean);
  const defaultLane = (process.env['OWNER_DEFAULT_LANE'] ?? 'batch') as 'interactive' | 'batch';

  if (!ownerId || !signUrl) {
    console.error('Usage: OWNER_ID=ag-go OWNER_SIGN_URL=https://... yarn workspace @ag-farm/api owner:key');
    process.exit(1);
  }

  const ds = new DataSource({
    type: 'postgres',
    url: process.env['DATABASE_URL']!,
    entities: [FarmOwnerEntity, FarmNodeEntity, FarmJobEntity],
    migrations: [Initial1000000000000],
    synchronize: false,
  });
  await ds.initialize();

  const key = randomBytes(32).toString('base64url');
  const keyHash = createHash('sha256').update(key).digest('hex');

  const repo = ds.getRepository(FarmOwnerEntity);
  await repo.upsert(
    {
      id: ownerId,
      keyHash,
      signUrl,
      allowedTypes: allowedTypes.length > 0 ? allowedTypes : ['scan.extract', 'scan.ai'],
      defaultLane,
    },
    ['id'],
  );

  console.log(`\nOwner "${ownerId}" upserted.`);
  console.log(`\nKhoá owner (chỉ hiện một lần):\n${key}`);
  console.log(`\nDán vào .env của ag-go-api:\nFARM_OWNER_KEY="${key}"`);

  await ds.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
