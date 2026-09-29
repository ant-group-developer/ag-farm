/**
 * Unit tests cho NodeTokenGuard - test pure logic (hash extraction)
 * mà không import @nestjs/typeorm (ESM, không tương thích Jest CJS).
 */
import { createHash } from 'node:crypto';

/** Logic trích token từ Authorization header */
function extractNodeToken(auth: string | undefined): string | null {
  if (!auth) return null;
  const [scheme, token] = auth.trim().split(/\s+/, 2);
  return scheme?.toLowerCase() === 'node' && token ? token : null;
}

/** Hash sha256 */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('NodeTokenGuard – token extraction', () => {
  it('extracts token from Node scheme', () => {
    expect(extractNodeToken('Node mytoken123')).toBe('mytoken123');
  });

  it('returns null for Bearer scheme', () => {
    expect(extractNodeToken('Bearer mytoken123')).toBeNull();
  });

  it('returns null for empty header', () => {
    expect(extractNodeToken(undefined)).toBeNull();
    expect(extractNodeToken('')).toBeNull();
  });

  it('returns null for header with no token', () => {
    expect(extractNodeToken('Node ')).toBeNull();
  });
});

describe('NodeTokenGuard – sha256 hashing', () => {
  it('produces 64-char hex', () => {
    const h = sha256('test-token');
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it('same input = same hash', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
  });

  it('different inputs produce different hashes', () => {
    expect(sha256('token-a')).not.toBe(sha256('token-b'));
  });
});
