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
    blocked_kinds: node.blockedKinds ?? [],
    pool: node.pool ?? null,
    status: node.status,
    priority_order: node.priorityOrder,
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
    // Tự cập nhật: admin cho phép không, lần bấm "Cập nhật ngay", trạng thái worker báo ở heartbeat gần nhất.
    auto_update: node.autoUpdate ?? true,
    update_requested_at: node.updateRequestedAt ? node.updateRequestedAt.toISOString() : null,
    update: node.updateStatus ?? null,
    update_at: node.updateStatusAt ? node.updateStatusAt.toISOString() : null,
    // Tình trạng máy ở heartbeat gần nhất có số đo; `metrics_at` cũ (worker cũ, máy tắt) thì web làm mờ.
    metrics: node.metrics ?? null,
    metrics_at: node.metricsAt ? node.metricsAt.toISOString() : null,
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
    web_url: owner.webUrl ?? null,
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
