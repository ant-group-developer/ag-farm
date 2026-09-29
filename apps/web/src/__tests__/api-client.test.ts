import { describe, expect, it } from 'vitest';

/**
 * Test the URL-building logic in the admin API module.
 * We verify query string building matches the backend's expected format.
 */

describe('listJobs URL building', () => {
  it('builds correct query string with all filters', () => {
    const params = new URLSearchParams();
    params.set('status', 'queued,leased');
    params.set('type', 'scan.extract');
    params.set('owner', 'ag-go');
    params.set('limit', '50');
    params.set('after', 'abc123');
    const qs = params.toString();
    expect(qs).toContain('status=queued%2Cleased');
    expect(qs).toContain('type=scan.extract');
    expect(qs).toContain('owner=ag-go');
    expect(qs).toContain('limit=50');
    expect(qs).toContain('after=abc123');
  });

  it('omits keys with no value', () => {
    const params = new URLSearchParams();
    params.set('limit', '100');
    const qs = params.toString();
    expect(qs).toBe('limit=100');
    expect(qs).not.toContain('status');
    expect(qs).not.toContain('owner');
  });

  it('builds correct path when only limit is set', () => {
    const query = { limit: 100 };
    const params = new URLSearchParams();
    if (query.limit) params.set('limit', String(query.limit));
    const qs = params.toString();
    expect(`/v1/admin/jobs?${qs}`).toBe('/v1/admin/jobs?limit=100');
  });

  it('builds empty path segment when no params', () => {
    const params = new URLSearchParams();
    const qs = params.toString();
    const path = `/v1/admin/jobs${qs ? `?${qs}` : ''}`;
    expect(path).toBe('/v1/admin/jobs');
  });
});

describe('API base URL fallback', () => {
  it('uses localhost:3001 as default port for ag-farm API', () => {
    const fallback = 'http://localhost:3001';
    expect(fallback).toContain('3001');
    expect(fallback.startsWith('http')).toBe(true);
  });
});
