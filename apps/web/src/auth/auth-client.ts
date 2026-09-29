type AccessTokenGetter = () => Promise<string>;

let accessTokenGetter: AccessTokenGetter | undefined;

export function setAccessTokenGetter(getter: AccessTokenGetter): void {
  accessTokenGetter = getter;
}

export function clearAccessTokenGetter(): void {
  accessTokenGetter = undefined;
}

export async function getAccessToken(): Promise<string> {
  if (!accessTokenGetter) {
    throw new Error('Auth0 access token provider is not initialized');
  }
  return accessTokenGetter();
}
