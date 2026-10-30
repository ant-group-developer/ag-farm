import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Một máy thuộc được nhiều pool (nhiều nhóm của AG Studio dùng chung máy đó): `pool` (một tên) thành `pools` (danh
 * sách, rỗng = máy chung), giữ pool đã đặt.
 */
export class NodePools2800000000000 implements MigrationInterface {
  name = 'NodePools2800000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE farm_nodes ADD COLUMN pools text[] NOT NULL DEFAULT '{}'`);
    await queryRunner.query(`UPDATE farm_nodes SET pools = ARRAY[pool] WHERE pool IS NOT NULL`);
    await queryRunner.query(`ALTER TABLE farm_nodes DROP COLUMN pool`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE farm_nodes ADD COLUMN pool text DEFAULT NULL`);
    await queryRunner.query(`UPDATE farm_nodes SET pool = pools[1] WHERE cardinality(pools) > 0`);
    await queryRunner.query(`ALTER TABLE farm_nodes DROP COLUMN pools`);
  }
}
