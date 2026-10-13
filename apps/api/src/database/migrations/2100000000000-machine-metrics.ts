import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tình trạng máy (worker gửi `metrics` ở heartbeat):
 * - `farm_nodes.metrics` + `metrics_at`: bản đo mới nhất của node (trang Máy).
 * - `farm_machine_metrics`: lịch sử theo máy (`farm_nodes.machine`, node không có máy thì theo tên node), mỗi phút một
 *   dòng; các node cùng máy ghi chung dòng đó (giữ số mới nhất). Reaper xoá dòng cũ hơn `MACHINE_METRICS_KEEP_DAYS`.
 *   `disk_free_mb`/`disk_total_mb` là ổ còn ít chỗ nhất; `disks`/`gpu` giữ đủ từng ổ, từng GPU.
 */
export class MachineMetrics2100000000000 implements MigrationInterface {
  name = 'MachineMetrics2100000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE farm_nodes
        ADD COLUMN metrics jsonb NULL,
        ADD COLUMN metrics_at timestamptz NULL
    `);
    await queryRunner.query(`
      CREATE TABLE farm_machine_metrics (
        machine text NOT NULL,
        at timestamptz NOT NULL,
        cpu_pct real NULL,
        ram_used_mb integer NULL,
        ram_total_mb integer NULL,
        disk_free_mb integer NULL,
        disk_total_mb integer NULL,
        disks jsonb NULL,
        net_rx_bps double precision NULL,
        net_tx_bps double precision NULL,
        gpu jsonb NULL,
        CONSTRAINT farm_machine_metrics_pkey PRIMARY KEY (machine, at)
      )
    `);
    // Khoá chính (machine, at) phục vụ biểu đồ một máy; index theo `at` cho reaper xoá dòng cũ.
    await queryRunner.query(`CREATE INDEX farm_machine_metrics_at_idx ON farm_machine_metrics (at)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS farm_machine_metrics`);
    await queryRunner.query(`
      ALTER TABLE farm_nodes
        DROP COLUMN IF EXISTS metrics_at,
        DROP COLUMN IF EXISTS metrics
    `);
  }
}
