import { api } from '../shared/lib/api-client';
import type {
  AdminListJobsQuery,
  AdminListNodesQuery,
  AdminListOwnersQuery,
  CreateEnrollmentRequest,
  CreateEnrollmentResponse,
  CreateNodeRequest,
  CreateOwnerRequest,
  JobView,
  NodeView,
  OwnerView,
  PagedResponse,
  PatchNodeRequest,
  PatchOwnerRequest,
  StatsResponse,
} from '../types/api';

/** Serialize a plain object as URLSearchParams, omitting undefined/null values. */
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

// ---- Nodes ----

export function listNodes(query: AdminListNodesQuery = {}): Promise<PagedResponse<NodeView>> {
  return api.get<PagedResponse<NodeView>>(`/v1/admin/nodes${toParams(query as Record<string, string | number | boolean | undefined | null>)}`);
}

export function createNode(body: CreateNodeRequest): Promise<NodeView & { token: string }> {
  return api.post<NodeView & { token: string }>('/v1/admin/nodes', body);
}

export function createEnrollment(body: CreateEnrollmentRequest): Promise<CreateEnrollmentResponse> {
  return api.post<CreateEnrollmentResponse>('/v1/admin/enrollments', body);
}

export function patchNode(id: string, body: PatchNodeRequest): Promise<NodeView> {
  return api.patch<NodeView>(`/v1/admin/nodes/${id}`, body);
}

export function deleteNode(id: string): Promise<void> {
  return api.delete(`/v1/admin/nodes/${id}`);
}

// ---- Jobs ----

export function listJobs(query: AdminListJobsQuery = {}): Promise<PagedResponse<JobView>> {
  return api.get<PagedResponse<JobView>>(`/v1/admin/jobs${toParams(query as Record<string, string | number | boolean | undefined | null>)}`);
}

export function getJob(id: string): Promise<JobView> {
  return api.get<JobView>(`/v1/admin/jobs/${id}`);
}

export function retryJob(id: string): Promise<JobView> {
  return api.post<JobView>(`/v1/admin/jobs/${id}/retry`);
}

export function cancelJob(id: string): Promise<JobView> {
  return api.post<JobView>(`/v1/admin/jobs/${id}/cancel`);
}

export function pauseJobs(body: Record<string, unknown>): Promise<{ affected: number }> {
  return api.post<{ affected: number }>('/v1/admin/jobs/pause', body);
}

export function resumeJobs(body: Record<string, unknown>): Promise<{ affected: number }> {
  return api.post<{ affected: number }>('/v1/admin/jobs/resume', body);
}

export function cancelJobs(body: Record<string, unknown>): Promise<{ affected: number }> {
  return api.post<{ affected: number }>('/v1/admin/jobs/cancel', body);
}

// ---- Stats ----

export function getStats(): Promise<StatsResponse> {
  return api.get<StatsResponse>('/v1/admin/stats');
}

// ---- Owners ----

export function listOwners(query: AdminListOwnersQuery = {}): Promise<PagedResponse<OwnerView>> {
  return api.get<PagedResponse<OwnerView>>(`/v1/admin/owners${toParams(query as Record<string, string | number | boolean | undefined | null>)}`);
}

export function createOwner(body: CreateOwnerRequest): Promise<OwnerView & { key: string }> {
  return api.post<OwnerView & { key: string }>('/v1/admin/owners', body);
}

export function patchOwner(id: string, body: PatchOwnerRequest): Promise<OwnerView> {
  return api.patch<OwnerView>(`/v1/admin/owners/${id}`, body);
}
