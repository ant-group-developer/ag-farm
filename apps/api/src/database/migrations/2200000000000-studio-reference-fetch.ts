import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Job mới `studio.reference_fetch` (máy farm tải video YouTube mẫu cho Studio khi YouTube chặn IP máy chủ Studio): owner
 * nào đã được đọc lời dẫn (`studio.tts`) thì được tải video mẫu. Không có nó, Studio nhận "not allowed for owner".
 */
export class StudioReferenceFetch2200000000000 implements MigrationInterface {
  name = 'StudioReferenceFetch2200000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE farm_owners SET allowed_types = array_append(allowed_types, 'studio.reference_fetch')
       WHERE 'studio.tts' = ANY(allowed_types) AND NOT ('studio.reference_fetch' = ANY(allowed_types))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE farm_owners SET allowed_types = array_remove(allowed_types, 'studio.reference_fetch')`);
  }
}
