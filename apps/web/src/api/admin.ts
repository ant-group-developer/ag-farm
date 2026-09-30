import { api } from '../shared/lib/api-client';
import type {
  AdminListJobsQuery,
  CreateEnrollmentRequest,
  CreateEnrollmentResponse,
  CreateNodeRequest,
  CreateOwnerRequest,
  JobListResponse,
  JobView,
  NodeView,
  OwnerView,
  PatchNodeRequest,
  PatchOwnerRequest,
  StatsResponse,
} from '../types/api';

// ---- Nodes ----

export function listNodes(): Promise<NodeView[]> {
  return api.get<NodeView[]>('/v1/admin/nodes');
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

export function listJobs(query: AdminListJobsQuery): Promise<JobListResponse> {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.type) params.set('type', query.type);
  if (query.owner) params.set('owner', query.owner);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.after) params.set('after', query.after);
  const qs = params.toString();
  return api.get<JobListResponse>(`/v1/admin/jobs${qs ? `?${qs}` : ''}`);
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

// ---- Stats ----

export function getStats(): Promise<StatsResponse> {
  return api.get<StatsResponse>('/v1/admin/stats');
}

// ---- Owners ----

export function listOwners(): Promise<OwnerView[]> {
  return api.get<OwnerView[]>('/v1/admin/owners');
}

export function createOwner(body: CreateOwnerRequest): Promise<OwnerView & { key: string }> {
  return api.post<OwnerView & { key: string }>('/v1/admin/owners', body);
}

export function patchOwner(id: string, body: PatchOwnerRequest): Promise<OwnerView> {
  return api.patch<OwnerView>(`/v1/admin/owners/${id}`, body);
}
