/**
 * Test download resume + multipart upload với fake HTTP server.
 */
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as os from 'node:os';
import { downloadToFile, uploadOutput } from './transfer';
import { SignClient } from './sign-client';

function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('downloadToFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(os.tmpdir(), `test-dl-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('downloads a full file', async () => {
    const content = Buffer.from('hello world');
    const { server, url } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(content.length) });
      res.end(content);
    });

    try {
      const dest = join(tmpDir, 'out.bin');
      await downloadToFile(`${url}/file`, dest);
      expect(readFileSync(dest)).toEqual(content);
    } finally {
      await closeServer(server);
    }
  });

  it('resumes download after mid-stream drop', async () => {
    const content = Buffer.allocUnsafe(100);
    for (let i = 0; i < 100; i++) content[i] = i;

    let requestCount = 0;
    const { server, url } = await startServer((req, res) => {
      requestCount++;
      const rangeHeader = req.headers['range'];

      if (rangeHeader) {
        // Resume request
        const m = rangeHeader.match(/bytes=(\d+)-/);
        const start = m ? parseInt(m[1]!, 10) : 0;
        const slice = content.slice(start);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${content.length - 1}/${content.length}`,
          'Content-Length': String(slice.length),
        });
        res.end(slice);
      } else if (requestCount === 1) {
        // Partial response then drop
        res.writeHead(200, { 'Content-Length': String(content.length) });
        res.write(content.slice(0, 50));
        res.destroy();
      } else {
        res.writeHead(200, { 'Content-Length': String(content.length) });
        res.end(content);
      }
    });

    try {
      const dest = join(tmpDir, 'resume.bin');
      await downloadToFile(`${url}/file`, dest);
      const result = readFileSync(dest);
      expect(result).toEqual(content);
    } finally {
      await closeServer(server);
    }
  });
});

describe('uploadOutput - multipart', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(os.tmpdir(), `test-up-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('multipart upload collects ETags and calls mp_complete', async () => {
    const parts: Array<{ num: number; size: number; etag: string }> = [];
    let completedParts: unknown = null;
    let uploadId: string | null = null;

    // Simple fake S3
    const { server: s3, url: s3Url } = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const partNum = new URL(req.url!, `http://h`).searchParams.get('partNumber');
        if (partNum) {
          const etag = `"etag-${partNum}"`;
          parts.push({ num: parseInt(partNum, 10), size: body.length, etag });
          res.writeHead(200, { ETag: etag });
          res.end();
        } else {
          res.writeHead(200);
          res.end();
        }
      });
    });

    // Fake sign server
    const { server: signSrv, url: signUrl } = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { ops: Array<Record<string, unknown>> };
        const results = body.ops.map((op: Record<string, unknown>) => {
          if (op['op'] === 'mp_create') {
            uploadId = 'test-upload-id';
            return { op: 'mp_create', output: op['output'], upload_id: uploadId };
          }
          if (op['op'] === 'mp_part_urls') {
            const partsArr = op['parts'] as number[];
            return {
              op: 'mp_part_urls',
              output: op['output'],
              upload_id: uploadId,
              expires_at: new Date(Date.now() + 3600000).toISOString(),
              urls: partsArr.map((n: number) => ({ part_number: n, url: `${s3Url}/part?partNumber=${n}` })),
            };
          }
          if (op['op'] === 'mp_complete') {
            completedParts = op['parts'];
            return { op: 'mp_complete', output: op['output'] };
          }
          if (op['op'] === 'put') {
            return {
              op: 'put',
              output: op['output'],
              url: `${s3Url}/single`,
              expires_at: new Date(Date.now() + 3600000).toISOString(),
              headers: { 'Content-Type': op['content_type'] as string },
            };
          }
          return { op: op['op'] };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }));
      });
    });

    try {
      // Create a file larger than MULTIPART_THRESHOLD_BYTES (64 MiB)
      // We'll use a mock instead by testing with a smaller file directly
      // For real multipart test, create 65 MiB file
      const largeFile = join(tmpDir, 'large.bin');
      const size = 65 * 1024 * 1024; // 65 MiB
      const buf = Buffer.alloc(size, 0xAB);
      writeFileSync(largeFile, buf);

      const signClient = new SignClient(signUrl, () => 'test-ticket');
      await uploadOutput(signClient, largeFile, 'output/large.bin', 'application/octet-stream');

      expect(completedParts).not.toBeNull();
      expect(parts.length).toBeGreaterThan(0);
      // All parts should have ETags
      const etags = parts.map((p) => p.etag);
      expect(etags.every((e) => e.startsWith('"etag-'))).toBe(true);
    } finally {
      await closeServer(s3);
      await closeServer(signSrv);
    }
  }, 30_000);
});

describe('uploadOutput - a part that fails now and then', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(os.tmpdir(), `test-up-retry-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  /** A fake bucket whose part `n` answers `fails[n]` (a status per try) before 200, and the sign server in front of it. */
  async function stores(fails: Record<number, number[]>) {
    const tries = new Map<number, number>();
    const state = { partUrlCalls: 0, aborted: false, completed: null as unknown };
    const { server: s3, url: s3Url } = await startServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const q = new URL(req.url!, 'http://h').searchParams;
        const n = Number(q.get('partNumber'));
        const t = tries.get(n) ?? 0;
        tries.set(n, t + 1);
        const status = fails[n]?.[t];
        if (status) { res.writeHead(status); res.end(); return; }
        res.writeHead(200, { ETag: `"etag-${n}-${q.get('v')}"` });
        res.end();
      });
    });
    const { server: signSrv, url: signUrl } = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { ops: Array<Record<string, unknown>> };
        const results = body.ops.map((op) => {
          if (op['op'] === 'mp_create') return { op: 'mp_create', output: op['output'], upload_id: 'u1' };
          if (op['op'] === 'mp_part_urls') {
            state.partUrlCalls++;
            const v = state.partUrlCalls;
            return {
              op: 'mp_part_urls', output: op['output'], upload_id: 'u1', expires_at: new Date(Date.now() + 3600000).toISOString(),
              urls: (op['parts'] as number[]).map((n) => ({ part_number: n, url: `${s3Url}/part?partNumber=${n}&v=${v}` })),
            };
          }
          if (op['op'] === 'mp_complete') { state.completed = op['parts']; return { op: 'mp_complete', output: op['output'] }; }
          if (op['op'] === 'mp_abort') { state.aborted = true; return { op: 'mp_abort', output: op['output'] }; }
          return { op: op['op'] };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }));
      });
    });
    const big = join(tmpDir, 'render.mp4');
    writeFileSync(big, Buffer.alloc(65 * 1024 * 1024, 7));
    return {
      tries, state, big, signClient: new SignClient(signUrl, () => 't'),
      close: async () => { await closeServer(s3); await closeServer(signSrv); },
    };
  }

  it('a part answered 502 is sent again (prod 21-22/10: one 502 failed a whole render)', async () => {
    const s = await stores({ 2: [502, 503] });
    try {
      await uploadOutput(s.signClient, s.big, 'out/render.mp4', 'video/mp4', { retryBackoffMs: 1 });
      expect(s.tries.get(2)).toBe(3);
      expect(s.state.completed).toEqual(expect.arrayContaining([{ part_number: 2, etag: 'etag-2-1' }]));
      expect(s.state.aborted).toBe(false);
    } finally {
      await s.close();
    }
  }, 30_000);

  it('an expired part URL (403) is signed again for that part', async () => {
    const s = await stores({ 1: [403] });
    try {
      await uploadOutput(s.signClient, s.big, 'out/render.mp4', 'video/mp4', { retryBackoffMs: 1 });
      expect(s.state.partUrlCalls).toBe(2);
      expect(s.state.completed).toEqual(expect.arrayContaining([{ part_number: 1, etag: 'etag-1-2' }]));
    } finally {
      await s.close();
    }
  }, 30_000);

  it('a part that keeps failing fails the upload after a few tries, and the upload is aborted', async () => {
    const s = await stores({ 1: [502, 502, 502, 502, 502, 502, 502] });
    try {
      await expect(uploadOutput(s.signClient, s.big, 'out/render.mp4', 'video/mp4', { retryBackoffMs: 1 }))
        .rejects.toThrow('Part 1 PUT failed: HTTP 502 (6 tries)');
      expect(s.tries.get(1)).toBe(6);
      expect(s.state.aborted).toBe(true);
    } finally {
      await s.close();
    }
  }, 30_000);

  it('a 4xx other than an expired URL is not tried again', async () => {
    const s = await stores({ 1: [400, 400] });
    try {
      await expect(uploadOutput(s.signClient, s.big, 'out/render.mp4', 'video/mp4', { retryBackoffMs: 1 })).rejects.toThrow('Part 1 PUT failed: HTTP 400');
      expect(s.tries.get(1)).toBe(1);
    } finally {
      await s.close();
    }
  }, 30_000);
});
