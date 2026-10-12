import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Thứ tự ưu tiên của máy (`priority_order`, số nhỏ trước): máy xếp trước được nhận việc trước khi rảnh.
 * Máy đã có xếp theo thứ tự tạo; máy mới (cài bằng mã, tạo tay, hay chèn thẳng) lấy số kế tiếp của sequence,
 * nên luôn đứng sau mọi máy đã có.
 */
export class NodePriorityOrder1800000000000 implements MigrationInterface {
  name = 'NodePriorityOrder1800000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SEQUENCE IF NOT EXISTS farm_nodes_priority_order_seq AS integer`);
    await queryRunner.query(`ALTER TABLE farm_nodes ADD COLUMN priority_order integer`);
    await queryRunner.query(`
      UPDATE farm_nodes n SET priority_order = o.rn
      FROM (SELECT id, row_number() OVER (ORDER BY created_at, name, id) AS rn FROM farm_nodes) o
      WHERE n.id = o.id
    `);
    // Bảng rỗng: số kế tiếp là 1; có n máy: số kế tiếp là n + 1.
    await queryRunner.query(`
      SELECT setval('farm_nodes_priority_order_seq', GREATEST(COUNT(*), 1), COUNT(*) > 0) FROM farm_nodes
    `);
    await queryRunner.query(`
      ALTER TABLE farm_nodes
        ALTER COLUMN priority_order SET DEFAULT nextval('farm_nodes_priority_order_seq'),
        ALTER COLUMN priority_order SET NOT NULL
    `);
    await queryRunner.query(`ALTER SEQUENCE farm_nodes_priority_order_seq OWNED BY farm_nodes.priority_order`);
    await queryRunner.query(`CREATE INDEX farm_nodes_priority_order_idx ON farm_nodes (priority_order, name)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS farm_nodes_priority_order_idx`);
    // Sequence thuộc cột nên bị xoá cùng cột.
    await queryRunner.query(`ALTER TABLE farm_nodes DROP COLUMN IF EXISTS priority_order`);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS farm_nodes_priority_order_seq`);
  }
}
