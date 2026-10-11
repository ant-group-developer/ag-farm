import dayjs, { type Dayjs } from 'dayjs';
import type { StatsBucket, StatsPeriodQuery } from '../../types/api';

/** Kiểu kỳ xem trên trang Tổng quan. */
export type PeriodMode = 'day' | 'month' | 'year' | 'custom';
export const PERIOD_MODES: readonly PeriodMode[] = ['day', 'month', 'year', 'custom'];

/** Định dạng ngày lưu trên URL. */
export const DATE_FORMAT = 'YYYY-MM-DD';

/** Lựa chọn trên bộ lọc, đúng như lưu trên URL. */
export interface PeriodSelection {
  mode: PeriodMode;
  /** Ngày bất kỳ trong ngày/tháng/năm đang xem (YYYY-MM-DD) */
  date: string;
  /** Kỳ tuỳ chọn: ngày đầu và ngày cuối, gồm cả hai (YYYY-MM-DD) */
  start: string;
  end: string;
}

/** Kỳ đã tính ra: [from, to) theo giờ địa phương, kèm đơn vị gom nhóm. */
export interface ResolvedPeriod {
  mode: PeriodMode;
  from: Dayjs;
  to: Dayjs;
  bucket: StatsBucket;
}

const MODE_UNIT = { day: 'day', month: 'month', year: 'year' } as const;
const MODE_BUCKET: Record<Exclude<PeriodMode, 'custom'>, StatsBucket> = {
  day: 'hour',
  month: 'day',
  year: 'month',
};

function parseDate(value: string, fallback: Dayjs): Dayjs {
  // YYYY-MM-DD là ISO nên dayjs đọc thẳng được, không cần plugin customParseFormat.
  const d = dayjs(value);
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) && d.isValid() ? d : fallback;
}

/** Kỳ tuỳ chọn: tối đa 2 ngày xem theo giờ, tối đa ~3 tháng xem theo ngày, dài hơn xem theo tháng. */
export function customBucket(days: number): StatsBucket {
  if (days <= 2) return 'hour';
  if (days <= 92) return 'day';
  return 'month';
}

export function resolvePeriod(sel: PeriodSelection, now: Dayjs = dayjs()): ResolvedPeriod {
  if (sel.mode === 'custom') {
    let start = parseDate(sel.start, now.subtract(6, 'day')).startOf('day');
    let end = parseDate(sel.end, now).startOf('day');
    if (end.isBefore(start)) [start, end] = [end, start];
    const to = end.add(1, 'day');
    return { mode: 'custom', from: start, to, bucket: customBucket(to.diff(start, 'day')) };
  }
  const unit = MODE_UNIT[sel.mode];
  const from = parseDate(sel.date, now).startOf(unit);
  return { mode: sel.mode, from, to: from.add(1, unit), bucket: MODE_BUCKET[sel.mode] };
}

/**
 * Kỳ liền trước, cùng độ dài: hôm qua, tháng trước, năm trước, hoặc bấy nhiêu ngày ngay trước kỳ tuỳ chọn.
 * Kỳ đang diễn ra thì chỉ lấy phần kỳ trước đã trôi qua tương ứng (hôm nay đến 15:30 so với hôm qua đến 15:30),
 * để không so nửa ngày với cả ngày.
 */
export function previousPeriod(p: ResolvedPeriod, now: Dayjs = dayjs()): ResolvedPeriod {
  let from: Dayjs;
  if (p.mode === 'custom') {
    from = p.from.subtract(p.to.diff(p.from, 'day'), 'day');
  } else {
    from = p.from.subtract(1, MODE_UNIT[p.mode]);
  }
  const to = includesNow(p, now) ? from.add(now.diff(p.from), 'millisecond') : p.from;
  return { ...p, from, to };
}

/** Lùi/tiến ngày neo một ngày/tháng/năm (nút ‹ ›). */
export function shiftDate(date: string, mode: Exclude<PeriodMode, 'custom'>, step: number): string {
  return parseDate(date, dayjs()).add(step, MODE_UNIT[mode]).format(DATE_FORMAT);
}

/** Kỳ có chứa thời điểm hiện tại (để tự làm mới). */
export function includesNow(p: ResolvedPeriod, now: Dayjs = dayjs()): boolean {
  return !now.isBefore(p.from) && now.isBefore(p.to);
}

/** Múi giờ của trình duyệt: ngày/tháng trên biểu đồ khớp với lịch người xem. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function toStatsQuery(p: ResolvedPeriod, tz: string = browserTimeZone()): StatsPeriodQuery {
  return { from: p.from.format(), to: p.to.format(), bucket: p.bucket, tz };
}

/** Nhãn của một ô thời gian (`t` là giờ địa phương, không có offset). `long` cho tooltip và bảng. */
export function bucketLabel(t: string, bucket: StatsBucket, long = false): string {
  const d = dayjs(t);
  switch (bucket) {
    case 'hour':
      return long ? d.format('HH:mm DD/MM/YYYY') : d.format('HH:mm');
    case 'day':
      return long ? d.format('DD/MM/YYYY') : d.format('DD/MM');
    case 'month':
      return d.format('MM/YYYY');
  }
}

/** Thời lượng ngắn gọn: 850 ms, 12.4 s, 3m 05s, 2h 10m. */
export function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const totalS = Math.round(s);
  const m = Math.floor(totalS / 60);
  if (m < 60) return `${m}m ${String(totalS % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Tỷ lệ thành công trên các job đã chạy xong (hoàn tất + thất bại); job huỷ không tính. */
export function successRate(completed: number, failed: number): number | null {
  const done = completed + failed;
  return done === 0 ? null : completed / done;
}

/** Vạch chia trục y tròn số (1, 2, 5 × 10^n), luôn từ 0. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const stepInt = Math.max(1, Math.ceil(step));
  const ticks: number[] = [];
  for (let v = 0; v < max + stepInt; v += stepInt) ticks.push(v);
  return ticks;
}
