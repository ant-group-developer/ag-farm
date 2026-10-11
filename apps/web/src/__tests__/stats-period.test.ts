import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import {
  bucketLabel,
  customBucket,
  formatDuration,
  includesNow,
  niceTicks,
  previousPeriod,
  resolvePeriod,
  shiftDate,
  successRate,
} from '../modules/stats/period';

const NOW = dayjs('2026-10-11T15:30:00');
const fmt = (d: dayjs.Dayjs) => d.format('YYYY-MM-DD HH:mm');

describe('resolvePeriod', () => {
  it('ngày: 24 giờ của ngày đó, gom theo giờ', () => {
    const p = resolvePeriod({ mode: 'day', date: '2026-10-05', start: '', end: '' }, NOW);
    expect(fmt(p.from)).toBe('2026-10-05 00:00');
    expect(fmt(p.to)).toBe('2026-10-06 00:00');
    expect(p.bucket).toBe('hour');
  });

  it('không có ngày (hoặc ngày hỏng) thì xem hôm nay / tháng này / năm nay', () => {
    expect(fmt(resolvePeriod({ mode: 'day', date: '', start: '', end: '' }, NOW).from)).toBe('2026-10-11 00:00');
    expect(fmt(resolvePeriod({ mode: 'month', date: 'abc', start: '', end: '' }, NOW).from)).toBe('2026-10-01 00:00');
    const y = resolvePeriod({ mode: 'year', date: '', start: '', end: '' }, NOW);
    expect(fmt(y.from)).toBe('2026-01-01 00:00');
    expect(fmt(y.to)).toBe('2027-01-01 00:00');
    expect(y.bucket).toBe('month');
  });

  it('tháng: gom theo ngày', () => {
    const p = resolvePeriod({ mode: 'month', date: '2026-02-14', start: '', end: '' }, NOW);
    expect(fmt(p.from)).toBe('2026-02-01 00:00');
    expect(fmt(p.to)).toBe('2026-03-01 00:00');
    expect(p.bucket).toBe('day');
  });

  it('tùy chọn: gồm cả ngày cuối, tự đảo nếu chọn ngược, đơn vị theo độ dài', () => {
    const p = resolvePeriod({ mode: 'custom', date: '', start: '2026-10-10', end: '2026-10-01' }, NOW);
    expect(fmt(p.from)).toBe('2026-10-01 00:00');
    expect(fmt(p.to)).toBe('2026-10-11 00:00');
    expect(p.bucket).toBe('day');
    const oneDay = resolvePeriod({ mode: 'custom', date: '', start: '2026-10-10', end: '2026-10-10' }, NOW);
    expect(oneDay.bucket).toBe('hour');
  });

  it('tùy chọn không có ngày: 7 ngày qua', () => {
    const p = resolvePeriod({ mode: 'custom', date: '', start: '', end: '' }, NOW);
    expect(fmt(p.from)).toBe('2026-10-05 00:00');
    expect(fmt(p.to)).toBe('2026-10-12 00:00');
  });
});

describe('customBucket', () => {
  it('≤ 2 ngày theo giờ, ≤ 92 ngày theo ngày, dài hơn theo tháng', () => {
    expect(customBucket(1)).toBe('hour');
    expect(customBucket(2)).toBe('hour');
    expect(customBucket(3)).toBe('day');
    expect(customBucket(92)).toBe('day');
    expect(customBucket(93)).toBe('month');
  });
});

describe('previousPeriod', () => {
  it('lùi đúng một ngày / tháng / năm', () => {
    const m = previousPeriod(resolvePeriod({ mode: 'month', date: '2026-03-10', start: '', end: '' }, NOW));
    expect(fmt(m.from)).toBe('2026-02-01 00:00');
    expect(fmt(m.to)).toBe('2026-03-01 00:00');
  });

  it('tùy chọn: bấy nhiêu ngày ngay trước kỳ', () => {
    const p = previousPeriod(resolvePeriod({ mode: 'custom', date: '', start: '2026-10-08', end: '2026-10-10' }, NOW));
    expect(fmt(p.from)).toBe('2026-10-05 00:00');
    expect(fmt(p.to)).toBe('2026-10-08 00:00');
  });
});

describe('shiftDate / includesNow', () => {
  it('lùi, tiến theo đơn vị của kỳ', () => {
    expect(shiftDate('2026-01-31', 'month', 1)).toBe('2026-02-28');
    expect(shiftDate('2026-10-11', 'day', -1)).toBe('2026-10-10');
    expect(shiftDate('2026-10-11', 'year', -1)).toBe('2025-10-11');
  });

  it('kỳ có chứa hiện tại', () => {
    expect(includesNow(resolvePeriod({ mode: 'day', date: '2026-10-11', start: '', end: '' }, NOW), NOW)).toBe(true);
    expect(includesNow(resolvePeriod({ mode: 'day', date: '2026-10-10', start: '', end: '' }, NOW), NOW)).toBe(false);
  });
});

describe('định dạng', () => {
  it('nhãn ô thời gian', () => {
    expect(bucketLabel('2026-10-11T05:00:00', 'hour')).toBe('05:00');
    expect(bucketLabel('2026-10-11T05:00:00', 'hour', true)).toBe('05:00 11/10/2026');
    expect(bucketLabel('2026-10-11T00:00:00', 'day')).toBe('11/10');
    expect(bucketLabel('2026-10-01T00:00:00', 'month')).toBe('10/2026');
  });

  it('thời lượng', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(12_400)).toBe('12.4 s');
    expect(formatDuration(185_000)).toBe('3m 05s');
    expect(formatDuration(7_800_000)).toBe('2h 10m');
  });

  it('tỷ lệ thành công bỏ qua job hủy, không có job xong thì null', () => {
    expect(successRate(9, 1)).toBe(0.9);
    expect(successRate(0, 0)).toBeNull();
  });

  it('vạch trục y tròn số, phủ được giá trị lớn nhất', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(3)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(37)).toEqual([0, 10, 20, 30, 40]);
    expect(niceTicks(1234).at(-1)).toBeGreaterThanOrEqual(1234);
  });
});
