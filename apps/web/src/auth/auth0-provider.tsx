import { Auth0Provider, useAuth0 } from '@auth0/auth0-react';
import { Alert, Spin } from 'antd';
import type { PropsWithChildren } from 'react';
import { useEffect } from 'react';
import { clearAccessTokenGetter, setAccessTokenGetter } from './auth-client';
import { LoginScreen } from './login-screen';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
  const { isLoading, isAuthenticated, loginWithRedirect } = useAuth0();

  if (isLoading) {
    return <Spin fullscreen tip={t('auth.authenticating')} />;
  }

  if (!isAuthenticated) {
    return <LoginScreen onLogin={() => void loginWithRedirect()} />;
  }

  return <>{children}</>;
}

export function Auth0AppProvider({ children }: PropsWithChildren) {
  const { t } = useTranslation();
  if (!domain || !clientId || !audience) {
    return (
      <Alert
        type="error"
        showIcon
        message={t('auth.missingConfig')}
        description={t('auth.missingConfigDesc')}
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
