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
];

async function dataSource(migrations: Function[]): Promise<DataSource> {
  const ds = new DataSource({ type: 'postgres', url: TEST_DB_URL, migrations, synchronize: false });
  await ds.initialize();
  return ds;
}

async function insertNode(ds: DataSource, name: string, createdAt?: string): Promise<void> {
  await ds.query(
    `INSERT INTO farm_nodes (name, machine, kinds, token_hash, created_at)
     VALUES ($1, 'm', ARRAY['scan.extract'], md5($1) || md5($1), COALESCE($2::timestamptz, now()))`,
    [name, createdAt ?? null],
  );
}

async function orders(ds: DataSource): Promise<Array<[string, number]>> {
  const rows: { name: string; priority_order: number }[] = await ds.query(
    'SELECT name, priority_order FROM farm_nodes ORDER BY priority_order',
  );
  return rows.map((r) => [r.name, r.priority_order]);
}

describe('migration NodePriorityOrder1800000000000', () => {
  let ds: DataSource;

  async function reset(seed: (ds: DataSource) => Promise<void>): Promise<void> {
    const before = await dataSource(BEFORE);
    await before.dropDatabase();
    await before.runMigrations();
    await seed(before);
    await before.destroy();
    ds = await dataSource([...BEFORE, NodePriorityOrder1800000000000]);
  }

  afterEach(async () => {
    await ds.destroy();
  });

  it('orders the existing nodes by when they were created, and new nodes go after them', async () => {
    await reset(async (b) => {
      await insertNode(b, 'second', '2026-01-02T00:00:00Z');
      await insertNode(b, 'third', '2026-01-03T00:00:00Z');
      await insertNode(b, 'first', '2026-01-01T00:00:00Z');
    });
    await ds.runMigrations();
    expect(await orders(ds)).toEqual([
      ['first', 1],
      ['second', 2],
      ['third', 3],
    ]);
    await insertNode(ds, 'new');
    expect((await orders(ds)).at(-1)).toEqual(['new', 4]);
  });

  it('starts at 1 on an empty farm', async () => {
    await reset(async () => {});
    await ds.runMigrations();
    await insertNode(ds, 'only');
    expect(await orders(ds)).toEqual([['only', 1]]);
  });

  it('is undone by down', async () => {
    await reset(async (b) => insertNode(b, 'a'));
    await ds.runMigrations();
    await ds.undoLastMigration();
    const cols: unknown[] = await ds.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'farm_nodes' AND column_name = 'priority_order'`,
    );
    expect(cols).toHaveLength(0);
    const seqs: unknown[] = await ds.query(`SELECT 1 FROM pg_class WHERE relname = 'farm_nodes_priority_order_seq'`);
    expect(seqs).toHaveLength(0);
    // up lại được
    await ds.runMigrations();
    expect(await orders(ds)).toEqual([['a', 1]]);
  });
});
