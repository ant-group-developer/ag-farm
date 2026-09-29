import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { createHash, createPublicKey, verify } from 'node:crypto';

type JwtHeader = { alg?: string; kid?: string; typ?: string };
type JwtClaims = {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  azp?: string;
  exp?: number;
  nbf?: number;
  [key: string]: unknown;
};
type JsonWebKey = { alg?: string; e: string; kid?: string; kty: string; n: string; use?: string };
type JwksResponse = { keys?: JsonWebKey[] };
type JwksCache = { expiresAt: number; keys: JsonWebKey[] };
type AdminCacheEntry = { expiresAt: number; isAdmin: boolean };

export const ACCOUNT_ME_CLIENT = 'ACCOUNT_ME_CLIENT';

/** Interface có thể inject stub trong test */
export interface AccountMeClient {
  getMe(accessToken: string): Promise<{ user_type?: string }>;
}

/** Guard Auth0 RS256 + Admin check theo user_type từ Account API */
@Injectable()
export class AdminGuard implements CanActivate {
  private jwksCache?: JwksCache;
  private readonly adminCache = new Map<string, AdminCacheEntry>();

  constructor(
    private readonly config: ConfigService,
    @Inject(ACCOUNT_ME_CLIENT) private readonly accountClient: AccountMeClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractBearer(request);
    if (!token) {
      throw new UnauthorizedException('Bearer token is required');
    }

    await this.verifyToken(token);

    const isAdmin = await this.checkAdmin(token);
    if (!isAdmin) {
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }

  private extractBearer(request: Request): string | null {
    const auth = request.header('authorization');
    if (!auth) return null;
    const [scheme, token] = auth.trim().split(/\s+/, 2);
    return scheme?.toLowerCase() === 'bearer' && token ? token : null;
  }

  private async verifyToken(token: string): Promise<JwtClaims> {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) throw new Error('Malformed JWT');
      const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];

      const header = this.decode<JwtHeader>(encodedHeader);
      const claims = this.decode<JwtClaims>(encodedClaims);

      if (header.alg !== 'RS256' || !header.kid) throw new Error('Unsupported JWT header');

      const issuer = this.config.getOrThrow<string>('AUTH0_ISSUER_URL').replace(/\/+$/, '');
      const audience = this.config.getOrThrow<string>('AUTH0_AUDIENCE');
      const allowedClients = this.config
        .getOrThrow<string>('AUTH0_ALLOWED_CLIENT_IDS')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const issOk = claims.iss?.replace(/\/+$/, '') === issuer;
      const audOk = Array.isArray(claims.aud)
        ? claims.aud.includes(audience)
        : claims.aud === audience;
      const azpOk = claims.azp != null && allowedClients.includes(claims.azp);

      if (!issOk || !audOk || !azpOk) throw new Error('JWT issuer/audience/azp mismatch');

      const now = Math.floor(Date.now() / 1000);
      if (typeof claims.exp !== 'number' || claims.exp <= now) throw new Error('JWT expired');
      if (typeof claims.nbf === 'number' && claims.nbf > now) throw new Error('JWT not active');

      const key = await this.getJwk(header.kid);
      const publicKey = createPublicKey({ key, format: 'jwk' });
      const signingInput = `${encodedHeader}.${encodedClaims}`;
      const sig = Buffer.from(encodedSignature, 'base64url');
      if (!verify('RSA-SHA256', Buffer.from(signingInput), publicKey, sig)) {
        throw new Error('JWT signature mismatch');
      }

      return claims;
    } catch {
      throw new UnauthorizedException('Invalid access token');
    }
  }

  private async checkAdmin(token: string): Promise<boolean> {
    const cacheKey = createHash('sha256').update(token).digest('hex');
    const now = Date.now();
    const cached = this.adminCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.isAdmin;

    const me = await this.accountClient.getMe(token);
    const isAdmin = me.user_type === 'ADMIN';
    this.adminCache.set(cacheKey, { expiresAt: now + 60_000, isAdmin });
    return isAdmin;
  }

  private async getJwk(kid: string): Promise<JsonWebKey> {
    const now = Date.now();
    if (!this.jwksCache || this.jwksCache.expiresAt <= now) {
      const jwksUrl = this.config.getOrThrow<string>('AUTH0_JWKS_URL');
      const res = await fetch(jwksUrl, {
        signal: AbortSignal.timeout(5000),
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`JWKS request failed: ${res.status}`);
      const body = (await res.json()) as JwksResponse;
      this.jwksCache = { expiresAt: now + 5 * 60_000, keys: body.keys ?? [] };
    }
    const key = this.jwksCache.keys.find((k) => k.kid === kid && k.kty === 'RSA');
    if (!key) throw new Error('Signing key not found');
    return key;
  }

  private decode<T>(value: string): T {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
  }
}

/** Triển khai mặc định gọi Account API /v2/users/me */
@Injectable()
export class AccountMeClientImpl implements AccountMeClient {
  constructor(private readonly config: ConfigService) {}

  async getMe(accessToken: string): Promise<{ user_type?: string }> {
    const baseUrl = this.config.getOrThrow<string>('ACCOUNT_API_URL').replace(/\/+$/, '');
    const res = await fetch(`${baseUrl}/v2/users/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Account API /v2/users/me failed: ${res.status}`);
    const body = (await res.json()) as { data?: { user_type?: string } };
    return body.data ?? {};
  }
}
