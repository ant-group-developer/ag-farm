import type { OwnerNodeView } from '@ag-farm/protocol';
import type { FarmNodeEntity } from '../../database/entities/farm-node.entity';

/**
 * A node as a job owner sees it (`GET /v1/owner/nodes`), or `null` when it is disabled or takes none of the owner's
 * job types. Never the token, machine details or limits: name, kinds, GPUs and load.
 */
export function toOwnerNodeView(node: FarmNodeEntity, online: boolean, ownerTypes: readonly string[]): OwnerNodeView | null {
  if (node.status !== 'active') return null;
  const takes = node.allowedKinds != null ? node.kinds.filter((k) => node.allowedKinds!.includes(k)) : node.kinds;
  const kinds = takes.filter((k) => ownerTypes.includes(k));
  if (kinds.length === 0) return null;
  const gpus = Array.isArray(node.gpus) ? (node.gpus as { name?: unknown; vram_mb?: unknown; nvenc?: unknown }[]) : [];
  return {
    id: node.id,
    name: node.name,
    online,
    kinds: kinds as OwnerNodeView['kinds'],
    gpus: gpus.map((g) => ({ name: String(g.name ?? ''), vram_mb: Number(g.vram_mb ?? 0), nvenc: g.nvenc === true })),
    running_jobs: node.runningJobIds?.length ?? 0,
    last_seen_at: node.lastSeenAt ? node.lastSeenAt.toISOString() : null,
  };
}
