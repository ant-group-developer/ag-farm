import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignClient } from './sign-client';

describe('SignClient.sign', () => {
  it('splits more than 100 ops into requests of at most 100 and keeps the results in order', async () => {
    const batches: string[][] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const ops = (JSON.parse(body) as { ops: { input: string }[] }).ops;
        batches.push(ops.map((o) => o.input));
        const results = ops.map((o) => ({
          op: 'get',
          input: o.input,
          url: `https://r2.example/${o.input.replace(':', '/')}`,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          size_bytes: null,
          content_type: null,
          cache_key: null,
          source: null,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const client = new SignClient(`http://127.0.0.1:${port}/sign`, () => 'ticket');
      const inputs = Array.from({ length: 250 }, (_, k) => `asset:a${k}`);
      const results = await client.sign(inputs.map((input) => ({ op: 'get' as const, input })));

      expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
      expect(results.map((r) => (r.op === 'get' ? r.input : null))).toEqual(inputs);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
