import { describe, expect, it } from 'vitest';
import i18n from '../i18n/config';
import { jobTypeLabel, jobTypeOptions, laneLabel } from '../shared/lib/job-labels';
import { JOB_TYPES } from '../types/api';
import type { JobType, Lane } from '../types/api';

describe('jobTypeLabel', () => {
  it('mọi loại việc đều có tên dễ đọc ở cả hai ngôn ngữ', async () => {
    for (const lang of ['vi', 'en']) {
      await i18n.changeLanguage(lang);
      for (const type of JOB_TYPES) expect(jobTypeLabel(type)).not.toBe(type);
    }
    await i18n.changeLanguage('vi');
  });

  it('dịch theo ngôn ngữ đang dùng', async () => {
    await i18n.changeLanguage('vi');
    expect(jobTypeLabel('studio.render_final')).toBe('Studio: render bản cuối');
    await i18n.changeLanguage('en');
    expect(jobTypeLabel('studio.render_final')).toBe('Studio: final render');
    await i18n.changeLanguage('vi');
  });

  it('loại lạ thì trả nguyên giá trị', () => {
    expect(jobTypeLabel('scan.unknown' as JobType)).toBe('scan.unknown');
  });

  it('options giữ enum làm giá trị', () => {
    expect(jobTypeOptions(['scan.ai'])).toEqual([{ value: 'scan.ai', label: jobTypeLabel('scan.ai') }]);
  });
});

describe('laneLabel', () => {
  it('dịch lane và giữ nguyên lane lạ', async () => {
    await i18n.changeLanguage('vi');
    expect(laneLabel('interactive')).toBe('Tương tác');
    expect(laneLabel('batch')).toBe('Chạy nền');
    expect(laneLabel('other' as Lane)).toBe('other');
  });
});
