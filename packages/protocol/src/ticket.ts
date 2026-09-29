import { createPrivateKey, createPublicKey, KeyObject, randomUUID, sign, verify } from 'node:crypto';
import { z } from 'zod';
import { JobTypeSchema, OwnerIdSchema } from './common';

/**
 * Vé job: JWT ký bằng Ed25519 (alg `EdDSA`) do ag-farm cấp lúc claim và mỗi lần progress.
 * Worker gửi vé tới `sign_url` của chủ job; chủ job kiểm bằng khoá công khai của ag-farm.
 * Không dùng thư viện JWT: chỉ cần `node:crypto`, giống cách ag-go-api tự kiểm token Auth0.
 */
export const TICKET_ISSUER = 'ag-farm';
export const TICKET_TYP = 'farm-ticket+jwt';

export const TicketClaimsSchema = z.strictObject({
  iss: z.literal(TICKET_ISSUER),
  /** Id node (worker) giữ lease. */
  sub: z.uuid(),
  jti: z.uuid(),
  job_id: z.uuid(),
  owner: OwnerIdSchema,
  type: JobTypeSchema,
  attempt: z.int().positive(),
  iat: z.int().positive(),
  exp: z.int().positive(),
});
export type TicketClaims = z.infer<typeof TicketClaimsSchema>;

export type TicketInput = Omit<TicketClaims, 'iss' | 'jti' | 'iat'> & { jti?: string; iat?: number };

type KeyInput = string | KeyObject;

function toPrivateKey(key: KeyInput): KeyObject {
  return typeof key === 'string' ? createPrivateKey(key) : key;
}

function toPublicKey(key: KeyInput): KeyObject {
  return typeof key === 'string' ? createPublicKey(key) : key;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function signTicket(input: TicketInput, privateKey: KeyInput): string {
  const claims: TicketClaims = TicketClaimsSchema.parse({
    iss: TICKET_ISSUER,
    jti: input.jti ?? randomUUID(),
    iat: input.iat ?? Math.floor(Date.now() / 1000),
    sub: input.sub,
    job_id: input.job_id,
    owner: input.owner,
    type: input.type,
    attempt: input.attempt,
    exp: input.exp,
  });
  const signingInput = `${encode({ alg: 'EdDSA', typ: TICKET_TYP })}.${encode(claims)}`;
  const signature = sign(null, Buffer.from(signingInput), toPrivateKey(privateKey));
  return `${signingInput}.${signature.toString('base64url')}`;
}

export class TicketError extends Error {
  constructor(
    readonly reason: 'malformed' | 'bad_header' | 'bad_signature' | 'bad_claims' | 'expired' | 'wrong_owner',
    message: string,
  ) {
    super(message);
    this.name = 'TicketError';
  }
}

export type VerifyTicketOptions = {
  /** Chủ job đang kiểm: vé của chủ khác bị từ chối. */
  owner: string;
  /** Giây epoch hiện tại; mặc định lấy đồng hồ máy. */
  now?: number;
  /** Cho lệch đồng hồ bao nhiêu giây. */
  clockToleranceSeconds?: number;
};

export function verifyTicket(token: string, publicKey: KeyInput, options: VerifyTicketOptions): TicketClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new TicketError('malformed', 'Ticket is not a JWT');
  }
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];

  let header: { alg?: unknown; typ?: unknown };
  let rawClaims: unknown;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
    rawClaims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'));
  } catch {
    throw new TicketError('malformed', 'Ticket is not valid base64url JSON');
  }
  if (header.alg !== 'EdDSA' || header.typ !== TICKET_TYP) {
    throw new TicketError('bad_header', 'Unsupported ticket header');
  }

  const signature = Buffer.from(encodedSignature, 'base64url');
  const ok = verify(null, Buffer.from(`${encodedHeader}.${encodedClaims}`), toPublicKey(publicKey), signature);
  if (!ok) {
    throw new TicketError('bad_signature', 'Ticket signature mismatch');
  }

  const parsed = TicketClaimsSchema.safeParse(rawClaims);
  if (!parsed.success) {
    throw new TicketError('bad_claims', 'Ticket claims are invalid');
  }
  const claims = parsed.data;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.clockToleranceSeconds ?? 30;
  if (claims.exp + tolerance <= now) {
    throw new TicketError('expired', 'Ticket is expired');
  }
  if (claims.owner !== options.owner) {
    throw new TicketError('wrong_owner', 'Ticket belongs to another owner');
  }
  return claims;
}

/** Đọc vé từ header `Authorization: Ticket <vé>`. */
export function extractTicket(authorization: string | undefined | null): string | null {
  if (!authorization) return null;
  const [scheme, token] = authorization.trim().split(/\s+/, 2);
  return scheme?.toLowerCase() === 'ticket' && token ? token : null;
}
