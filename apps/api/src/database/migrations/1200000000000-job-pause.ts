import { MigrationInterface, QueryRunner } from 'typeorm';

/** Tạm dừng job (`paused`) và nhóm job (`group_key`, ví dụ một đợt quét) để dừng / chạy tiếp / huỷ cả loạt. */
export class JobPause1200000000000 implements MigrationInterface {
  name = 'JobPause1200000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE farm_jobs DROP CONSTRAINT IF EXISTS farm_jobs_status_check`);
    await queryRunner.query(`
      ALTER TABLE farm_jobs ADD CONSTRAINT farm_jobs_status_check
        CHECK (status IN ('queued','leased','paused','completed','failed','cancelled'))
    `);
    await queryRunner.query(`ALTER TABLE farm_jobs ADD COLUMN group_key text`);
    await queryRunner.query(
      `CREATE INDEX farm_jobs_owner_group_idx ON farm_jobs (owner, group_key) WHERE group_key IS NOT NULL`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE farm_jobs SET status = 'queued' WHERE status = 'paused'`);
    await queryRunner.query(`DROP INDEX IF EXISTS farm_jobs_owner_group_idx`);
    await queryRunner.query(`ALTER TABLE farm_jobs DROP COLUMN IF EXISTS group_key`);
    await queryRunner.query(`ALTER TABLE farm_jobs DROP CONSTRAINT IF EXISTS farm_jobs_status_check`);
    await queryRunner.query(`
      ALTER TABLE farm_jobs ADD CONSTRAINT farm_jobs_status_check
        CHECK (status IN ('queued','leased','completed','failed','cancelled'))
    `);
  }
}
