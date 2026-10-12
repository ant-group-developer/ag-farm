// Test phần phát hành của package-release.mjs (không đóng gói thật):
//   node --test tools/worker-installer/test/package-release.test.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { finishRelease, publishDirFromArgv, publishOptionsFromArgv, uploadRelease } from '../package-release.mjs';

const KEY = 'test-release-key-0000000000000000000000';

describe('argv', () => {
  it('--publish --upload <hub> uploads, does not take --upload as a folder', () => {
    const argv = ['node', 'release.mjs', '--publish', '--upload', 'https://hub'];
    assert.equal(publishDirFromArgv(argv), null);
    assert.deepEqual(publishOptionsFromArgv(argv), { publishDir: null, uploadUrl: 'https://hub', keyEnv: 'FARM_RELEASE_KEY' });
  });

  it('--publish <dir> still copies into a folder', () => {
    assert.deepEqual(publishOptionsFromArgv(['node', 'r', '--publish', 'E:/rel']), { publishDir: 'E:/rel', uploadUrl: null, keyEnv: 'FARM_RELEASE_KEY' });
  });

  it('--key-env names another variable; --upload without a hub is an error', () => {
    assert.equal(publishOptionsFromArgv(['node', 'r', '--upload', 'https://hub', '--key-env', 'FARM_DEV_KEY']).keyEnv, 'FARM_DEV_KEY');
    assert.throws(() => publishOptionsFromArgv(['node', 'r', '--upload']), /--upload/);
    assert.deepEqual(publishOptionsFromArgv(['node', 'r']), { publishDir: null, uploadUrl: null, keyEnv: 'FARM_RELEASE_KEY' });
  });
});

describe('uploadRelease', () => {
  let server;
  let url;
  let last;
  let reply;
  const dir = mkdtempSync(join(tmpdir(), 'ag-upload-'));
  const zip = join(dir, 'ag-render-worker-0.9.1.zip');
  writeFileSync(zip, 'PK fake zip body');

  before(async () => {
    server = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        last = { method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body: Buffer.concat(chunks).toString() };
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('posts the zip and fields with the release key, returns what the hub saved', async () => {
    const entry = { version: '0.9.1', file: 'ag-render-worker-0.9.1.zip', sha256: 'a'.repeat(64), size_bytes: 16 };
    reply = { status: 201, body: { data: entry, success: true, error: null, requestId: 'r', timestamp: 't' } };
    const got = await uploadRelease({ hubUrl: `${url}/`, zipPath: zip, packageName: 'ag-render-worker', version: '0.9.1', sha256: 'a'.repeat(64), builtAt: '2026-10-13T00:00:00.000Z', key: KEY });
    assert.deepEqual(got, entry);
    assert.equal(last.method, 'POST');
    assert.equal(last.url, '/v1/admin/releases');
    assert.equal(last.auth, `Release ${KEY}`);
    assert.match(last.type, /^multipart\/form-data; boundary=/);
    for (const part of ['name="package"', 'ag-render-worker', 'name="version"', '0.9.1', 'name="sha256"', 'name="built_at"', 'filename="ag-render-worker-0.9.1.zip"', 'PK fake zip body']) {
      assert.ok(last.body.includes(part), `multipart has ${part}`);
    }
  });

  it('a refusal says the hub reason and never the key', async () => {
    reply = { status: 409, body: { data: null, success: false, error: { code: 'version_not_newer', message: 'ag-render-worker 0.9.1 is not newer than the published 0.9.1' } } };
    await assert.rejects(
      uploadRelease({ hubUrl: url, zipPath: zip, packageName: 'ag-render-worker', version: '0.9.1', sha256: 'a'.repeat(64), key: KEY }),
      (err) => {
        assert.match(err.message, /HTTP 409 version_not_newer - ag-render-worker 0\.9\.1 is not newer/);
        assert.ok(!err.message.includes(KEY));
        return true;
      },
    );
  });
});

describe('finishRelease', () => {
  it('uploading without the key variable stops before packaging, naming only the variable', async () => {
    const name = 'AG_TEST_RELEASE_KEY_UNSET';
    delete process.env[name];
    await assert.rejects(
      finishRelease({ repoRoot: 'x', releaseRoot: 'x', name: 'x', packageName: 'ag-render-worker', version: '0.9.1', uploadUrl: 'https://hub', keyEnv: name }),
      new RegExp(`Thieu bien moi truong ${name}`),
    );
  });
});
