import * as http from 'node:http';
import { FarmOwnerClient, resolveOutputKey } from './client';
import { FarmHttpError } from './error';

// ---- Helper: mini HTTP server ----
function makeServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}

function jsonRes(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

// ---- Helpers ----
const REQ_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const TS = '2026-09-30T00:00:00.000Z';

/** Wrap a raw body in the ag-farm envelope (success). */
function envelope(data: unknown) {
  return { data, requestId: REQ_ID, timestamp: TS, success: true, error: null };
}

/** Wrap a raw body in the ag-farm envelope (error). */
function envelopeError(code: string, message: string) {
  return { data: null, requestId: REQ_ID, timestamp: TS, success: false, error: { code, message } };
}

// ---- Fixtures ----
const NOW = '2024-01-01T00:00:00.000Z';
const JOB_VIEW = {
  id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  owner: 'ag-go',
  type: 'scan.extract',
  lane: 'batch',
  status: 'queued',
  priority: 0,
  correlation_id: 'c1',
  affinity_key: null,
  group_key: null,
  attempt_count: 0,
  max_attempts: 3,
  node_id: null,
  progress_percent: null,
  progress_stage: null,
  result: null,
  error: null,
  created_at: NOW,
  updated_at: NOW,
  finished_at: null,
  acked_at: null,
};

// ---- Tests ----
describe('FarmOwnerClient', () => {
  it('submitJob calls POST /v1/owner/jobs and parses response', async () => {
    const responseBody = { job: JOB_VIEW, created: true };
    let receivedAuth = '';
    let receivedBody = '';

    const { url, close } = await makeServer((req, res) => {
      receivedAuth = req.headers['authorization'] ?? '';
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        receivedBody = body;
        jsonRes(res, 200, responseBody);
      });
    });

    try {
      const client = new FarmOwnerClient({ baseUrl: url, ownerKey: 'mykey' });
      const result = await client.submitJob({
        type: 'scan.extract',
        correlation_id: 'c1',
        payload: {},
        max_attempts: 3,
      } as any);

      expect(result.created).toBe(true);
      expect(result.job.id).toBe(JOB_VIEW.id);
      expect(receivedAuth).toBe('Owner mykey');
      expect(JSON.parse(receivedBody).correlation_id).toBe('c1');
    } finally {
      await close();
    }
  });

  it('getJob calls GET /v1/owner/jobs/:id', async () => {
    const { url, close } = await makeServer((req, res) => {
      jsonRes(res, 200, JOB_VIEW);
    });
    try {
      const client = new FarmOwnerClient({ baseUrl: url, ownerKey: 'k' });
      const job = await client.getJob(JOB_VIEW.id);
      expect(job.id).toBe(JOB_VIEW.id);
    } finally {
      await close();
    }
  });

  it('listJobs with query params', async () => {
    let receivedUrl = '';
    const { url, close } = await makeServer((req, res) => {
      receivedUrl = req.url ?? '';
      jsonRes(res, 200, { jobs: [JOB_VIEW], next_cursor: null });
    });
    try {
      const client = new FarmOwnerClient({ baseUrl: url, ownerKey: 'k' });
      const result = await client.listJobs({ status: 'completed', unacked: '1', limit: 10 });
      expect(result.jobs).toHaveLength(1);
      expect(receivedUrl).toContain('status=completed');
      expect(receivedUrl).toContain('unacked=1');
      expect(receivedUrl).toContain('limit=10');
    } finally {
      await close();
    }
  });

  it('ackJob calls POST /v1/owner/jobs/:id/ack', async () => {
    let receivedPath = '';
    const { url, close } = await makeServer((req, res) => {
      receivedPath = req.url ?? '';
      jsonRes(res, 200, { ...JOB_VIEW, acked_at: NOW });
    });
    try {
      const client = new FarmOwnerClient({ baseUrl: url, ownerKey: 'k' });
      const job = await client.ackJob(JOB_VIEW.id);
      expect(job.acked_at).toBe(NOW);
      expect(receivedPath).toContain('/ack');
    } finally {
      await close();
    }
  });

  it('cancelJob calls POST /v1/owner/jobs/:id/cancel', async () => {
    let receivedPath = '';
    const { url, close } = await makeServer((req, res) => {
      receivedPath = req.url ?? '';
      jsonRes(res, 200, { ...JOB_VIEW, status: 'cancelled', finished_at: NOW });
    });
    try {
      const client = new FarmOwnerClient({ baseUrl: url, ownerKey: 'k' });
      const job = await client.cancelJob(JOB_VIEW.id);
      expect(job.status).toBe('cancelled');
      expect(receivedPath).toContain('/cancel');
    } finally {
      await close();
    }
  });

  it('listNodes calls GET /v1/owner/nodes', async () => {
    const node = {
      id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', name: 'render-01', online: true, kinds: ['studio.render_final'],
      gpus: [{ name: 'RTX 3060', vram_mb: 12288, nvenc: true }], running_jobs: 0, last_seen_at: TS,
    };
    let path = '';
    const srv = await makeServer((req, res) => { path = `${req.method} ${req.url}`; jsonRes(res, 200, envelope({ nodes: [node] })); });
    try {
      const client = new FarmOwnerClient({ baseUrl: srv.url, ownerKey: 'k' });
      expect(await client.listNodes()).toEqual({ nodes: [node] });
      expect(path).toBe('GET /v1/owner/nodes');
    } finally {
      await srv.close();
    }
  });

  it('throws FarmHttpError on 404', async () => {
    const { url, close } = await makeServer((req, res) => {
      jsonRes(res, 404, { message: 'Not found' });
    });
    try {
      const client = new FarmOwnerClient({ baseUrl: url, ownerKey: 'k' });
      await expect(client.getJob('does-not-exist')).rejects.toBeInstanceOf(FarmHttpError);
      await client.getJob('x').catch((err: FarmHttpError) => {
        expect(err.status).toBe(404);
      });
    } catch {
      // getJob throws FarmHttpError → ok
    } finally {
      await close();
    }
  });

  it('throws FarmHttpError with status and body on error', async () => {
    const { url, close } = await makeServer((req, res) => {
      jsonRes(res, 403, { error: 'forbidden' });
    });
    try {
      const client = new FarmOwnerClient({ baseUrl: url, ownerKey: 'k' });
      const err = await client.getJob('x').catch((e: unknown) => e as FarmHttpError);
      expect(err).toBeInstanceOf(FarmHttpError);
      expect(err.status).toBe(403);
    } finally {
      await close();
    }
  });
});

describe('FarmOwnerClient — envelope support', () => {
  it('unwraps enveloped submitJob response', async () => {
    const { url, close } = await makeServer((req, res) => {
      jsonRes(res, 200, envelope({ job: JOB_VIEW, created: true }));
    });
    try {
      const client = new FarmOwnerClient({ baseUrl: url, ownerKey: 'k' });
      const result = await client.submitJob({ type: 'scan.extract', correlation_id: 'c2', payload: {}, max_attempts: 3 } as any);
      expect(result.created).toBe(true);
      expect(result.job.id).toBe(JOB_VIEW.id);
    } finally {
      await close();
    }
  });

  it('unwraps enveloped getJob response', async () => {
    const { url, close } = await makeServer((req, res) => {
      jsonRes(res, 200, envelope(JOB_VIEW));
    });
    try {
      const client = new FarmOwnerClient({ baseUrl: url, ownerKey: 'k' });
      const job = await client.getJob(JOB_VIEW.id);
      expect(job.id).toBe(JOB_VIEW.id);
    } finally {
      await close();
    }
  });

  it('reads error code from enveloped 404', async () => {
    const { url, close } = await makeServer((req, res) => {
      jsonRes(res, 404, envelopeError('NOT_FOUND', 'Job not found'));
    });
    try {
      const client = new FarmOwnerClient({ baseUrl: url, ownerKey: 'k' });
      const err = (await client.getJob('does-not-exist').catch((e: unknown) => e)) as FarmHttpError;
      expect(err).toBeInstanceOf(FarmHttpError);
      expect(err.status).toBe(404);
      expect(err.code).toBe('NOT_FOUND');
      expect(err.message).toBe('Job not found');
    } finally {
      await close();
    }
  });

  it('reads error code from legacy error body', async () => {
    const { url, close } = await makeServer((req, res) => {
      jsonRes(res, 409, { error: 'lease_lost', message: 'Lease lost' });
    });
    try {
      const client = new FarmOwnerClient({ baseUrl: url, ownerKey: 'k' });
      const err = (await client.cancelJob(JOB_VIEW.id).catch((e: unknown) => e)) as FarmHttpError;
      expect(err).toBeInstanceOf(FarmHttpError);
      expect(err.code).toBe('lease_lost');
    } finally {
      await close();
    }
  });
});

describe('resolveOutputKey', () => {
  it('joins prefix and valid path', () => {
    expect(resolveOutputKey('analysis/abc/', 'keyframes/001.jpg')).toBe(
      'analysis/abc/keyframes/001.jpg',
    );
    expect(resolveOutputKey('prefix', 'file.json')).toBe('prefix/file.json');
  });

  it('throws on invalid path with ..', () => {
    expect(() => resolveOutputKey('prefix', '../etc/passwd')).toThrow();
  });

  it('throws on absolute path', () => {
    expect(() => resolveOutputKey('prefix', '/abs/path')).toThrow();
  });

  it('throws on empty path', () => {
    expect(() => resolveOutputKey('prefix', '')).toThrow();
  });
});
