import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bỏ `farm_owners.default_lane`: lane của job lấy theo loại job (`JOB_TYPE_SPECS[type].lane`, render là interactive,
 * quét là batch) khi chủ job không chọn, nên lane mặc định của chủ job không bao giờ được dùng tới.
 */
export class DropOwnerDefaultLane1500000000000 implements MigrationInterface {
  name = 'DropOwnerDefaultLane1500000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE farm_owners DROP COLUMN IF EXISTS default_lane`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE farm_owners ADD COLUMN IF NOT EXISTS default_lane text NOT NULL DEFAULT 'batch'`,
    );
  }
}
