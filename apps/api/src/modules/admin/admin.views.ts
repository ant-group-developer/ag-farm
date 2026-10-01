import type { FarmJobEntity } from '../../database/entities/farm-job.entity';
import type { FarmNodeEntity } from '../../database/entities/farm-node.entity';
import type { FarmOwnerEntity } from '../../database/entities/farm-owner.entity';

/**
 * Admin API trả snake_case như mọi API khác của farm và không bao giờ trả hash của token/khoá.
 * Trả thẳng entity TypeORM thì ra camelCase (runningJobIds, allowedTypes…) — web admin đọc
 * snake_case nên vỡ khi `.map` trên field không tồn tại.
 */
export function toNodeView(node: FarmNodeEntity, online: boolean) {
  return {
    id: node.id,
    name: node.name,
    machine: node.machine,
    kinds: node.kinds,
    allowed_kinds: node.allowedKinds ?? null,
    status: node.status,
    os: node.os,
    cpu_cores: node.cpuCores,
    ram_mb: node.ramMb,
    gpus: node.gpus,
    engines: node.engines,
    capabilities: node.capabilities,
    free_slots: node.freeSlots,
    running_job_ids: node.runningJobIds ?? [],
    limits: node.limits,
    schedule: node.schedule,
    last_seen_at: node.lastSeenAt ? node.lastSeenAt.toISOString() : null,
    agent_version: node.agentVersion,
    created_at: node.createdAt.toISOString(),
    updated_at: node.updatedAt.toISOString(),
    online,
  };
}

export function toOwnerView(owner: FarmOwnerEntity) {
  return {
    id: owner.id,
    sign_url: owner.signUrl,
    allowed_types: owner.allowedTypes,
    created_at: owner.createdAt.toISOString(),
    updated_at: owner.updatedAt.toISOString(),
  };
}

/** Dạng job đầy đủ cho admin (bao gồm payload, requirements, not_before, lease_expires_at). */
export function toAdminJobView(j: FarmJobEntity, nodeName?: string | null) {
  return {
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
    node_name: nodeName ?? null,
    progress_percent: j.progressPercent,
    progress_stage: j.progressStage,
    payload: j.payload,
    requirements: j.requirements,
    not_before: j.notBefore ? j.notBefore.toISOString() : null,
    lease_expires_at: j.leaseExpiresAt ? j.leaseExpiresAt.toISOString() : null,
    result: j.result,
    error: j.error,
    created_at: j.createdAt.toISOString(),
    updated_at: j.updatedAt.toISOString(),
    started_at: j.startedAt ? j.startedAt.toISOString() : null,
    finished_at: j.finishedAt ? j.finishedAt.toISOString() : null,
    acked_at: j.ackedAt ? j.ackedAt.toISOString() : null,
  };
}
