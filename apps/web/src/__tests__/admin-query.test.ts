/**
 * Tests for the admin API query param building logic.
 */

import { describe, expect, it } from 'vitest';

/** toParams from api/admin.ts — replicated here for unit testing. */
function toParams(obj: Record<string, string | number | boolean | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

describe('admin query param serialisation', () => {
  it('builds empty string when all values are undefined/null', () => {
    expect(toParams({ page: undefined, pageSize: null })).toBe('');
  });

  it('serialises page and pageSize correctly', () => {
    const qs = toParams({ page: 2, pageSize: 50 });
    expect(qs).toContain('page=2');
    expect(qs).toContain('pageSize=50');
  });

  it('serialises sort params', () => {
    const qs = toParams({ sortBy: 'priority', sortOrder: 'asc' });
    expect(qs).toContain('sortBy=priority');
    expect(qs).toContain('sortOrder=asc');
  });

  it('serialises filter params, omits undefined filters', () => {
    const qs = toParams({ status: 'queued,leased', type: undefined, owner: 'ag-go' });
    expect(qs).toContain('status=queued%2Cleased');
    expect(qs).toContain('owner=ag-go');
    expect(qs).not.toContain('type');
  });

  it('maps query object to correct URL for jobs list', () => {
    const query = {
      page: 1,
      pageSize: 20,
      sortBy: 'createdAt',
      sortOrder: 'desc',
      status: 'queued',
      type: undefined,
      owner: undefined,
      q: undefined,
    };
    const url = `/v1/admin/jobs${toParams(query as Record<string, string | number | boolean | undefined | null>)}`;
    expect(url).toContain('/v1/admin/jobs?');
    expect(url).toContain('page=1');
    expect(url).toContain('pageSize=20');
    expect(url).toContain('sortBy=createdAt');
    expect(url).toContain('sortOrder=desc');
    expect(url).toContain('status=queued');
    expect(url).not.toContain('type=');
    expect(url).not.toContain('owner=');
    expect(url).not.toContain('q=');
  });
});

describe('bulk action selector building', () => {
  /**
   * Simplified version of the bulk action logic in JobsPage.
   * Given the current filter state, builds the `body` for pauseJobs/resumeJobs/cancelJobs.
   */
  function buildPauseAllBody(filters: {
    status?: string;
    type?: string;
    owner?: string;
  }): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (filters.status) body.statuses = filters.status.split(',').filter(Boolean);
    if (filters.type) body.types = filters.type.split(',').filter(Boolean);
    if (filters.owner) body.owner = filters.owner;
    if (!body.statuses && !body.types && !body.owner) {
      body.statuses = ['queued', 'leased'];
    }
    return body;
  }

  it('uses queued+leased as fallback when no filters are active', () => {
    const body = buildPauseAllBody({});
    expect(body).toEqual({ statuses: ['queued', 'leased'] });
  });

  it('uses status filter when provided', () => {
    const body = buildPauseAllBody({ status: 'queued,leased' });
    expect(body.statuses).toEqual(['queued', 'leased']);
  });

  it('uses type filter when provided', () => {
    const body = buildPauseAllBody({ type: 'scan.extract' });
    expect(body.types).toEqual(['scan.extract']);
  });

  it('uses owner filter when provided', () => {
    const body = buildPauseAllBody({ owner: 'ag-go' });
    expect(body.owner).toBe('ag-go');
  });

  it('combines multiple filters', () => {
    const body = buildPauseAllBody({ status: 'queued', owner: 'studio' });
    expect(body.statuses).toEqual(['queued']);
    expect(body.owner).toBe('studio');
  });
});
