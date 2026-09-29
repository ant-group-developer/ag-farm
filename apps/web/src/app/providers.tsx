import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import viVN from 'antd/locale/vi_VN';
import type { PropsWithChildren } from 'react';
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
  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider locale={viVN} theme={theme}>
        <AntApp>
          <Auth0AppProvider>{children}</Auth0AppProvider>
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>
  );
}
