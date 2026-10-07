import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Job mới `studio.transcribe` (nhận dạng lời nói trong footage, cho kiểu dựng cắt theo shot của Studio): owner nào
 * đã được đọc lời dẫn (`studio.tts`) thì được nhận dạng lời nói. Không có nó, Studio nhận "not allowed for owner".
 */
export class StudioTranscribe1600000000000 implements MigrationInterface {
  name = 'StudioTranscribe1600000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE farm_owners SET allowed_types = array_append(allowed_types, 'studio.transcribe')
       WHERE 'studio.tts' = ANY(allowed_types) AND NOT ('studio.transcribe' = ANY(allowed_types))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE farm_owners SET allowed_types = array_remove(allowed_types, 'studio.transcribe')`);
  }
}
