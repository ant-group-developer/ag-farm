/** Unit tests: cursor encoding/decoding và backoff */

function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ u: updatedAt.toISOString(), i: id }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { updatedAt: string; id: string } | null {
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      u: string;
      i: string;
    };
    return { updatedAt: obj.u, id: obj.i };
  } catch {
    return null;
  }
}

function backoffMs(attempt: number): number {
  return Math.min(30_000 * Math.pow(2, attempt - 1), 15 * 60_000);
}

describe('cursor encoding', () => {
  it('round-trips correctly', () => {
    const date = new Date('2024-01-15T10:30:00.000Z');
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const cursor = encodeCursor(date, id);
    const decoded = decodeCursor(cursor);
    expect(decoded).not.toBeNull();
    expect(decoded!.updatedAt).toBe(date.toISOString());
    expect(decoded!.id).toBe(id);
  });

  it('returns null for invalid cursor', () => {
    expect(decodeCursor('not-valid-base64!!!!')).toBeNull();
    expect(decodeCursor('aW52YWxpZA')).toBeNull(); // "invalid" in base64, not JSON with u/i
  });
});

describe('backoff calculation', () => {
  it('attempt 1 = 30s', () => {
    expect(backoffMs(1)).toBe(30_000);
  });
  it('attempt 2 = 60s', () => {
    expect(backoffMs(2)).toBe(60_000);
  });
  it('attempt 3 = 120s', () => {
    expect(backoffMs(3)).toBe(120_000);
  });
  it('caps at 15 minutes', () => {
    expect(backoffMs(100)).toBe(15 * 60_000);
  });
});
