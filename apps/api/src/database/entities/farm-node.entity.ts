import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { Capabilities, MachineMetrics, Slots, WorkerUpdateStatus } from '@ag-farm/protocol';

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
   * Loại job admin chặn ở node này (rỗng = không chặn gì). Khi giao job: kinds worker báo − blocked_kinds, nên loại
   * mới worker báo lên tự chạy.
   */
  @Column({ name: 'blocked_kinds', type: 'text', array: true, default: () => `'{}'` })
  blockedKinds!: string[];

  /** Pool máy (chi nhánh): chỉ nhận job `requirements.pool` đúng pool này; null = máy chung. */
  @Column({ type: 'text', nullable: true, default: null })
  pool!: string | null;

  /** sha256 hex của token node */
  @Column({ name: 'token_hash', type: 'char', length: 64, unique: true })
  tokenHash!: string;

  @Column({ type: 'text', default: 'active' })
  status!: 'active' | 'disabled';

  /**
   * Thứ tự ưu tiên (số nhỏ trước): máy xếp trước còn slot thì được nhận việc trước máy xếp sau.
   * Máy mới lấy số kế tiếp của sequence (đứng sau mọi máy đã có).
   */
  @Column({
    name: 'priority_order',
    type: 'int',
    default: () => "nextval('farm_nodes_priority_order_seq')",
  })
  priorityOrder!: number;

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

  /** Máy tự lên bản mới khi phát hành (worker đọc qua `GET /v1/worker/me`). */
  @Column({ name: 'auto_update', type: 'boolean', default: true })
  autoUpdate!: boolean;

  /** Admin bấm "Cập nhật ngay": worker cập nhật ở lần hỏi kế tiếp (dù `auto_update` tắt). */
  @Column({ name: 'update_requested_at', type: 'timestamptz', nullable: true })
  updateRequestedAt!: Date | null;

  /** Trạng thái tự cập nhật ở heartbeat gần nhất có trường `update`. */
  @Column({ name: 'update_status', type: 'jsonb', nullable: true })
  updateStatus!: WorkerUpdateStatus | null;

  @Column({ name: 'update_status_at', type: 'timestamptz', nullable: true })
  updateStatusAt!: Date | null;

  /** Số đo máy ở heartbeat gần nhất có trường `metrics` (CPU, RAM, ổ, mạng, GPU). */
  @Column({ type: 'jsonb', nullable: true })
  metrics!: MachineMetrics | null;

  @Column({ name: 'metrics_at', type: 'timestamptz', nullable: true })
  metricsAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
