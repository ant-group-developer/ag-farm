import { DataSource } from 'typeorm';
import { Initial1000000000000 } from './1000000000000-initial';
import { Enrollments1100000000000 } from './1100000000000-enrollments';
import { JobPause1200000000000 } from './1200000000000-job-pause';
import { AdminListIndexes1300000000000 } from './1300000000000-admin-list-indexes';
import { StudioExportPremiere1400000000000 } from './1400000000000-studio-export-premiere';
import { DropOwnerDefaultLane1500000000000 } from './1500000000000-drop-owner-default-lane';
import { StudioTranscribe1600000000000 } from './1600000000000-studio-transcribe';
import { StatsFinishedIndex1700000000000 } from './1700000000000-stats-finished-index';
import { NodePriorityOrder1800000000000 } from './1800000000000-node-priority-order';
import { NodeBlockedKinds1900000000000 } from './1900000000000-node-blocked-kinds';

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://farm_test:farm_test@localhost:55433/ag_farm_test';

const BEFORE = [
  Initial1000000000000,
  Enrollments1100000000000,
  JobPause1200000000000,
  AdminListIndexes1300000000000,
  StudioExportPremiere1400000000000,
  DropOwnerDefaultLane1500000000000,
  StudioTranscribe1600000000000,
  StatsFinishedIndex1700000000000,
  NodePriorityOrder1800000000000,
];

async function dataSource(migrations: Function[]): Promise<DataSource> {
  const ds = new DataSource({ type: 'postgres', url: TEST_DB_URL, migrations, synchronize: false });
  await ds.initialize();
  return ds;
}

async function insertNode(ds: DataSource, name: string, kinds: string[], allowed: string[] | null): Promise<void> {
  await ds.query(
    `INSERT INTO farm_nodes (name, machine, kinds, allowed_kinds, token_hash)
     VALUES ($1, 'm', $2::text[], $3::text[], md5($1) || md5($1))`,
    [name, kinds, allowed],
  );
}

async function column(ds: DataSource, col: 'blocked_kinds' | 'allowed_kinds'): Promise<Record<string, string[] | null>> {
  const rows: Array<{ name: string; v: string[] | null }> = await ds.query(`SELECT name, ${col} AS v FROM farm_nodes ORDER BY name`);
  return Object.fromEntries(rows.map((r) => [r.name, r.v]));
}

describe('migration NodeBlockedKinds1900000000000', () => {
  let ds: DataSource;

  async function reset(seed: (ds: DataSource) => Promise<void>): Promise<void> {
    const before = await dataSource(BEFORE);
    await before.dropDatabase();
    await before.runMigrations();
    await seed(before);
    await before.destroy();
    ds = await dataSource([...BEFORE, NodeBlockedKinds1900000000000]);
  }

  afterEach(async () => {
    await ds.destroy();
  });

  async function seed(b: DataSource): Promise<void> {
    await insertNode(b, 'all', ['studio.tts', 'studio.render_final'], null);
    await insertNode(b, 'some', ['studio.tts', 'studio.render_final', 'studio.transcribe'], ['studio.render_final']);
    await insertNode(b, 'none', ['scan.extract', 'scan.ai'], []);
    await insertNode(b, 'extra-allowed', ['scan.extract'], ['scan.extract', 'scan.ai']);
  }

  it('blocks what was reported but not allowed, and nothing where everything was allowed', async () => {
    await reset(seed);
    await ds.runMigrations();
    expect(await column(ds, 'blocked_kinds')).toEqual({
      all: [],
      some: ['studio.tts', 'studio.transcribe'],
      none: ['scan.extract', 'scan.ai'],
      'extra-allowed': [],
    });
    const cols: unknown[] = await ds.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'farm_nodes' AND column_name = 'allowed_kinds'`,
    );
    expect(cols).toHaveLength(0);
    // Máy mới không chặn gì
    await ds.query(`INSERT INTO farm_nodes (name, machine, kinds, token_hash) VALUES ('new', 'm', ARRAY['scan.extract'], md5('n') || md5('n'))`);
    expect((await column(ds, 'blocked_kinds'))['new']).toEqual([]);
  });

  it('is undone by down', async () => {
    await reset(seed);
    await ds.runMigrations();
    await ds.undoLastMigration();
    expect(await column(ds, 'allowed_kinds')).toEqual({
      all: null,
      some: ['studio.render_final'],
      none: [],
      'extra-allowed': null,
    });
    // up lại được
    await ds.runMigrations();
    expect((await column(ds, 'blocked_kinds'))['some']).toEqual(['studio.tts', 'studio.transcribe']);
  });
});
