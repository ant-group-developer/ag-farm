import { describe, expect, it } from 'vitest';
import { unwrapEnvelope } from './api-client';

describe('unwrapEnvelope', () => {
  it('returns data from the hub envelope and leaves raw bodies alone', () => {
    const nodes = [{ id: 'n-1', name: 'local-scan' }];
    expect(unwrapEnvelope({ data: nodes, requestId: 'r', timestamp: 't', success: true, error: null })).toEqual(nodes);
    expect(unwrapEnvelope(nodes)).toEqual(nodes);
    expect(unwrapEnvelope({ items: [] })).toEqual({ items: [] });
  });
});
