import { Auth0Provider, useAuth0 } from '@auth0/auth0-react';
import { Alert, Button, Spin, Typography } from 'antd';
import type { PropsWithChildren } from 'react';
import { useEffect } from 'react';
import { clearAccessTokenGetter, setAccessTokenGetter } from './auth-client';

const domain = import.meta.env.VITE_AUTH0_DOMAIN as string | undefined;
const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID as string | undefined;
const audience = import.meta.env.VITE_AUTH0_AUDIENCE as string | undefined;

function TokenBridge({ children }: PropsWithChildren) {
  const { getAccessTokenSilently } = useAuth0();

  useEffect(() => {
    setAccessTokenGetter(async () => {
      const token = await getAccessTokenSilently();
      if (!token) throw new Error('Auth0 did not return an access token');
      return token;
    });
    return clearAccessTokenGetter;
  }, [getAccessTokenSilently]);

  return <>{children}</>;
}

function AuthenticatedApp({ children }: PropsWithChildren) {
  const { isLoading, isAuthenticated, loginWithRedirect } = useAuth0();

  if (isLoading) {
    return <Spin fullscreen tip="Đang xác thực..." />;
  }

  if (!isAuthenticated) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
        }}
      >
        <Typography.Title level={3}>AG Farm Admin</Typography.Title>
        <Typography.Text type="secondary">
          Hệ thống quản lý máy worker và hàng việc — chỉ dành cho ADMIN.
        </Typography.Text>
        <Button type="primary" size="large" onClick={() => void loginWithRedirect()}>
          Đăng nhập
        </Button>
      </div>
    );
  }

  return <>{children}</>;
}

export function Auth0AppProvider({ children }: PropsWithChildren) {
  if (!domain || !clientId || !audience) {
    return (
      <Alert
        type="error"
        showIcon
        message="Thiếu cấu hình Auth0"
        description="Kiểm tra các biến môi trường VITE_AUTH0_DOMAIN, VITE_AUTH0_CLIENT_ID, VITE_AUTH0_AUDIENCE."
        style={{ maxWidth: 640, margin: '15vh auto' }}
      />
    );
  }

  return (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      cacheLocation="localstorage"
      useRefreshTokens
      authorizationParams={{
        audience,
        redirect_uri: window.location.origin,
      }}
    >
      <TokenBridge>
        <AuthenticatedApp>{children}</AuthenticatedApp>
      </TokenBridge>
    </Auth0Provider>
  );
}
