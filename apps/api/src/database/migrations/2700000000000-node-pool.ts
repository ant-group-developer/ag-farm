import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pool máy (máy riêng của một chi nhánh, AG Studio plan 2026-10-30): admin đặt cho từng máy. Máy có pool chỉ nhận job
 * có `requirements.pool` đúng pool đó; máy không pool (NULL) là máy chung, chỉ nhận job không đòi pool.
 */
export class NodePool2700000000000 implements MigrationInterface {
  name = 'NodePool2700000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE farm_nodes ADD COLUMN pool text DEFAULT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE farm_nodes DROP COLUMN pool`);
  }
}
