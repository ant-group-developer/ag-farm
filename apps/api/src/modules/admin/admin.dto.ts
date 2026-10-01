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
  .refine((v) => Boolean(v.ids || v.group_key || v.owner || v.types), {
    message: 'Pick jobs by ids, group_key, owner or types',
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
