import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { APP_LANGUAGES, DEFAULT_LANGUAGE, readStoredLanguage } from './language';
import { en } from './locales/en';
import { vi } from './locales/vi';

void i18n.use(initReactI18next).init({
  resources: {
    vi: { translation: vi },
    en: { translation: en },
  },
  lng: readStoredLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: APP_LANGUAGES,
  interpolation: { escapeValue: false },
});

export default i18n;
