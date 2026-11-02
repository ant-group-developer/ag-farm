import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Một máy thuộc được nhiều pool (nhiều nhóm của AG Studio dùng chung máy đó): thêm `pools` (danh sách, rỗng = máy
 * chung), chép pool đã đặt sang. Expand/contract: cột `pool` cũ còn giữ để bản hub trước vẫn chạy được nếu phải quay
 * lại; một migration ở bản phát hành sau mới xoá nó (xem `deploy.sh`).
 */
export class NodePools2800000000000 implements MigrationInterface {
  name = 'NodePools2800000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE farm_nodes ADD COLUMN pools text[] NOT NULL DEFAULT '{}'`);
    await queryRunner.query(`UPDATE farm_nodes SET pools = ARRAY[pool] WHERE pool IS NOT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE farm_nodes SET pool = pools[1] WHERE cardinality(pools) > 0`);
    await queryRunner.query(`ALTER TABLE farm_nodes DROP COLUMN pools`);
  }
}
