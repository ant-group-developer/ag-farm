import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * - `accept_shared`: máy có pool còn nhận job không đòi pool (việc chung). Mặc định bật, nên gán pool cho máy không còn
 *   lặng lẽ làm nó mất việc chung; admin tắt để máy chỉ làm việc của pool.
 * - `exclusive_busy`: loại job máy đang chạy độc quyền (heartbeat), để máy xếp trước không giữ job loại đó khi nó không
 *   claim được.
 */
export class NodeAcceptShared2900000000000 implements MigrationInterface {
  name = 'NodeAcceptShared2900000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE farm_nodes ADD COLUMN accept_shared boolean NOT NULL DEFAULT true`);
    await queryRunner.query(`ALTER TABLE farm_nodes ADD COLUMN exclusive_busy text[] NOT NULL DEFAULT '{}'`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE farm_nodes DROP COLUMN exclusive_busy`);
    await queryRunner.query(`ALTER TABLE farm_nodes DROP COLUMN accept_shared`);
  }
}
