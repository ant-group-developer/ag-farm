import { randomUUID } from 'node:crypto';
import { AdminJobControlSchema } from './admin.dto';

describe('AdminJobControlSchema', () => {
  it('chọn job theo trạng thái thôi cũng được (nút "Tạm dừng tất cả theo bộ lọc" khi chưa lọc gì)', () => {
    expect(AdminJobControlSchema.safeParse({ statuses: ['queued', 'leased'] }).success).toBe(true);
  });

  it('chọn theo ids, group_key, owner, types', () => {
    expect(AdminJobControlSchema.safeParse({ ids: [randomUUID()] }).success).toBe(true);
    expect(AdminJobControlSchema.safeParse({ group_key: 'batch:1' }).success).toBe(true);
    expect(AdminJobControlSchema.safeParse({ owner: 'studio' }).success).toBe(true);
    expect(AdminJobControlSchema.safeParse({ types: ['studio.transcribe'] }).success).toBe(true);
  });

  it('không điều kiện nào thì từ chối', () => {
    expect(AdminJobControlSchema.safeParse({}).success).toBe(false);
  });
});
