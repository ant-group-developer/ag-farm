import { validateEnv } from './env';

const BASE = {
  DATABASE_URL: 'postgresql://x',
  AUTH0_ISSUER_URL: 'https://t.auth0.com/',
  AUTH0_AUDIENCE: 'aud',
  AUTH0_JWKS_URL: 'https://t.auth0.com/.well-known/jwks.json',
  AUTH0_ALLOWED_CLIENT_IDS: 'c',
  ACCOUNT_API_URL: 'http://account',
  FARM_TICKET_PRIVATE_KEY: 'p',
  FARM_TICKET_PUBLIC_KEY: 'q',
};

describe('env: worker releases', () => {
  it('no release key (or an empty one from .env.example): only admins publish', () => {
    expect(validateEnv({ ...BASE }).FARM_RELEASE_KEY).toBeUndefined();
    expect(validateEnv({ ...BASE, FARM_RELEASE_KEY: '' }).FARM_RELEASE_KEY).toBeUndefined();
  });

  it('a release key must be long', () => {
    expect(() => validateEnv({ ...BASE, FARM_RELEASE_KEY: 'short' })).toThrow(/FARM_RELEASE_KEY/);
    expect(validateEnv({ ...BASE, FARM_RELEASE_KEY: 'k'.repeat(64) }).FARM_RELEASE_KEY).toHaveLength(64);
  });

  it('upload size limit defaults to 1 GB', () => {
    expect(validateEnv({ ...BASE }).FARM_RELEASE_MAX_MB).toBe(1024);
    expect(validateEnv({ ...BASE, FARM_RELEASE_MAX_MB: '300' }).FARM_RELEASE_MAX_MB).toBe(300);
  });
});
