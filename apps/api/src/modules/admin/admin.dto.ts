import { z } from 'zod';
import { JobStatusSchema, JobTypeSchema } from '@ag-farm/protocol';

export const CreateNodeSchema = z.strictObject({
  name: z.string().min(1).max(200),
  machine: z.string().max(200).default(''),
  kinds: z.array(JobTypeSchema).min(1),
});
export type CreateNodeDto = z.infer<typeof CreateNodeSchema>;

export const PatchNodeSchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  kinds: z.array(JobTypeSchema).min(1).optional(),
  allowed_kinds: z.array(JobTypeSchema).nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  schedule: z.unknown().optional(),
});
export type PatchNodeDto = z.infer<typeof PatchNodeSchema>;

export const CreateOwnerSchema = z.strictObject({
  id: z.string().min(1).max(40).regex(/^[a-z][a-z0-9-]*$/),
  sign_url: z.string().url(),
  allowed_types: z.array(JobTypeSchema).min(1),
});
export type CreateOwnerDto = z.infer<typeof CreateOwnerSchema>;

export const PatchOwnerSchema = z.strictObject({
  sign_url: z.string().url().optional(),
  allowed_types: z.array(JobTypeSchema).min(1).optional(),
});
export type PatchOwnerDto = z.infer<typeof PatchOwnerSchema>;

/** Chọn job cho tạm dừng / chạy tiếp / huỷ hàng loạt: cần ít nhất một điều kiện. */
export const AdminJobControlSchema = z
  .strictObject({
    ids: z.array(z.uuid()).min(1).max(1000).optional(),
    group_key: z.string().min(1).max(200).optional(),
    owner: z.string().min(1).max(40).optional(),
    types: z.array(JobTypeSchema).min(1).optional(),
    statuses: z.array(JobStatusSchema).min(1).optional(),
  })
  .refine((v) => Boolean(v.ids || v.group_key || v.owner || v.types || v.statuses), {
    message: 'Pick jobs by ids, group_key, owner, types or statuses',
  });
export type AdminJobControlDto = z.infer<typeof AdminJobControlSchema>;

const SortOrderSchema = z.enum(['asc', 'desc']).default('desc');

/** Query phân trang theo trang cho danh sách jobs. */
export const AdminListJobsQuerySchema = z.strictObject({
  // Phân trang
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  // Sắp xếp
  sortBy: z
    .enum(['createdAt', 'updatedAt', 'priority', 'status', 'type'])
    .default('createdAt'),
  sortOrder: SortOrderSchema,
  // Lọc
  status: z.string().max(500).optional(),
  type: z.string().max(500).optional(),
  owner: z.string().max(40).optional(),
  node: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
});
export type AdminListJobsQuery = z.infer<typeof AdminListJobsQuerySchema>;

/** Query phân trang theo trang cho danh sách nodes. */
export const AdminListNodesQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  sortBy: z.enum(['name', 'lastSeenAt', 'createdAt']).default('createdAt'),
  sortOrder: SortOrderSchema,
  status: z.enum(['active', 'disabled']).optional(),
  q: z.string().max(200).optional(),
});
export type AdminListNodesQuery = z.infer<typeof AdminListNodesQuerySchema>;

/** Query phân trang theo trang cho danh sách owners. */
export const AdminListOwnersQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  sortBy: z.enum(['name', 'createdAt']).default('createdAt'),
  sortOrder: SortOrderSchema,
  q: z.string().max(200).optional(),
});
export type AdminListOwnersQuery = z.infer<typeof AdminListOwnersQuerySchema>;

/** Đơn vị gom nhóm của biểu đồ theo thời gian. */
export const STATS_BUCKETS = ['hour', 'day', 'month'] as const;
export type StatsBucket = (typeof STATS_BUCKETS)[number];

/** Độ dài tối thiểu của một ô (tháng ngắn nhất 28 ngày) để chặn số ô trên biểu đồ. */
const BUCKET_MIN_MS: Record<StatsBucket, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  month: 28 * 86_400_000,
};
const MAX_STATS_BUCKETS = 1000;

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Query thống kê theo kỳ: [from, to) theo giờ tuyệt đối, gom nhóm theo `bucket` tính trong múi giờ `tz`
 * (để "ngày" và "tháng" khớp với lịch của người xem).
 */
export const AdminStatsPeriodQuerySchema = z
  .strictObject({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    bucket: z.enum(STATS_BUCKETS),
    tz: z.string().max(64).refine(isTimeZone, { message: 'Unknown time zone' }).default('UTC'),
  })
  .refine((v) => Date.parse(v.from) < Date.parse(v.to), {
    message: '`from` must be before `to`',
    path: ['to'],
  })
  .refine(
    (v) => (Date.parse(v.to) - Date.parse(v.from)) / BUCKET_MIN_MS[v.bucket] <= MAX_STATS_BUCKETS,
    { message: `Range is too long for this bucket (max ${MAX_STATS_BUCKETS} buckets)`, path: ['bucket'] },
  );
export type AdminStatsPeriodQuery = z.infer<typeof AdminStatsPeriodQuerySchema>;
