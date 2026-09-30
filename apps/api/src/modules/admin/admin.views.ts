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
    default_lane: owner.defaultLane,
    created_at: owner.createdAt.toISOString(),
    updated_at: owner.updatedAt.toISOString(),
  };
}
