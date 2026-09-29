/**
 * Unit tests cho OwnerKeyGuard – logic trích khoá.
 * Không import @nestjs/typeorm để tránh ESM incompatibility.
 */

function extractOwnerKey(auth: string | undefined): string | null {
  if (!auth) return null;
  const [scheme, key] = auth.trim().split(/\s+/, 2);
  return scheme?.toLowerCase() === 'owner' && key ? key : null;
}

describe('OwnerKeyGuard – key extraction', () => {
  it('extracts key from Owner scheme', () => {
    expect(extractOwnerKey('Owner secretkey')).toBe('secretkey');
  });

  it('returns null for Node scheme', () => {
    expect(extractOwnerKey('Node secretkey')).toBeNull();
  });

  it('returns null for Bearer scheme', () => {
    expect(extractOwnerKey('Bearer token')).toBeNull();
  });

  it('returns null for empty header', () => {
    expect(extractOwnerKey(undefined)).toBeNull();
    expect(extractOwnerKey('')).toBeNull();
  });
});
