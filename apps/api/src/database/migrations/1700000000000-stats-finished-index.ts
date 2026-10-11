import { MigrationInterface, QueryRunner } from 'typeorm';

/** Thống kê theo kỳ (GET /v1/admin/stats/period) lọc job kết thúc theo khoảng finished_at. */
export class StatsFinishedIndex1700000000000 implements MigrationInterface {
  name = 'StatsFinishedIndex1700000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS farm_jobs_finished_at_idx ON farm_jobs (finished_at) WHERE finished_at IS NOT NULL`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS farm_jobs_finished_at_idx`);
  }
}
