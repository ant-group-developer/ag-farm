import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import { AdminGuard } from '../../auth/admin.guard';
import { ReleasesModule } from './releases.module';
import { ReleasesService } from './releases.service';

const SHA = 'a'.repeat(64);

describe('releases', () => {
  let dir: string;
  let app: INestApplication;
  let svc: ReleasesService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ag-releases-'));
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ FARM_RELEASES_DIR: dir })] }), ReleasesModule],
    })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    svc = app.get(ReleasesService);
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('no latest.json yet: no packages', async () => {
    await expect(svc.latest()).resolves.toEqual({ packages: {} });
  });

  it('reads latest.json, dropping entries that do not parse', async () => {
    writeFileSync(
      join(dir, 'latest.json'),
      '﻿' +
        JSON.stringify({
          packages: {
            'ag-render-worker': { version: '0.9.0', file: 'ag-render-worker-0.9.0.zip', sha256: SHA, size_bytes: 10, built_at: '2026-10-12T01:33:20.025Z' },
            'ag-scan-worker': { version: 'latest', file: 'x.zip' },
          },
        }),
    );
    const latest = await svc.latest();
    expect(Object.keys(latest.packages)).toEqual(['ag-render-worker']);
    expect(latest.packages['ag-render-worker']?.version).toBe('0.9.0');
  });

  it('GET /v1/admin/releases/latest answers the farm web', async () => {
    writeFileSync(
      join(dir, 'latest.json'),
      JSON.stringify({ packages: { 'ag-scan-worker': { version: '0.4.0', file: 'ag-scan-worker-0.4.0.zip', sha256: SHA, size_bytes: 1 } } }),
    );
    const res = await supertest(app.getHttpServer()).get('/v1/admin/releases/latest');
    expect(res.status).toBe(200);
    expect(res.body.packages['ag-scan-worker'].version).toBe('0.4.0');
  });
});
