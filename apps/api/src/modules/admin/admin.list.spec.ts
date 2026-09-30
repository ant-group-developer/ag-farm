import {
  AdminListJobsQuerySchema,
  AdminListNodesQuerySchema,
  AdminListOwnersQuerySchema,
} from './admin.dto';

describe('AdminListJobsQuerySchema', () => {
  it('dùng giá trị mặc định khi không truyền gì', () => {
    const result = AdminListJobsQuerySchema.parse({});
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.sortBy).toBe('createdAt');
    expect(result.sortOrder).toBe('desc');
  });

  it('chấp nhận bộ lọc hợp lệ', () => {
    const result = AdminListJobsQuerySchema.parse({
      page: '2',
      pageSize: '50',
      sortBy: 'priority',
      sortOrder: 'asc',
      status: 'queued,leased',
      type: 'scan.extract',
      owner: 'ag-go',
      q: 'abc',
    });
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(50);
    expect(result.sortBy).toBe('priority');
    expect(result.sortOrder).toBe('asc');
    expect(result.status).toBe('queued,leased');
    expect(result.owner).toBe('ag-go');
    expect(result.q).toBe('abc');
  });

  it('từ chối pageSize > 200', () => {
    expect(() => AdminListJobsQuerySchema.parse({ pageSize: '201' })).toThrow();
  });

  it('từ chối sortBy không hợp lệ', () => {
    expect(() => AdminListJobsQuerySchema.parse({ sortBy: 'invalid_field' })).toThrow();
  });

  it('từ chối sortOrder không hợp lệ', () => {
    expect(() => AdminListJobsQuerySchema.parse({ sortOrder: 'random' })).toThrow();
  });

  it('từ chối page < 1', () => {
    expect(() => AdminListJobsQuerySchema.parse({ page: '0' })).toThrow();
  });
});

describe('AdminListNodesQuerySchema', () => {
  it('dùng giá trị mặc định', () => {
    const result = AdminListNodesQuerySchema.parse({});
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.sortBy).toBe('createdAt');
    expect(result.sortOrder).toBe('desc');
  });

  it('chấp nhận lọc theo status', () => {
    const result = AdminListNodesQuerySchema.parse({ status: 'active' });
    expect(result.status).toBe('active');
  });

  it('từ chối status không hợp lệ', () => {
    expect(() => AdminListNodesQuerySchema.parse({ status: 'unknown' })).toThrow();
  });
});

describe('AdminListOwnersQuerySchema', () => {
  it('dùng giá trị mặc định', () => {
    const result = AdminListOwnersQuerySchema.parse({});
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.sortBy).toBe('createdAt');
  });

  it('từ chối pageSize vượt max', () => {
    expect(() => AdminListOwnersQuerySchema.parse({ pageSize: '300' })).toThrow();
  });
});
