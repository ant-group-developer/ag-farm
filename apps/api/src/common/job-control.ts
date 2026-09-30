import type { Repository, SelectQueryBuilder, UpdateQueryBuilder } from 'typeorm';
import { FarmJobEntity } from '../database/entities/farm-job.entity';

export type JobControlAction = 'pause' | 'resume' | 'cancel';

/** Chọn job: mọi điều kiện có mặt đều phải khớp (chủ job luôn chỉ đụng được job của mình). */
export interface JobSelector {
  owner?: string;
  ids?: string[];
  groupKey?: string;
  types?: string[];
  statuses?: string[];
}

/** Trạng thái mỗi thao tác được đổi từ đó; job ở trạng thái khác được bỏ qua. */
const FROM: Record<JobControlAction, string[]> = {
  pause: ['queued', 'leased'],
  resume: ['paused'],
  cancel: ['queued', 'leased', 'paused'],
};

function applySelector<T extends SelectQueryBuilder<FarmJobEntity> | UpdateQueryBuilder<FarmJobEntity>>(
  qb: T,
  sel: JobSelector,
  from: string[],
): T {
  const statuses = sel.statuses ? from.filter((s) => sel.statuses!.includes(s)) : from;
  qb.where('status = ANY(:from)', { from: statuses });
  if (sel.owner) qb.andWhere('owner = :owner', { owner: sel.owner });
  if (sel.ids) qb.andWhere('id = ANY(:ids)', { ids: sel.ids });
  if (sel.groupKey) qb.andWhere('group_key = :groupKey', { groupKey: sel.groupKey });
  if (sel.types) qb.andWhere('type = ANY(:types)', { types: sel.types });
  return qb;
}

/**
 * Tạm dừng / chạy tiếp / huỷ cả loạt job, trả số job đã đổi.
 * - pause: `queued` và `leased` → `paused`. Job đang chạy mất lease (worker nhận 409 `job_paused` ở lần
 *   progress kế tiếp và dừng); lần thử đang chạy không bị tính.
 * - resume: `paused` → `queued`, chạy được ngay.
 * - cancel: `queued`/`leased`/`paused` → `cancelled` (worker đang chạy nhận 409 `job_cancelled`).
 */
export async function controlJobs(
  repo: Repository<FarmJobEntity>,
  action: JobControlAction,
  sel: JobSelector,
): Promise<number> {
  if (sel.ids && sel.ids.length === 0) return 0;
  const qb = repo.createQueryBuilder().update(FarmJobEntity);
  const now = () => 'now()';
  if (action === 'pause') {
    qb.set({
      status: 'paused',
      nodeId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      // Lần thử bị ngắt giữa chừng không tính (claim đã cộng 1)
      attemptCount: () => `CASE WHEN status = 'leased' THEN GREATEST(attempt_count - 1, 0) ELSE attempt_count END`,
      progressPercent: null,
      progressStage: null,
      updatedAt: now,
    });
  } else if (action === 'resume') {
    qb.set({ status: 'queued', notBefore: null, updatedAt: now });
  } else {
    qb.set({ status: 'cancelled', finishedAt: now, updatedAt: now });
  }
  const result = await applySelector(qb, sel, FROM[action]).execute();
  return result.affected ?? 0;
}
