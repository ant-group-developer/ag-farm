import i18n from 'i18next';

export const APP_LANGUAGES = ['vi', 'en'] as const;
export type AppLanguage = (typeof APP_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: AppLanguage = 'vi';

/** Tên gốc của từng ngôn ngữ, không dịch để ai cũng tìm được ngôn ngữ của mình. */
export const LANGUAGE_NAMES: Record<AppLanguage, string> = {
  vi: 'Tiếng Việt',
  en: 'English',
};

const LANGUAGE_STORAGE_KEY = 'ag-farm.language';

function isAppLanguage(value: unknown): value is AppLanguage {
  return APP_LANGUAGES.includes(value as AppLanguage);
}

export function readStoredLanguage(): AppLanguage {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isAppLanguage(stored) ? stored : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export function currentLanguage(): AppLanguage {
  return isAppLanguage(i18n.resolvedLanguage) ? i18n.resolvedLanguage : DEFAULT_LANGUAGE;
}

/** Đổi ngôn ngữ giao diện và nhớ lựa chọn cho lần sau. */
export async function changeLanguage(language: AppLanguage): Promise<void> {
  await i18n.changeLanguage(language);
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Không có storage (chế độ riêng tư): lựa chọn chỉ giữ trong phiên này.
  }
}

/** Định dạng ngày giờ theo ngôn ngữ đang dùng. */
export function formatDateTime(value: string | Date): string {
  return new Date(value).toLocaleString(currentLanguage() === 'vi' ? 'vi-VN' : 'en-US');
}
