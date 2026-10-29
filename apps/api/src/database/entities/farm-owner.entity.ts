import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Chủ job: ag-go, studio. Khoá chủ tự tạo, lưu hash sha256. */
@Entity('farm_owners')
export class FarmOwnerEntity {
  @PrimaryColumn('text')
  id!: string;

  /** sha256 hex của khoá chủ job */
  @Column({ name: 'key_hash', type: 'char', length: 64, unique: true })
  keyHash!: string;

  /** URL endpoint ký URL của chủ job */
  @Column({ name: 'sign_url', type: 'text' })
  signUrl!: string;

  /** Danh sách loại job chủ job được phép gửi */
  @Column({ name: 'allowed_types', type: 'text', array: true })
  allowedTypes!: string[];

  /** Domain web của ứng dụng, ví dụ `https://studio.example.com`; web admin ghép đường dẫn trang video / dự án */
  @Column({ name: 'web_url', type: 'text', nullable: true })
  webUrl!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
