import { isWithinSchedule } from './config';
import type { ScheduleWindow } from './config';

describe('isWithinSchedule', () => {
  const monday = (h: number, m = 0) => {
    // 2024-01-15 = Monday (1)
    const d = new Date(2024, 0, 15, h, m, 0);
    return d;
  };

  it('no windows → always true', () => {
    expect(isWithinSchedule([], new Date())).toBe(true);
  });

  it('normal window: inside', () => {
    const w: ScheduleWindow[] = [{ days: [1], from: '09:00', to: '18:00' }];
    expect(isWithinSchedule(w, monday(10))).toBe(true);
  });

  it('normal window: outside', () => {
    const w: ScheduleWindow[] = [{ days: [1], from: '09:00', to: '18:00' }];
    expect(isWithinSchedule(w, monday(8))).toBe(false);
    expect(isWithinSchedule(w, monday(19))).toBe(false);
  });

  it('overnight window: inside (evening)', () => {
    // 19:00 → 07:00 next day
    const w: ScheduleWindow[] = [{ days: [1], from: '19:00', to: '07:00' }];
    expect(isWithinSchedule(w, monday(20))).toBe(true);
    expect(isWithinSchedule(w, monday(23, 59))).toBe(true);
  });

  it('overnight window: inside (morning)', () => {
    const w: ScheduleWindow[] = [{ days: [1], from: '19:00', to: '07:00' }];
    expect(isWithinSchedule(w, monday(6))).toBe(true);
    expect(isWithinSchedule(w, monday(6, 59))).toBe(true);
  });

  it('overnight window: outside', () => {
    const w: ScheduleWindow[] = [{ days: [1], from: '19:00', to: '07:00' }];
    expect(isWithinSchedule(w, monday(8))).toBe(false);
    expect(isWithinSchedule(w, monday(18))).toBe(false);
  });

  it('wrong day → false', () => {
    const w: ScheduleWindow[] = [{ days: [1], from: '09:00', to: '18:00' }]; // Monday
    // Tuesday = 2024-01-16
    const tuesday = new Date(2024, 0, 16, 12);
    expect(isWithinSchedule(w, tuesday)).toBe(false);
  });

  it('multiple windows: any match → true', () => {
    const w: ScheduleWindow[] = [
      { days: [1, 2, 3, 4, 5], from: '19:00', to: '07:00' },
      { days: [6, 0], from: '00:00', to: '23:59' },
    ];
    expect(isWithinSchedule(w, monday(22))).toBe(true);
  });
});
