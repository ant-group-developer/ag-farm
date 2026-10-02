import { describe, expect, it } from 'vitest';
import i18n from '../i18n/config';
import { en } from '../i18n/locales/en';
import { vi } from '../i18n/locales/vi';
import { statusLabel } from '../shared/lib/status';

function keysOf(obj: object, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'string' ? [`${prefix}${k}`] : keysOf(v as object, `${prefix}${k}.`),
  );
}

describe('i18n', () => {
  it('en có đủ và đúng các khoá như vi', () => {
    expect(keysOf(en).sort()).toEqual(keysOf(vi).sort());
  });

  it('mặc định tiếng Việt có dấu', async () => {
    await i18n.changeLanguage('vi');
    expect(statusLabel('queued')).toBe('Đang chờ');
    expect(i18n.t('nodes.deleteConfirm')).toBe('Xóa worker này?');
  });

  it('đổi sang tiếng Anh', async () => {
    await i18n.changeLanguage('en');
    expect(statusLabel('failed')).toBe('Failed');
    await i18n.changeLanguage('vi');
  });
});
