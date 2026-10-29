import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectLogs, defaultLogDirs, lineTime } from './node-logs';

const json = (time: string, msg: string) => JSON.stringify({ level: 'info', time, msg });

describe('node logs', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'node-logs-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads the time of a JSON worker line and of a [date time] line', () => {
    expect(lineTime(json('2026-10-23T04:39:43.000Z', 'x'))).toBe(Date.parse('2026-10-23T04:39:43.000Z'));
    expect(lineTime('[2026-10-23 11:42:01] Tai ffmpeg')).toBe(new Date('2026-10-23T11:42:01').getTime());
    expect(lineTime('    at Object.<anonymous> (worker.mjs:1:2)')).toBeNull();
  });

  it('finds the log folders from --config <roleDir>\\config.yaml', () => {
    const dirs = defaultLogDirs(['node', 'worker.mjs', '--config', join('C:', 'ag-farm', 'render', 'config.yaml')]);
    expect(dirs).toEqual([join('C:', 'ag-farm', 'render', 'logs'), join('C:', 'ag-farm', 'logs'), join('C:', 'ag-farm', 'updater')]);
    expect(defaultLogDirs(['node', 'worker.mjs'])).toEqual([]);
  });

  it('keeps the lines of a time range, a line without a time going with the line before it', async () => {
    const logs = join(root, 'render', 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'worker.log'), [
      json('2026-10-23T03:59:00.000Z', 'before'),
      json('2026-10-23T04:39:43.000Z', 'Job started'),
      'Error: lease lost',
      '    at stack line',
      json('2026-10-23T04:42:00.000Z', 'Lease lost'),
      json('2026-10-23T06:01:00.000Z', 'after'),
      '',
    ].join('\n'));
    writeFileSync(join(logs, 'notes.txt'), json('2026-10-23T04:40:00.000Z', 'not a .log'));
    const text = await collectLogs({ dirs: [logs, join(root, 'missing')], since: '2026-10-23T04:00:00.000Z', until: '2026-10-23T06:00:00.000Z' });
    expect(text).toContain(`===== ${join(logs, 'worker.log')} (4 lines) =====`);
    expect(text).toContain('Job started');
    expect(text).toContain('    at stack line');
    expect(text).toContain('Lease lost');
    expect(text).not.toContain('before');
    expect(text).not.toContain('after');
    expect(text).not.toContain('not a .log');
  });

  it('skips a file last written before the range; without a range, the end of each file', async () => {
    const logs = join(root, 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'worker.1.log'), json('2026-10-01T00:00:00.000Z', 'old file'));
    utimesSync(join(logs, 'worker.1.log'), new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));
    writeFileSync(join(logs, 'worker.log'), `${'a'.repeat(50)}\nfirst kept\nsecond kept\n`);
    expect(await collectLogs({ dirs: [logs], since: '2026-10-23T00:00:00.000Z', until: null })).not.toContain('worker.1.log');
    const tail = await collectLogs({ dirs: [logs], since: null, until: null, tailBytes: 30 });
    expect(tail).toContain('first kept\nsecond kept');
    expect(tail).not.toContain('aaaa');
  });

  it('past the size cap keeps the newest part', async () => {
    const logs = join(root, 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'worker.log'), Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'));
    const text = await collectLogs({ dirs: [logs], since: null, until: null, maxBytes: 300 });
    expect(text.startsWith('# (cut: only the last')).toBe(true);
    expect(text).toContain('line 199');
    expect(text).not.toContain('line 1\n');
  });
});
