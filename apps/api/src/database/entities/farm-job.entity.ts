import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { JobError, JobResult, JobStatus, Lane } from '@ag-farm/protocol';

/** Job trong hàng đợi ag-farm. */
@Entity('farm_jobs')
export class FarmJobEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  owner!: string;

  @Column({ type: 'text' })
  type!: string;

  @Column({ type: 'text' })
  lane!: Lane;

  @Column({ type: 'text', default: 'queued' })
  status!: JobStatus;

  @Column({ type: 'int', default: 0 })
  priority!: number;

  @Column({ type: 'jsonb', default: {} })
  requirements!: Record<string, unknown>;

  @Column({ name: 'affinity_key', type: 'text', nullable: true })
  affinityKey!: string | null;

  @Column({ name: 'not_before', type: 'timestamptz', nullable: true })
  notBefore!: Date | null;

  @Column({ type: 'jsonb' })
  payload!: unknown;

  @Column({ type: 'jsonb', nullable: true })
  result!: JobResult | null;

  @Column({ type: 'jsonb', nullable: true })
  error!: JobError | null;

  @Column({ name: 'correlation_id', type: 'text' })
  correlationId!: string;

  @Column({ name: 'node_id', type: 'uuid', nullable: true })
  nodeId!: string | null;

  @Column({ name: 'lease_token', type: 'text', nullable: true })
  leaseToken!: string | null;

  @Column({ name: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt!: Date | null;

  @Column({ name: 'attempt_count', type: 'int', default: 0 })
  attemptCount!: number;

  @Column({ name: 'max_attempts', type: 'int', default: 3 })
  maxAttempts!: number;

  @Column({ name: 'progress_percent', type: 'real', nullable: true })
  progressPercent!: number | null;

  @Column({ name: 'progress_stage', type: 'text', nullable: true })
  progressStage!: string | null;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;

  @Column({ name: 'acked_at', type: 'timestamptz', nullable: true })
  ackedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
