import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Job mới `studio.beats` (máy farm phân tích nhịp nhạc nền cho Studio cắt cảnh theo phách): owner nào đã được đọc lời dẫn
 * (`studio.tts`) thì được gửi. Không có nó, Studio nhận "not allowed for owner".
 */
export class StudioBeats2400000000000 implements MigrationInterface {
  name = 'StudioBeats2400000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE farm_owners SET allowed_types = array_append(allowed_types, 'studio.beats')
       WHERE 'studio.tts' = ANY(allowed_types) AND NOT ('studio.beats' = ANY(allowed_types))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE farm_owners SET allowed_types = array_remove(allowed_types, 'studio.beats')`);
  }
}
