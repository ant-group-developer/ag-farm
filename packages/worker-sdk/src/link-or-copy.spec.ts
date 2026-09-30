import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkOrCopy } from './worker';

describe('linkOrCopy', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'link-or-copy-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('hard-links a cached file into the job dir on the same volume', () => {
    const src = join(dir, 'cached.mp4');
    const dest = join(dir, 'job', '..', 'input.mp4');
    writeFileSync(src, 'video bytes');
    linkOrCopy(src, dest);
    expect(readFileSync(dest, 'utf8')).toBe('video bytes');
    expect(statSync(src).nlink).toBe(2);
  });

  it('replaces a file left at the destination by an earlier attempt', () => {
    const src = join(dir, 'cached.mp4');
    const dest = join(dir, 'input.mp4');
    writeFileSync(src, 'new');
    writeFileSync(dest, 'stale');
    linkOrCopy(src, dest);
    expect(readFileSync(dest, 'utf8')).toBe('new');
  });

  it('keeps the job copy when the cache evicts its file', () => {
    const src = join(dir, 'cached.mp4');
    const dest = join(dir, 'input.mp4');
    writeFileSync(src, 'kept');
    linkOrCopy(src, dest);
    rmSync(src);
    expect(readFileSync(dest, 'utf8')).toBe('kept');
  });
});
