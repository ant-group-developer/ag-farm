import { z } from 'zod';
import { JobStatusSchema, JobTypeSchema, LaneSchema } from '@ag-farm/protocol';

export const CreateNodeSchema = z.strictObject({
  name: z.string().min(1).max(200),
  machine: z.string().max(200).default(''),
  kinds: z.array(JobTypeSchema).min(1),
});
export type CreateNodeDto = z.infer<typeof CreateNodeSchema>;

export const PatchNodeSchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  kinds: z.array(JobTypeSchema).min(1).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  schedule: z.unknown().optional(),
});
export type PatchNodeDto = z.infer<typeof PatchNodeSchema>;

export const CreateOwnerSchema = z.strictObject({
  id: z.string().min(1).max(40).regex(/^[a-z][a-z0-9-]*$/),
  sign_url: z.string().url(),
  allowed_types: z.array(JobTypeSchema).min(1),
  default_lane: LaneSchema.default('batch'),
});
export type CreateOwnerDto = z.infer<typeof CreateOwnerSchema>;

export const PatchOwnerSchema = z.strictObject({
  sign_url: z.string().url().optional(),
  allowed_types: z.array(JobTypeSchema).min(1).optional(),
  default_lane: LaneSchema.optional(),
});
export type PatchOwnerDto = z.infer<typeof PatchOwnerSchema>;

export const AdminListJobsQuerySchema = z.strictObject({
  status: z.string().max(200).optional(),
  type: z.string().max(200).optional(),
  owner: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  after: z.string().max(200).optional(),
});
export type AdminListJobsQuery = z.infer<typeof AdminListJobsQuerySchema>;
