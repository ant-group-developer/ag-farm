/**
 * HubClient: gọi API worker của ag-farm (heartbeat, claim, progress, complete, fail).
 * Xác thực: Authorization: Node <token>
 * 409 → ném LeaseLostError (lease_lost | job_cancelled).
 *
 * Accepts both enveloped responses (new hub) and raw responses (legacy hub).
 */
import {
  AUTH_SCHEMES,
  ClaimRequestSchema,
  ClaimResponseSchema,
  CompleteRequestSchema,
  FailRequestSchema,
  HeartbeatRequestSchema,
  HeartbeatResponseSchema,
  ProgressRequestSchema,
  ProgressResponseSchema,
  WORKER_API,
  apiErrorOf,
  unwrapApiResponse,
} from '@ag-farm/protocol';
import type {
  ClaimRequest,
  ClaimResponse,
  CompleteRequest,
  FailRequest,
  HeartbeatRequest,
  HeartbeatResponse,
  ProgressRequest,
  ProgressResponse,
} from '@ag-farm/protocol';

export class LeaseLostError extends Error {
  constructor(
    readonly reason: 'lease_lost' | 'job_cancelled',
    message: string,
  ) {
    super(message);
    this.name = 'LeaseLostError';
  }
}

export class HubClient {
  constructor(
    private readonly hubUrl: string,
    private readonly token: string,
  ) {}

  async heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse> {
    const body = HeartbeatRequestSchema.parse(req);
    const res = await this.post(WORKER_API.heartbeat, body);
    await this.checkStatus(res, WORKER_API.heartbeat);
    return HeartbeatResponseSchema.parse(unwrapApiResponse(await res.json()));
  }

  async claim(req: ClaimRequest): Promise<ClaimResponse> {
    const body = ClaimRequestSchema.parse(req);
    const res = await this.post(WORKER_API.claim, body);
    await this.checkStatus(res, WORKER_API.claim);
    return ClaimResponseSchema.parse(unwrapApiResponse(await res.json()));
  }

  async progress(jobId: string, req: ProgressRequest): Promise<ProgressResponse> {
    const body = ProgressRequestSchema.parse(req);
    const path = WORKER_API.progress(jobId);
    const res = await this.post(path, body);
    await this.checkStatus(res, path);
    return ProgressResponseSchema.parse(unwrapApiResponse(await res.json()));
  }

  async complete(jobId: string, req: CompleteRequest): Promise<void> {
    const body = CompleteRequestSchema.parse(req);
    const path = WORKER_API.complete(jobId);
    const res = await this.post(path, body);
    await this.checkStatus(res, path);
  }

  async fail(jobId: string, req: FailRequest): Promise<void> {
    const body = FailRequestSchema.parse(req);
    const path = WORKER_API.fail(jobId);
    const res = await this.post(path, body);
    await this.checkStatus(res, path);
  }

  // ---- private ----

  private async post(path: string, body: unknown): Promise<Response> {
    const url = `${this.hubUrl.replace(/\/$/, '')}${path}`;
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `${AUTH_SCHEMES.node} ${this.token}`,
      },
      body: JSON.stringify(body),
    });
  }

  private async checkStatus(res: Response, path: string): Promise<void> {
    if (res.status === 409) {
      let reason: 'lease_lost' | 'job_cancelled' = 'lease_lost';
      try {
        const rawBody = await res.json();
        const err = apiErrorOf(rawBody);
        const code = err.code;
        if (code === 'lease_lost' || code === 'job_cancelled') {
          reason = code;
        }
      } catch {
        // Ignore parse errors — default reason is 'lease_lost'
      }
      throw new LeaseLostError(reason, `Lease lost on ${path}: ${reason}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Hub request ${path} failed: HTTP ${res.status} - ${text}`);
    }
  }
}
