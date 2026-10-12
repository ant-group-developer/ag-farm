import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Admin chặn loại job thay vì liệt kê loại được phép: `allowed_kinds` (null = mọi loại máy báo) thành `blocked_kinds`
 * (rỗng = không chặn gì). Loại job mới mà worker bản mới báo lên (handler mới, máy vừa có yt-dlp…) tự chạy, không phải
 * chờ admin thêm vào danh sách.
 *
 * Chuyển: máy có `allowed_kinds` thì chặn = loại đã báo − loại được phép (giữ thứ tự đã báo); `allowed_kinds` null thì
 * không chặn gì. `allowed_kinds` rỗng (không cho gì) thành chặn mọi loại đã báo.
 */
export class NodeBlockedKinds1900000000000 implements MigrationInterface {
  name = 'NodeBlockedKinds1900000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE farm_nodes ADD COLUMN blocked_kinds text[] NOT NULL DEFAULT '{}'`);
    await queryRunner.query(`
      UPDATE farm_nodes SET blocked_kinds = ARRAY(
        SELECT u.k FROM unnest(kinds) WITH ORDINALITY AS u(k, i)
        WHERE NOT (u.k = ANY(allowed_kinds))
        ORDER BY u.i
      )
      WHERE allowed_kinds IS NOT NULL
    `);
    await queryRunner.query(`ALTER TABLE farm_nodes DROP COLUMN allowed_kinds`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE farm_nodes ADD COLUMN allowed_kinds text[] DEFAULT NULL`);
    await queryRunner.query(`
      UPDATE farm_nodes SET allowed_kinds = ARRAY(
        SELECT u.k FROM unnest(kinds) WITH ORDINALITY AS u(k, i)
        WHERE NOT (u.k = ANY(blocked_kinds))
        ORDER BY u.i
      )
      WHERE cardinality(blocked_kinds) > 0
    `);
    await queryRunner.query(`ALTER TABLE farm_nodes DROP COLUMN blocked_kinds`);
  }
}
