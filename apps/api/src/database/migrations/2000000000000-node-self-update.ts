import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Worker tự cập nhật:
 * - `auto_update` (mặc định bật): admin cho máy tự lên bản mới khi phát hành; worker đọc qua `GET /v1/worker/me`.
 * - `update_requested_at`: admin bấm "Cập nhật ngay" (cập nhật cả khi `auto_update` tắt, thử lại bản từng hỏng).
 * - `update_status` + `update_status_at`: trạng thái tự cập nhật worker báo ở heartbeat gần nhất có trường `update`
 *   (`{ state: idle|draining|installing|failed, target_version?, message?, since? }`).
 */
export class NodeSelfUpdate2000000000000 implements MigrationInterface {
  name = 'NodeSelfUpdate2000000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm_nodes
        ADD COLUMN auto_update boolean NOT NULL DEFAULT true,
        ADD COLUMN update_requested_at timestamptz NULL,
        ADD COLUMN update_status jsonb NULL,
        ADD COLUMN update_status_at timestamptz NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm_nodes
        DROP COLUMN update_status_at,
        DROP COLUMN update_status,
        DROP COLUMN update_requested_at,
        DROP COLUMN auto_update
    `);
  }
}
