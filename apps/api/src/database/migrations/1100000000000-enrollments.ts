import { MigrationInterface, QueryRunner } from 'typeorm';

/** Mã cài đặt máy worker (xem `modules/enroll`). */
export class Enrollments1100000000000 implements MigrationInterface {
  name = 'Enrollments1100000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE farm_enrollments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code_hash char(64) NOT NULL UNIQUE,
        machine text NOT NULL,
        roles text[] NOT NULL,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        node_ids uuid[] NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS farm_enrollments`);
  }
}
