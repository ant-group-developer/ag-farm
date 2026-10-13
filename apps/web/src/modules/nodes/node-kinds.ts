import type { JobType } from '../../types/api';

/** Một loại job trên dòng máy: worker có báo không, admin có chặn không. */
export interface KindRow {
  kind: JobType;
  /** Worker đang báo làm được (heartbeat gần nhất). */
  reported: boolean;
  /** Admin đã tắt ở máy này (`blocked_kinds`). */
  blocked: boolean;
}

/**
 * Các loại job hiện trên dòng máy: mọi loại worker báo (theo thứ tự báo), rồi các loại đã chặn mà worker không còn báo
 * (vẫn hiện để bật lại được).
 */
export function kindRows(reported: readonly JobType[], blocked: readonly JobType[]): KindRow[] {
  const rows: KindRow[] = reported.map((kind) => ({ kind, reported: true, blocked: blocked.includes(kind) }));
  for (const kind of blocked) {
    if (!reported.includes(kind)) rows.push({ kind, reported: false, blocked: true });
  }
  return rows;
}

/** `blocked_kinds` mới sau khi bật (`on`) hoặc tắt một loại. */
export function withKind(blocked: readonly JobType[], kind: JobType, on: boolean): JobType[] {
  const rest = blocked.filter((k) => k !== kind);
  return on ? rest : [...rest, kind];
}
