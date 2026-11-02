import { mkdirSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as os from 'node:os';
import { cleanStaleWorkDirs, markWorkDir } from './work-dir';

describe('cleanStaleWorkDirs', () => {
  let dir: string;
  beforeEach(() => {
    dir = join(os.tmpdir(), `work-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const job = (n: number) => `123e4567-e89b-42d3-a456-${String(n).padStart(12, '0')}`;

  it('removes job dirs whose worker is gone, keeps those of a worker still running and other files', () => {
    for (const n of [1, 2, 3]) mkdirSync(join(dir, job(n)));
    markWorkDir(join(dir, job(1)), 111); // dead
    markWorkDir(join(dir, job(2)), 222); // alive
    markWorkDir(join(dir, job(3))); // this process
    mkdirSync(join(dir, 'cache-like'));
    const removed = cleanStaleWorkDirs(dir, { isAlive: (pid) => pid === 222 });
    expect(removed).toEqual([job(1)]);
    expect(existsSync(join(dir, job(2)))).toBe(true);
    expect(existsSync(join(dir, job(3)))).toBe(true);
    expect(existsSync(join(dir, 'cache-like'))).toBe(true);
  });

  it('a dir without an owner (older worker) is removed only once a day old', () => {
    mkdirSync(join(dir, job(4)));
    mkdirSync(join(dir, job(5)));
    writeFileSync(join(dir, job(5), 'x'), '1');
    const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    utimesSync(join(dir, job(4)), old, old);
    expect(cleanStaleWorkDirs(dir)).toEqual([job(4)]);
  });

  it('a missing work_dir removes nothing', () => {
    expect(cleanStaleWorkDirs(join(dir, 'nope'))).toEqual([]);
  });
});
