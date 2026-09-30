import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { Capabilities, Slots } from '@ag-farm/protocol';

/** Máy worker đã đăng ký. */
@Entity('farm_nodes')
export class FarmNodeEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  machine!: string;

  /** Loại job node báo cáo qua heartbeat (tự động cập nhật) */
  @Column({ type: 'text', array: true })
  kinds!: string[];

  /**
   * Loại job admin cho phép node nhận (nullable = cho phép tất cả kinds được báo cáo).
   * Khi assign job dùng giao: reported_kinds ∩ allowed_kinds.
   */
  @Column({ name: 'allowed_kinds', type: 'text', array: true, nullable: true, default: null })
  allowedKinds!: string[] | null;

  /** sha256 hex của token node */
  @Column({ name: 'token_hash', type: 'char', length: 64, unique: true })
  tokenHash!: string;

  @Column({ type: 'text', default: 'active' })
  status!: 'active' | 'disabled';

  @Column({ type: 'text', nullable: true })
  os!: string | null;

  @Column({ name: 'cpu_cores', type: 'int', nullable: true })
  cpuCores!: number | null;

  @Column({ name: 'ram_mb', type: 'int', nullable: true })
  ramMb!: number | null;

  @Column({ type: 'jsonb', nullable: true })
  gpus!: unknown | null;

  /** Engines: ffmpeg version, ollama_models, python version */
  @Column({ type: 'jsonb', nullable: true })
  engines!: unknown | null;

  /** Năng lực đầy đủ (json) */
  @Column({ type: 'jsonb', nullable: true })
  capabilities!: Capabilities | null;

  @Column({ name: 'free_slots', type: 'jsonb', nullable: true })
  freeSlots!: Slots | null;

  @Column({ name: 'running_job_ids', type: 'uuid', array: true, default: [] })
  runningJobIds!: string[];

  @Column({ type: 'jsonb', nullable: true })
  limits!: unknown | null;

  /** Lịch làm việc (weekly windows); null = 24/7 */
  @Column({ type: 'jsonb', nullable: true })
  schedule!: unknown | null;

  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt!: Date | null;

  @Column({ name: 'agent_version', type: 'text', nullable: true })
  agentVersion!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
