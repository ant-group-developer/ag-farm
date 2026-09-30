import { JobViewSchema, type JobView } from '@ag-farm/protocol';
import type { FarmJobEntity } from '../database/entities/farm-job.entity';

/** Dạng job trả cho chủ job và admin (không có payload, lease token). */
export function toJobView(j: FarmJobEntity): JobView {
  return JobViewSchema.parse({
    id: j.id,
    owner: j.owner,
    type: j.type,
    lane: j.lane,
    status: j.status,
    priority: j.priority,
    correlation_id: j.correlationId,
    affinity_key: j.affinityKey,
    group_key: j.groupKey,
    attempt_count: j.attemptCount,
    max_attempts: j.maxAttempts,
    node_id: j.nodeId,
    progress_percent: j.progressPercent,
    progress_stage: j.progressStage,
    result: j.result,
    error: j.error,
    created_at: j.createdAt.toISOString(),
    updated_at: j.updatedAt.toISOString(),
    finished_at: j.finishedAt?.toISOString() ?? null,
    acked_at: j.ackedAt?.toISOString() ?? null,
  });
}
