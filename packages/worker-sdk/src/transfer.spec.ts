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
