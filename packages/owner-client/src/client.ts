import {
  JobView,
  JobViewSchema,
  ListJobsQuery,
  ListJobsResponse,
  ListJobsResponseSchema,
  RelativePathSchema,
  SubmitJobRequest,
  SubmitJobResponse,
  SubmitJobResponseSchema,
} from '@ag-farm/protocol';
import { FarmHttpError } from './error';

export type FarmOwnerClientOptions = {
  baseUrl: string;
  ownerKey: string;
  /** Custom fetch function (mặc định: global fetch) */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

/**
 * `resolveOutputKey`: ghép prefix và relativePath an toàn.
 * Kiểm path hợp lệ qua RelativePathSchema.
 */
export function resolveOutputKey(prefix: string, relativePath: string): string {
  // Validate relative path
  const result = RelativePathSchema.safeParse(relativePath);
  if (!result.success) {
    throw new Error(`Invalid relative path: ${relativePath}`);
  }
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${p}${result.data}`;
}

/** Client cho chủ job gửi và poll kết quả từ ag-farm */
export class FarmOwnerClient {
  private readonly baseUrl: string;
  private readonly ownerKey: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(opts: FarmOwnerClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.ownerKey = opts.ownerKey;
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private authHeader(): Record<string, string> {
    return { Authorization: `Owner ${this.ownerKey}` };
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      ...this.authHeader(),
      Accept: 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await this.fetchFn(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    let responseBody: unknown;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      responseBody = await res.json();
    } else {
      responseBody = await res.text();
    }

    if (!res.ok) {
      throw new FarmHttpError(res.status, responseBody);
    }

    return responseBody as T;
  }

  async submitJob(req: SubmitJobRequest): Promise<SubmitJobResponse> {
    const raw = await this.req<unknown>('POST', '/v1/owner/jobs', req);
    return SubmitJobResponseSchema.parse(raw);
  }

  async getJob(jobId: string): Promise<JobView> {
    const raw = await this.req<unknown>('GET', `/v1/owner/jobs/${encodeURIComponent(jobId)}`);
    return JobViewSchema.parse(raw);
  }

  async listJobs(query?: Partial<ListJobsQuery>): Promise<ListJobsResponse> {
    const params = new URLSearchParams();
    if (query?.status) params.set('status', query.status);
    if (query?.type) params.set('type', query.type);
    if (query?.unacked) params.set('unacked', query.unacked);
    if (query?.limit != null) params.set('limit', String(query.limit));
    if (query?.after) params.set('after', query.after);
    const qs = params.toString();
    const raw = await this.req<unknown>('GET', `/v1/owner/jobs${qs ? `?${qs}` : ''}`);
    return ListJobsResponseSchema.parse(raw);
  }

  async ackJob(jobId: string): Promise<JobView> {
    const raw = await this.req<unknown>(
      'POST',
      `/v1/owner/jobs/${encodeURIComponent(jobId)}/ack`,
    );
    return JobViewSchema.parse(raw);
  }

  async cancelJob(jobId: string): Promise<JobView> {
    const raw = await this.req<unknown>(
      'POST',
      `/v1/owner/jobs/${encodeURIComponent(jobId)}/cancel`,
    );
    return JobViewSchema.parse(raw);
  }
}
