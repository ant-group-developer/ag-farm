/**
 * HubClient: gọi API worker của ag-farm (heartbeat, claim, progress, complete, fail).
 * Xác thực: Authorization: Node <token>
 * 409 → ném LeaseLostError (lease_lost | job_cancelled).
 */
import {
  AUTH_SCHEMES,
  ClaimRequestSchema,
  ClaimResponseSchema,
  CompleteRequestSchema,
  FailRequestSchema,
  HeartbeatRequestSchema,
  HeartbeatResponseSchema,
  LeaseLostResponseSchema,
  ProgressRequestSchema,
  ProgressResponseSchema,
  WORKER_API,
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
    return HeartbeatResponseSchema.parse(await res.json());
  }

  async claim(req: ClaimRequest): Promise<ClaimResponse> {
    const body = ClaimRequestSchema.parse(req);
    const res = await this.post(WORKER_API.claim, body);
    await this.checkStatus(res, WORKER_API.claim);
    return ClaimResponseSchema.parse(await res.json());
  }

  async progress(jobId: string, req: ProgressRequest): Promise<ProgressResponse> {
    const body = ProgressRequestSchema.parse(req);
    const path = WORKER_API.progress(jobId);
    const res = await this.post(path, body);
    await this.checkStatus(res, path);
    return ProgressResponseSchema.parse(await res.json());
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
        const data = LeaseLostResponseSchema.parse(await res.json());
        reason = data.error;
      } catch {
        // Ignore parse errors
      }
      throw new LeaseLostError(reason, `Lease lost on ${path}: ${reason}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Hub request ${path} failed: HTTP ${res.status} - ${text}`);
    }
  }
}
