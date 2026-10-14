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
import { NodeSelfUpdate2000000000000 } from './2000000000000-node-self-update';
import { MachineMetrics2100000000000 } from './2100000000000-machine-metrics';
import { StudioReferenceFetch2200000000000 } from './2200000000000-studio-reference-fetch';
import { AgGoPrep2300000000000 } from './2300000000000-ag-go-prep';

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
  NodeBlockedKinds1900000000000,
  NodeSelfUpdate2000000000000,
  MachineMetrics2100000000000,
  StudioReferenceFetch2200000000000,
];

async function dataSource(migrations: Function[]): Promise<DataSource> {
  const ds = new DataSource({ type: 'postgres', url: TEST_DB_URL, migrations, synchronize: false });
  await ds.initialize();
  return ds;
}

async function allowedTypes(ds: DataSource, id: string): Promise<string[]> {
  const rows: { allowed_types: string[] }[] = await ds.query('SELECT allowed_types FROM farm_owners WHERE id = $1', [id]);
  return rows[0]?.allowed_types ?? [];
}

describe('migration AgGoPrep2300000000000', () => {
  let ds: DataSource;

  beforeEach(async () => {
    const reset = await dataSource(BEFORE);
    await reset.dropDatabase();
    await reset.runMigrations();
    await reset.query(
      `INSERT INTO farm_owners (id, key_hash, sign_url, allowed_types) VALUES
         ('studio', repeat('a', 64), 'http://studio/sign', ARRAY['studio.tts','studio.transcribe','studio.reference_fetch']),
         ('ag-go', repeat('b', 64), 'http://ag-go/sign', ARRAY['scan.extract','scan.ai'])`,
    );
    await reset.destroy();
    ds = await dataSource([...BEFORE, AgGoPrep2300000000000]);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('lets the owner that scans footage prepare it and transcribe its sound, and nobody else', async () => {
    await ds.runMigrations();
    expect(await allowedTypes(ds, 'ag-go')).toEqual(['scan.extract', 'scan.ai', 'scan.prep', 'studio.transcribe']);
    expect(await allowedTypes(ds, 'studio')).toEqual(['studio.tts', 'studio.transcribe', 'studio.reference_fetch']);
  });

  it('does not add a type twice', async () => {
    await ds.query(`UPDATE farm_owners SET allowed_types = array_append(allowed_types, 'studio.transcribe') WHERE id = 'ag-go'`);
    await ds.runMigrations();
    expect(await allowedTypes(ds, 'ag-go')).toEqual(['scan.extract', 'scan.ai', 'studio.transcribe', 'scan.prep']);
  });

  it('is undone by down, and Studio keeps its transcription', async () => {
    await ds.runMigrations();
    await ds.undoLastMigration();
    expect(await allowedTypes(ds, 'ag-go')).toEqual(['scan.extract', 'scan.ai']);
    expect(await allowedTypes(ds, 'studio')).toEqual(['studio.tts', 'studio.transcribe', 'studio.reference_fetch']);
  });
});
