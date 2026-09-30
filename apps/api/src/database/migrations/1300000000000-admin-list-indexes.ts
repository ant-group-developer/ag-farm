import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GĐ4: phân trang theo trang cho admin list endpoints.
 * - Cột `allowed_kinds` trên `farm_nodes`: admin chỉ định loại job được phép (null = tất cả kinds báo cáo).
 * - Index hỗ trợ phân trang và lọc trên `farm_jobs`.
 */
export class AdminListIndexes1300000000000 implements MigrationInterface {
  name = 'AdminListIndexes1300000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Cột allowed_kinds trên farm_nodes
    await queryRunner.query(
      `ALTER TABLE farm_nodes ADD COLUMN IF NOT EXISTS allowed_kinds text[] DEFAULT NULL`,
    );

    // Index hỗ trợ ORDER BY created_at DESC (truy vấn mặc định)
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS farm_jobs_created_at_idx ON farm_jobs (created_at DESC)`,
    );

    // Lọc theo status + phân trang
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS farm_jobs_status_created_idx ON farm_jobs (status, created_at DESC)`,
    );

    // Lọc theo owner_id + phân trang
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS farm_jobs_owner_created_idx ON farm_jobs (owner, created_at DESC)`,
    );

    // Lọc theo type
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS farm_jobs_type_idx ON farm_jobs (type)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS farm_jobs_type_idx`);
    await queryRunner.query(`DROP INDEX IF EXISTS farm_jobs_owner_created_idx`);
    await queryRunner.query(`DROP INDEX IF EXISTS farm_jobs_status_created_idx`);
    await queryRunner.query(`DROP INDEX IF EXISTS farm_jobs_created_at_idx`);
    await queryRunner.query(
      `ALTER TABLE farm_nodes DROP COLUMN IF EXISTS allowed_kinds`,
    );
  }
}
