/**
 * Unit tests for HubClient — verifies that both new enveloped responses
 * and legacy raw responses are accepted, and that lease_lost/job_cancelled
 * errors work via both envelope and legacy shape.
 */
import * as http from 'node:http';
import { HubClient, LeaseLostError } from './hub-client';

const REQ_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const TS = '2026-09-30T00:00:00.000Z';
const NODE_UUID = '123e4567-e89b-42d3-a456-426614174000';

function envelope(data: unknown) {
  return { data, requestId: REQ_ID, timestamp: TS, success: true, error: null };
}

function envelopeError(code: string, message: string) {
  return { data: null, requestId: REQ_ID, timestamp: TS, success: false, error: { code, message } };
}

function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

const HEARTBEAT_DATA = {
  node_id: NODE_UUID,
  server_time: new Date().toISOString(),
  status: 'active',
};

describe('HubClient — enveloped responses', () => {
  it('heartbeat: accepts enveloped response', async () => {
    const { server, url } = await startServer((req, res) => {
      jsonResponse(res, 200, envelope(HEARTBEAT_DATA));
    });
    try {
      const client = new HubClient(url, 'tok');
      const result = await client.heartbeat({
        agent_version: '1.0',
        kinds: ['scan.extract'],
        capabilities: {
          os: 'linux', cpu_cores: 2, ram_mb: 4096, gpus: [],
          engines: { ffmpeg: null, ollama_models: [], python: null },
        },
        free_slots: { cpu: 1, gpu: 0 },
        running_job_ids: [],
      });
      expect(result.node_id).toBe(NODE_UUID);
      expect(result.status).toBe('active');
    } finally {
      await closeServer(server);
    }
  });

  it('heartbeat: accepts raw (legacy) response', async () => {
    const { server, url } = await startServer((req, res) => {
      jsonResponse(res, 200, HEARTBEAT_DATA);
    });
    try {
      const client = new HubClient(url, 'tok');
      const result = await client.heartbeat({
        agent_version: '1.0',
        kinds: ['scan.extract'],
        capabilities: {
          os: 'linux', cpu_cores: 2, ram_mb: 4096, gpus: [],
          engines: { ffmpeg: null, ollama_models: [], python: null },
        },
        free_slots: { cpu: 1, gpu: 0 },
        running_job_ids: [],
      });
      expect(result.node_id).toBe(NODE_UUID);
    } finally {
      await closeServer(server);
    }
  });

  it('claim: accepts enveloped null-job response', async () => {
    const { server, url } = await startServer((req, res) => {
      jsonResponse(res, 200, envelope({ job: null }));
    });
    try {
      const client = new HubClient(url, 'tok');
      const result = await client.claim({
        kinds: ['scan.extract'],
        free_slots: { cpu: 1, gpu: 0 },
      });
      expect(result.job).toBeNull();
    } finally {
      await closeServer(server);
    }
  });
});

describe('HubClient — LeaseLost via envelope', () => {
  it('throws LeaseLostError with reason from new envelope 409', async () => {
    const { server, url } = await startServer((req, res) => {
      jsonResponse(res, 409, envelopeError('lease_lost', 'Lease lost'));
    });
    try {
      const client = new HubClient(url, 'tok');
      const err = await client.progress('job-1', {
        lease_token: 'lt-0000000000000000',
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LeaseLostError);
      expect((err as LeaseLostError).reason).toBe('lease_lost');
    } finally {
      await closeServer(server);
    }
  });

  it('throws LeaseLostError with reason from legacy 409', async () => {
    const { server, url } = await startServer((req, res) => {
      jsonResponse(res, 409, { error: 'job_cancelled', message: 'Job cancelled' });
    });
    try {
      const client = new HubClient(url, 'tok');
      const err = await client.progress('job-1', {
        lease_token: 'lt-0000000000000000',
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LeaseLostError);
      expect((err as LeaseLostError).reason).toBe('job_cancelled');
    } finally {
      await closeServer(server);
    }
  });

  it('defaults to lease_lost when 409 body is unparseable', async () => {
    const { server, url } = await startServer((req, res) => {
      res.writeHead(409, { 'Content-Type': 'text/plain' });
      res.end('not json');
    });
    try {
      const client = new HubClient(url, 'tok');
      const err = await client.progress('job-1', {
        lease_token: 'lt-0000000000000000',
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LeaseLostError);
      expect((err as LeaseLostError).reason).toBe('lease_lost');
    } finally {
      await closeServer(server);
    }
  });
});
