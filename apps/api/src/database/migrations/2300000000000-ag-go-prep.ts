import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ag-go chuẩn bị đầu vào cho Studio: job mới `scan.prep` (cảnh, khung, tờ cảnh, `audio.wav`) rồi `studio.transcribe`
 * trên `audio.wav` đó. Owner nào đã được quét footage (`scan.extract`, tức ag-go) thì được gửi cả hai loại. Không có
 * nó, ag-go nhận "not allowed for owner".
 */
export class AgGoPrep2300000000000 implements MigrationInterface {
  name = 'AgGoPrep2300000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const type of ['scan.prep', 'studio.transcribe']) {
      await queryRunner.query(
        `UPDATE farm_owners SET allowed_types = array_append(allowed_types, $1::text)
          WHERE 'scan.extract' = ANY(allowed_types) AND NOT ($1::text = ANY(allowed_types))`,
        [type],
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE farm_owners SET allowed_types = array_remove(allowed_types, 'scan.prep')`);
    // Studio (owner có `studio.tts`) vẫn giữ `studio.transcribe` của nó.
    await queryRunner.query(`
      UPDATE farm_owners SET allowed_types = array_remove(allowed_types, 'studio.transcribe')
       WHERE 'scan.extract' = ANY(allowed_types) AND NOT ('studio.tts' = ANY(allowed_types))
    `);
  }
}
