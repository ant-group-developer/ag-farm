import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Job mới `studio.export_premiere` (project Adobe Premiere của một tập): owner nào đã được render bản cuối
 * (`studio.render_final`) thì được xuất Premiere — không có nó, Studio nhận "not allowed for owner" khi gửi job.
 */
export class StudioExportPremiere1400000000000 implements MigrationInterface {
  name = 'StudioExportPremiere1400000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE farm_owners SET allowed_types = array_append(allowed_types, 'studio.export_premiere')
       WHERE 'studio.render_final' = ANY(allowed_types) AND NOT ('studio.export_premiere' = ANY(allowed_types))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE farm_owners SET allowed_types = array_remove(allowed_types, 'studio.export_premiere')`,
    );
  }
}
