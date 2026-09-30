import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * TypeORM only runs the migrations listed in the DataSource: a migration file that is not listed passes every DB
 * test that lists it itself, then never runs in production (GĐ4 shipped exactly that).
 */
describe('migrations', () => {
  const dir = join(__dirname, 'migrations');
  const classes = readdirSync(dir)
    .filter((f) => /^\d+-.+\.ts$/.test(f) && !f.endsWith('.spec.ts'))
    .map((f) => /export class (\w+)/.exec(readFileSync(join(dir, f), 'utf8'))?.[1])
    .filter((c): c is string => !!c);

  it.each([
    ['data-source.ts', join(__dirname, 'data-source.ts')],
    ['app.module.ts', join(__dirname, '..', 'app.module.ts')],
  ])('are all registered in %s', (_name, file) => {
    const src = readFileSync(file, 'utf8');
    const list = /migrations:\s*\[([^\]]*)\]/.exec(src)?.[1] ?? '';
    expect(classes.length).toBeGreaterThan(0);
    for (const c of classes) expect(list).toContain(c);
  });
});
