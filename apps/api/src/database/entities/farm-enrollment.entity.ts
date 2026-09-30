import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Mã cài đặt một máy worker: dùng một lần, hết hạn sau `ENROLLMENT_TTL_HOURS`. Chỉ lưu sha256 của mã. */
@Entity('farm_enrollments')
export class FarmEnrollmentEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'code_hash', type: 'char', length: 64, unique: true })
  codeHash!: string;

  /** Tên máy, tiền tố tên node (`<machine>-scan`, `<machine>-render`). */
  @Column({ type: 'text' })
  machine!: string;

  @Column({ type: 'text', array: true })
  roles!: string[];

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt!: Date | null;

  /** Node tạo (hoặc cấp lại token) khi mã được dùng. */
  @Column({ name: 'node_ids', type: 'uuid', array: true })
  nodeIds!: string[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
