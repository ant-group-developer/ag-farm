import { ExecutionContext, INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import { AdminGuard } from '../../auth/admin.guard';
import { ApiExceptionFilter } from '../../common/api-exception.filter';
import { ReleaseUploadGuard } from './release-upload.guard';
import { ReleasesModule } from './releases.module';
import { ReleasesService } from './releases.service';

const SHA = 'a'.repeat(64);
const RELEASE_KEY = 'k'.repeat(40);
const zip = (text: string) => Buffer.from(`PK-fake-zip ${text}`);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('releases', () => {
  let dir: string;
  let app: INestApplication;
  let svc: ReleasesService;
  let adminAllows: boolean;
  const fakeAdmin = {
    canActivate: () => {
      if (!adminAllows) throw new UnauthorizedException('Bearer token is required');
      return true;
    },
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ag-releases-'));
    adminAllows = true;
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ FARM_RELEASES_DIR: dir, FARM_RELEASE_KEY: RELEASE_KEY, FARM_RELEASE_MAX_MB: 1 })] }), ReleasesModule],
    })
      // Admin đăng nhập (Auth0) giả cho guard của GET; POST không khoá đi qua AdminGuard thật (không token: 401).
      .overrideGuard(AdminGuard)
      .useValue(fakeAdmin)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ApiExceptionFilter());
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
      '\uFEFF' +
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

  describe('POST /v1/admin/releases', () => {
    function publish(body: Buffer, fields: Record<string, string>, auth = `Release ${RELEASE_KEY}`) {
      let req = supertest(app.getHttpServer()).post('/v1/admin/releases').set('Authorization', auth);
      for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
      return req.attach('file', body, 'ag-render-worker-0.9.1.zip');
    }

    beforeEach(() => {
      adminAllows = false;
      writeFileSync(
        join(dir, 'latest.json'),
        JSON.stringify({
          packages: {
            'ag-render-worker': { version: '0.9.0', file: 'ag-render-worker-0.9.0.zip', sha256: SHA, size_bytes: 10 },
            'ag-scan-worker': { version: '0.4.0', file: 'ag-scan-worker-0.4.0.zip', sha256: SHA, size_bytes: 1 },
          },
          note: 'kept',
        }),
      );
    });

    const leftovers = () => (existsSync(join(dir, '.incoming')) ? readdirSync(join(dir, '.incoming')) : []);

    it('saves the zip and moves latest.json to it, keeping the other package', async () => {
      const body = zip('0.9.1');
      const res = await publish(body, {
        package: 'ag-render-worker',
        version: '0.9.1',
        sha256: sha(body).toUpperCase(),
        built_at: '2026-10-13T01:00:00.000Z',
      });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        version: '0.9.1',
        file: 'ag-render-worker-0.9.1.zip',
        sha256: sha(body),
        size_bytes: body.length,
        built_at: '2026-10-13T01:00:00.000Z',
      });
      expect(readFileSync(join(dir, 'ag-render-worker-0.9.1.zip'))).toEqual(body);
      const latest = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
      expect(latest.packages['ag-render-worker'].version).toBe('0.9.1');
      expect(latest.packages['ag-scan-worker'].version).toBe('0.4.0');
      expect(latest.note).toBe('kept');
      expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
      expect(leftovers()).toEqual([]);
    });

    it('refuses the same or an older version', async () => {
      for (const version of ['0.9.0', '0.8.9', '0.9.0-rc.1']) {
        const body = zip(version);
        const res = await publish(body, { package: 'ag-render-worker', version, sha256: sha(body) });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('version_not_newer');
      }
      expect(JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')).packages['ag-render-worker'].version).toBe('0.9.0');
      expect(leftovers()).toEqual([]);
    });

    it('refuses a file whose sha256 does not match', async () => {
      const res = await publish(zip('x'), { package: 'ag-render-worker', version: '0.9.1', sha256: SHA });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('sha256_mismatch');
      expect(existsSync(join(dir, 'ag-render-worker-0.9.1.zip'))).toBe(false);
      expect(leftovers()).toEqual([]);
    });

    it('refuses an unknown package, a bad version, a missing file', async () => {
      const body = zip('y');
      expect((await publish(body, { package: 'ag-evil', version: '1.0.0', sha256: sha(body) })).status).toBe(400);
      expect((await publish(body, { package: 'ag-render-worker', version: '../1', sha256: sha(body) })).status).toBe(400);
      const noFile = await supertest(app.getHttpServer())
        .post('/v1/admin/releases')
        .set('Authorization', `Release ${RELEASE_KEY}`)
        .field('package', 'ag-render-worker')
        .field('version', '0.9.1')
        .field('sha256', SHA);
      expect(noFile.status).toBe(400);
      expect(noFile.body.error.code).toBe('file_required');
      expect(leftovers()).toEqual([]);
    });

    it('refuses a file over FARM_RELEASE_MAX_MB', async () => {
      const body = Buffer.alloc(1024 * 1024 + 10, 1);
      const res = await publish(body, { package: 'ag-render-worker', version: '0.9.1', sha256: sha(body) });
      expect(res.status).toBe(413);
      expect(leftovers()).toEqual([]);
    });

    it('needs the release key (or an admin login): nothing is written otherwise', async () => {
      const body = zip('z');
      const fields = { package: 'ag-render-worker', version: '0.9.1', sha256: sha(body) };
      expect((await publish(body, fields, 'Release wrong-key-000000000000000000000000')).status).toBe(401);
      expect((await publish(body, fields, '')).status).toBe(401);
      expect(existsSync(join(dir, 'ag-render-worker-0.9.1.zip'))).toBe(false);
      expect(leftovers()).toEqual([]);
    });

    it('two uploads at once: one wins, latest.json stays whole', async () => {
      const a = zip('a');
      const b = zip('b');
      const [ra, rb] = await Promise.all([
        publish(a, { package: 'ag-render-worker', version: '0.9.1', sha256: sha(a) }),
        publish(b, { package: 'ag-render-worker', version: '0.9.1', sha256: sha(b) }),
      ]);
      expect([ra.status, rb.status].sort()).toEqual([201, 409]);
      const latest = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
      expect(latest.packages['ag-render-worker'].version).toBe('0.9.1');
      expect(latest.packages['ag-scan-worker'].version).toBe('0.4.0');
    });
  });

  describe('ReleaseUploadGuard', () => {
    function context(authorization?: string): ExecutionContext {
      const req = { header: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined) };
      return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
    }
    function guard(key: string | undefined, adminOk: boolean) {
      const config = { get: (name: string) => (name === 'FARM_RELEASE_KEY' ? key : undefined) } as unknown as ConfigService;
      const admin = {
        canActivate: async () => {
          if (!adminOk) throw new UnauthorizedException('Bearer token is required');
          return true;
        },
      } as unknown as AdminGuard;
      return new ReleaseUploadGuard(config, admin);
    }

    it('takes the release key, refuses a wrong one without asking Auth0', async () => {
      await expect(guard(RELEASE_KEY, false).canActivate(context(`Release ${RELEASE_KEY}`))).resolves.toBe(true);
      await expect(guard(RELEASE_KEY, true).canActivate(context('Release nope'))).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('no key on the hub: the release scheme never passes', async () => {
      await expect(guard(undefined, true).canActivate(context(`Release ${RELEASE_KEY}`))).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('otherwise asks the admin guard (Auth0 login on the farm web)', async () => {
      await expect(guard(RELEASE_KEY, true).canActivate(context('Bearer jwt'))).resolves.toBe(true);
      await expect(guard(RELEASE_KEY, false).canActivate(context('Bearer jwt'))).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
