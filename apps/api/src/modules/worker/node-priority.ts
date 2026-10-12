import {
  JOB_TYPE_SPECS,
  nodeMeetsRequirements,
  type Requirements,
  type SlotKind,
  type Slots,
} from '@ag-farm/protocol';
import type { FarmJobEntity } from '../../database/entities/farm-job.entity';
import type { FarmNodeEntity } from '../../database/entities/farm-node.entity';

/**
 * Lịch chạy do worker tự áp theo giờ của chính máy đó (hub chạy UTC trên VPS, máy ở văn phòng),
 * nên hub chỉ lưu `schedule` để hiển thị. Ngoại lệ duy nhất: `{ paused: true }` để tạm dừng từ web.
 */
export function isInsideSchedule(schedule: unknown): boolean {
  return !(schedule && typeof schedule === 'object' && (schedule as { paused?: unknown }).paused === true);
}

/** Loại job máy nhận: loại worker báo − loại admin chặn (`blocked_kinds`). */
export function effectiveKinds(reported: readonly string[], blocked: readonly string[] | null | undefined): string[] {
  return blocked?.length ? reported.filter((k) => !blocked.includes(k)) : [...reported];
}

/** `a` xếp trước `b`: số thứ tự nhỏ hơn; trùng số thì theo id để hai máy không cùng nhường nhau. */
export function isAhead(a: Pick<FarmNodeEntity, 'id' | 'priorityOrder'>, b: Pick<FarmNodeEntity, 'id' | 'priorityOrder'>): boolean {
  return a.priorityOrder !== b.priorityOrder ? a.priorityOrder < b.priorityOrder : a.id < b.id;
}

/** Máy xếp trước còn rảnh và slot nó còn trống tính đến lúc này. */
export interface EarlierNode {
  node: FarmNodeEntity;
  kinds: string[];
  free: Slots;
}

/**
 * Các máy xếp trước `self` đang nhận việc được: bật, online, trong lịch, đã báo năng lực và slot trống.
 * Theo thứ tự ưu tiên. `free` là slot trống ở heartbeat gần nhất, chưa trừ job giao sau heartbeat đó.
 */
export function earlierReadyNodes(
  nodes: readonly FarmNodeEntity[],
  self: FarmNodeEntity,
  nowMs: number,
  offlineAfterSeconds: number,
): EarlierNode[] {
  const onlineSince = nowMs - offlineAfterSeconds * 1000;
  return nodes
    .filter(
      (n) =>
        n.id !== self.id &&
        isAhead(n, self) &&
        n.status === 'active' &&
        n.lastSeenAt != null &&
        n.lastSeenAt.getTime() >= onlineSince &&
        isInsideSchedule(n.schedule) &&
        n.capabilities != null &&
        n.freeSlots != null,
    )
    .sort((a, b) => (isAhead(a, b) ? -1 : 1))
    .map((n) => ({ node: n, kinds: effectiveKinds(n.kinds, n.blockedKinds), free: { ...n.freeSlots! } }));
}

/** Trừ vào slot trống các job đã giao cho máy sau lần heartbeat gần nhất của nó (heartbeat chưa tính các job này). */
export function subtractLeasedSince(
  earlier: EarlierNode[],
  leased: ReadonlyArray<{ node_id: string; type: string; n: number | string }>,
): void {
  const byId = new Map(earlier.map((e) => [e.node.id, e]));
  for (const row of leased) {
    const e = byId.get(row.node_id);
    const spec = JOB_TYPE_SPECS[row.type as keyof typeof JOB_TYPE_SPECS];
    if (!e || !spec) continue;
    e.free[spec.slot] = Math.max(0, e.free[spec.slot] - Number(row.n));
  }
}

/**
 * Máy xếp trước đầu tiên nhận được job này ngay (nhận loại job, đủ `requirements`, còn slot), hoặc `null`.
 * Job ghim máy (`requirements.node_id`) không nhường ai.
 */
export function earlierNodeFor(
  job: Pick<FarmJobEntity, 'type' | 'requirements'>,
  earlier: readonly EarlierNode[],
): EarlierNode | null {
  const reqs = job.requirements as Requirements;
  if (reqs.node_id) return null;
  const spec = JOB_TYPE_SPECS[job.type as keyof typeof JOB_TYPE_SPECS];
  if (!spec) return null;
  const slot: SlotKind = spec.slot;
  return (
    earlier.find(
      (e) => e.free[slot] >= 1 && e.kinds.includes(job.type) && nodeMeetsRequirements(e.node.id, e.node.capabilities!, reqs),
    ) ?? null
  );
}

/** Lúc job bắt đầu chờ được nhận: lúc tạo, lúc vào lại hàng (updated_at) hoặc `not_before`, lấy mốc muộn nhất. */
export function claimableSince(job: Pick<FarmJobEntity, 'createdAt' | 'updatedAt' | 'notBefore'>): number {
  return Math.max(job.createdAt.getTime(), job.updatedAt.getTime(), job.notBefore?.getTime() ?? 0);
}
