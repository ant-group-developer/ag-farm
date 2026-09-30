import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import enUS from 'antd/locale/en_US';
import viVN from 'antd/locale/vi_VN';
import type { PropsWithChildren } from 'react';
import { useTranslation } from 'react-i18next';
import { Auth0AppProvider } from '../auth/auth0-provider';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: 1,
    },
  },
});

const theme = {
  token: {
    colorPrimary: '#1677ff',
    borderRadius: 6,
  },
};

export function AppProviders({ children }: PropsWithChildren) {
  // Re-render khi đổi ngôn ngữ để locale của antd (lịch, phân trang…) đổi theo.
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage === 'en' ? enUS : viVN;
  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider locale={locale} theme={theme}>
        <AntApp>
          <Auth0AppProvider>{children}</Auth0AppProvider>
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>
  );
}
