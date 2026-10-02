import i18n from 'i18next';
import type { JobType, Lane } from '../../types/api';
import { JOB_TYPES } from '../../types/api';

/** Tên dễ đọc của loại việc theo ngôn ngữ đang dùng; loại lạ thì trả nguyên giá trị. */
export function jobTypeLabel(type: JobType): string {
  const key = `jobTypeName.${type}`;
  return i18n.exists(key) ? i18n.t(key) : type;
}

/** Tên dễ đọc của lane theo ngôn ngữ đang dùng; lane lạ thì trả nguyên giá trị. */
export function laneLabel(lane: Lane): string {
  const key = `lane.${lane}`;
  return i18n.exists(key) ? i18n.t(key) : lane;
}

/** Options cho Select loại việc: giá trị là enum, nhãn là tên dễ đọc. */
export function jobTypeOptions(types: readonly JobType[] = JOB_TYPES): { value: JobType; label: string }[] {
  return types.map((type) => ({ value: type, label: jobTypeLabel(type) }));
}
