import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "Lấy log" của máy worker (trang Máy): mỗi lần admin xin là một dòng `requested`; worker gửi log (gzip) thì thành
 * `uploaded` với `content`; không gửi trong 24 giờ thì `failed`. Reaper xoá dòng cũ hơn 14 ngày.
 */
export class NodeLogs2500000000000 implements MigrationInterface {
  name = 'NodeLogs2500000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE farm_node_logs (
        id uuid NOT NULL DEFAULT gen_random_uuid(),
        node_id uuid NOT NULL REFERENCES farm_nodes(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'uploaded', 'failed')),
        since timestamptz NULL,
        until timestamptz NULL,
        requested_at timestamptz NOT NULL DEFAULT now(),
        uploaded_at timestamptz NULL,
        size_bytes integer NULL,
        content bytea NULL,
        error text NULL,
        CONSTRAINT farm_node_logs_pkey PRIMARY KEY (id)
      )
    `);
    await queryRunner.query(`CREATE INDEX farm_node_logs_node_idx ON farm_node_logs (node_id, requested_at DESC)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS farm_node_logs`);
  }
}
