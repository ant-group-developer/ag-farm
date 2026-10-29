import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Domain web của ứng dụng chủ job (vd. `https://studio.example.com`): trang Job của web admin ghép đường dẫn của
 * ứng dụng đó (web admin biết sẵn) để bấm mở video / dự án của job. `null` = chưa nhập, không có link.
 */
export class OwnerWebUrl2600000000000 implements MigrationInterface {
  name = 'OwnerWebUrl2600000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE farm_owners ADD COLUMN web_url text NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE farm_owners DROP COLUMN web_url`);
  }
}
