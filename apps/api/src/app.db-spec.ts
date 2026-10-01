/**
 * DB integration tests cho ag-farm.
 * Yêu cầu Postgres đang chạy ở port 55433 (docker compose -f docker-compose.test.yml up -d).
 * Chạy: yarn workspace @ag-farm/api test:db
 */
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Capabilities, signTicket, verifyTicket } from '@ag-farm/protocol';
import { createHash, generateKeyPairSync as genKeyPair, randomBytes, randomUUID } from 'node:crypto';
import supertest from 'supertest';
const request = supertest;
import { DataSource } from 'typeorm';
import { FarmJobEntity } from './database/entities/farm-job.entity';
import { FarmNodeEntity } from './database/entities/farm-node.entity';
import { FarmOwnerEntity } from './database/entities/farm-owner.entity';
import { Initial1000000000000 } from './database/migrations/1000000000000-initial';
import { Enrollments1100000000000 } from './database/migrations/1100000000000-enrollments';
import { JobPause1200000000000 } from './database/migrations/1200000000000-job-pause';
import { AdminListIndexes1300000000000 } from './database/migrations/1300000000000-admin-list-indexes';
import { FarmEnrollmentEntity } from './database/entities/farm-enrollment.entity';
import { EnrollService } from './modules/enroll/enroll.service';
import { ACCOUNT_ME_CLIENT, AdminGuard } from './auth/admin.guard';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { ApiResponseInterceptor } from './common/api-response.interceptor';
import { AdminModule } from './modules/admin/admin.module';
import { OwnerModule } from './modules/owner/owner.module';
import { ReaperModule } from './modules/reaper/reaper.module';
import { ReaperService } from './modules/reaper/reaper.service';
import { WorkerModule } from './modules/worker/worker.module';
import { HealthController } from './health.controller';

const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://farm_test:farm_test@localhost:55433/ag_farm_test';

// Sinh key pair cho test
const { privateKey: PRIV_KEY, publicKey: PUB_KEY } = genKeyPair('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function escapeKey(k: string) {
  return k.replace(/\n/g, '\\n');
}

const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: TEST_DB_URL,
  AUTH0_ISSUER_URL: 'https://test.auth0.com/',
  AUTH0_AUDIENCE: 'test-aud',
  AUTH0_JWKS_URL: 'https://test.auth0.com/.well-known/jwks.json',
  AUTH0_ALLOWED_CLIENT_IDS: 'test-client',
  ACCOUNT_API_URL: 'http://localhost:19999',
  FARM_TICKET_PRIVATE_KEY: escapeKey(PRIV_KEY),
  FARM_TICKET_PUBLIC_KEY: escapeKey(PUB_KEY),
  REAPER_INTERVAL_MS: '999999', // tắt auto-reap trong test
  NODE_OFFLINE_AFTER_SECONDS: '90',
  FRONTEND_ORIGIN: '*',
  PORT: '3099',
  FARM_OLLAMA_MODELS: 'qwen2.5vl:3b, qwen2.5vl:7b',
};

/** Fake AccountMeClient → luôn trả ADMIN */
const fakeAccountMeClient = { getMe: async () => ({ user_type: 'ADMIN' }) };

async function buildApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    imports: [
      ConfigModule.forRoot({
        load: [() => TEST_ENV],
        isGlobal: true,
        ignoreEnvFile: true,
      }),
      TypeOrmModule.forRoot({
        type: 'postgres',
        url: TEST_DB_URL,
        entities: [FarmOwnerEntity, FarmNodeEntity, FarmJobEntity, FarmEnrollmentEntity],
        migrations: [Initial1000000000000, Enrollments1100000000000, JobPause1200000000000, AdminListIndexes1300000000000],
        migrationsRun: true,
        synchronize: false,
        dropSchema: true, // reset DB mỗi lần test
      }),
      WorkerModule,
      OwnerModule,
      AdminModule,
      ReaperModule,
    ],
  })
    .overrideProvider(ACCOUNT_ME_CLIENT)
    .useValue(fakeAccountMeClient)
    .compile();

  const app = moduleRef.createNestApplication();
  // Register the envelope interceptor and exception filter the same way main.ts does
  // via AppModule providers. The test module is built independently, so we wire them
  // manually here.
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new ApiResponseInterceptor(app.get(Reflector)));
  await app.init();
  return app;
}

/** buildAdminApp: giống buildApp nhưng bỏ qua JWT verification trong AdminGuard */
async function buildAdminApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    imports: [
      ConfigModule.forRoot({
        load: [() => TEST_ENV],
        isGlobal: true,
        ignoreEnvFile: true,
      }),
      TypeOrmModule.forRoot({
        type: 'postgres',
        url: TEST_DB_URL,
        entities: [FarmOwnerEntity, FarmNodeEntity, FarmJobEntity, FarmEnrollmentEntity],
        migrations: [Initial1000000000000, Enrollments1100000000000, JobPause1200000000000, AdminListIndexes1300000000000],
        migrationsRun: true,
        synchronize: false,
        dropSchema: true,
      }),
      WorkerModule,
      OwnerModule,
      AdminModule,
      ReaperModule,
    ],
  })
    .overrideProvider(ACCOUNT_ME_CLIENT)
    .useValue(fakeAccountMeClient)
    .overrideGuard(AdminGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new ApiResponseInterceptor(app.get(Reflector)));
  await app.init();
  return app;
}

/** Helper: lấy DataSource từ app */
function getDs(app: INestApplication): DataSource {
  return app.get<DataSource>(DataSource);
}

/** Tạo owner trong DB */
async function createOwner(
  ds: DataSource,
  id: string,
  allowedTypes: string[] = ['scan.extract', 'scan.ai'],
): Promise<{ owner: FarmOwnerEntity; key: string }> {
  const key = randomBytes(24).toString('base64url');
  const keyHash = createHash('sha256').update(key).digest('hex');
  const repo = ds.getRepository(FarmOwnerEntity);
  const owner = repo.create({
    id,
    keyHash,
    signUrl: 'http://localhost:19999/sign',
    allowedTypes,
  });
  await repo.save(owner);
  return { owner, key };
}

/** Tạo node trong DB */
async function createNode(
  ds: DataSource,
  kinds: string[] = ['scan.extract', 'scan.ai'],
): Promise<{ node: FarmNodeEntity; token: string }> {
  const token = randomBytes(24).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const capabilities: Capabilities = {
    os: 'linux',
    cpu_cores: 4,
    ram_mb: 8192,
    gpus: [{ name: 'RTX 3060', vram_mb: 12288, nvenc: true, nvdec: true }],
    engines: { ffmpeg: 'ffmpeg version 6.0', ollama_models: ['qwen2.5vl:7b'], python: '3.11' },
  };
  const repo = ds.getRepository(FarmNodeEntity);
  const node = repo.create({
    name: 'test-node',
    machine: 'test-machine',
    kinds,
    tokenHash,
    status: 'active',
    capabilities,
    freeSlots: { cpu: 2, gpu: 1 },
  });
  await repo.save(node);
  return { node, token };
}

// ============================================================
// Tests
// ============================================================

describe('ag-farm DB integration', () => {
  let app: INestApplication;
  let ds: DataSource;
  let agGoKey: string;
  let nodeToken: string;
  let nodeId: string;

  beforeAll(async () => {
    app = await buildApp();
    ds = getDs(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Xoá dữ liệu giữa các test (TRUNCATE an toàn hơn delete({}) trong TypeORM 1.1)
    await ds.query('TRUNCATE TABLE farm_jobs, farm_nodes, farm_owners, farm_enrollments RESTART IDENTITY CASCADE');
  });

  // ---- Migration up/down/up ----
  it('migration up/down/up', async () => {
    const runner = ds.createQueryRunner();
    try {
      // down
      await runner.query(`DROP TABLE IF EXISTS farm_jobs`);
      await runner.query(`DROP TABLE IF EXISTS farm_nodes`);
      await runner.query(`DROP TABLE IF EXISTS farm_owners`);
      await runner.query(`DROP TABLE IF EXISTS farm_enrollments`);
      await runner.query(`DELETE FROM migrations`);
      // up lại
      await ds.runMigrations();
      // kiểm bảng tồn tại
      const res = await runner.query(`SELECT tablename FROM pg_tables WHERE tablename = 'farm_jobs'`);
      expect(res).toHaveLength(1);
    } finally {
      await runner.release();
    }
  });

  // ---- Health ----
  it('GET /health returns ok', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
  });

  // ---- Full lifecycle: submit â†' claim â†' progress â†' complete â†' list unacked â†' ack ----
  it('full lifecycle', async () => {
    const { key } = await createOwner(ds, 'ag-go');
    agGoKey = key;
    const { token, node } = await createNode(ds);
    nodeToken = token;
    nodeId = node.id;

    // 1. Heartbeat
    const hbRes = await request(app.getHttpServer())
      .post('/v1/worker/heartbeat')
      .set('Authorization', `Node ${nodeToken}`)
      .send({
        agent_version: '1.0.0',
        kinds: ['scan.extract', 'scan.ai'],
        capabilities: {
          os: 'linux',
          cpu_cores: 4,
          ram_mb: 8192,
          gpus: [{ name: 'RTX 3060', vram_mb: 12288, nvenc: true, nvdec: true }],
          engines: { ffmpeg: 'v6', ollama_models: ['qwen2.5vl:7b'], python: '3.11' },
        },
        free_slots: { cpu: 2, gpu: 1 },
        running_job_ids: [],
      });
    expect(hbRes.status).toBe(200);
    expect(hbRes.body.data.node_id).toBe(nodeId);
    expect(hbRes.body.data.status).toBe('active');

    // 2. Submit job
    const submitRes = await request(app.getHttpServer())
      .post('/v1/owner/jobs')
      .set('Authorization', `Owner ${agGoKey}`)
      .send({
        type: 'scan.extract',
        lane: 'batch',
        priority: 0,
        requirements: {},
        affinity_key: null,
        payload: {
          asset: {
            id: 'a1b2c3d4-e5f6-4a7b-8c9d-000000000001',
            kind: 'video',
            mime_type: 'video/mp4',
            size_bytes: 1000000,
            checksum_sha256: null,
            duration_ms: 60000,
            width: 1920,
            height: 1080,
          },
          extract_version: 'x1',
        },
        max_attempts: 3,
        correlation_id: 'test-corr-1',
      });
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.data.created).toBe(true);
    const jobId = submitRes.body.data.job.id as string;

    // 3. Claim
    const claimRes = await request(app.getHttpServer())
      .post('/v1/worker/claim')
      .set('Authorization', `Node ${nodeToken}`)
      .send({
        kinds: ['scan.extract', 'scan.ai'],
        free_slots: { cpu: 2, gpu: 1 },
        cached_affinity: [],
      });
    expect(claimRes.status).toBe(200);
    expect(claimRes.body.data.job).not.toBeNull();
    expect(claimRes.body.data.job.id).toBe(jobId);
    const leaseToken = claimRes.body.data.job.lease_token as string;
    const ticket = claimRes.body.data.job.ticket as string;

    // 4. Verify ticket
    const claims = verifyTicket(ticket, PUB_KEY, { owner: 'ag-go' });
    expect(claims.job_id).toBe(jobId);
    expect(claims.owner).toBe('ag-go');
    expect(claims.attempt).toBe(1);

    // 5. Progress
    const progRes = await request(app.getHttpServer())
      .post(`/v1/worker/jobs/${jobId}/progress`)
      .set('Authorization', `Node ${nodeToken}`)
      .send({ lease_token: leaseToken, percent: 50, stage: 'extracting' });
    expect(progRes.status).toBe(200);
    expect(progRes.body.data.ticket).toBeTruthy();

    // 6. Complete
    const completeRes = await request(app.getHttpServer())
      .post(`/v1/worker/jobs/${jobId}/complete`)
      .set('Authorization', `Node ${nodeToken}`)
      .send({
        lease_token: leaseToken,
        result: { manifest: 'extract.json', summary: { segments: 5 } },
      });
    expect(completeRes.status).toBe(200);

    // 7. List unacked
    const listRes = await request(app.getHttpServer())
      .get('/v1/owner/jobs?unacked=1')
      .set('Authorization', `Owner ${agGoKey}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.jobs).toHaveLength(1);
    expect(listRes.body.data.jobs[0].id).toBe(jobId);
    expect(listRes.body.data.jobs[0].status).toBe('completed');

    // 8. Ack
    const ackRes = await request(app.getHttpServer())
      .post(`/v1/owner/jobs/${jobId}/ack`)
      .set('Authorization', `Owner ${agGoKey}`);
    expect(ackRes.status).toBe(200);
    expect(ackRes.body.data.acked_at).toBeTruthy();

    // 9. List unacked lại → rỗng
    const listRes2 = await request(app.getHttpServer())
      .get('/v1/owner/jobs?unacked=1')
      .set('Authorization', `Owner ${agGoKey}`);
    expect(listRes2.body.data.jobs).toHaveLength(0);
  });

  // ---- Correlation ID idempotency ----
  it('correlation_id idempotency', async () => {
    const { key } = await createOwner(ds, 'ag-go');
    const body = {
      type: 'scan.extract',
      correlation_id: 'idem-test',
      payload: {
        asset: {
          id: 'a1b2c3d4-e5f6-4a7b-8c9d-000000000002',
          kind: 'video',
          mime_type: 'video/mp4',
          size_bytes: null,
          checksum_sha256: null,
          duration_ms: null,
          width: null,
          height: null,
        },
        extract_version: 'x1',
      },
      max_attempts: 3,
    };

    const r1 = await request(app.getHttpServer())
      .post('/v1/owner/jobs')
      .set('Authorization', `Owner ${key}`)
      .send(body);
    expect(r1.status).toBe(200);
    expect(r1.body.data.created).toBe(true);
    const id1 = r1.body.data.job.id;

    const r2 = await request(app.getHttpServer())
      .post('/v1/owner/jobs')
      .set('Authorization', `Owner ${key}`)
      .send(body);
    expect(r2.status).toBe(200);
    expect(r2.body.data.created).toBe(false);
    expect(r2.body.data.job.id).toBe(id1);
  });

  // ---- Concurrent claims: không hai node cùng lấy một job ----
  it('concurrent claims do not duplicate', async () => {
    const { key } = await createOwner(ds, 'ag-go');

    // Tạo 5 jobs
    const jobIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await request(app.getHttpServer())
        .post('/v1/owner/jobs')
        .set('Authorization', `Owner ${key}`)
        .send({
          type: 'scan.extract',
          correlation_id: `concurrent-${i}`,
          payload: {
            asset: {
              id: `a1b2c3d4-e5f6-4a7b-8c9d-${String(i).padStart(12, '0')}`,
              kind: 'video',
              mime_type: 'video/mp4',
              size_bytes: null,
              checksum_sha256: null,
              duration_ms: null,
              width: null,
              height: null,
            },
            extract_version: 'x1',
          },
          max_attempts: 1,
        });
      jobIds.push(r.body.data.job.id);
    }

    // Tạo 10 node tokens
    const tokens: string[] = [];
    for (let i = 0; i < 10; i++) {
      const token = randomBytes(16).toString('base64url');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const repo = ds.getRepository(FarmNodeEntity);
      await repo.save(
        repo.create({
          name: `node-${i}`,
          machine: 'm',
          kinds: ['scan.extract'],
          tokenHash,
          status: 'active',
          capabilities: {
            os: 'linux',
            cpu_cores: 4,
            ram_mb: 8192,
            gpus: [],
            engines: { ffmpeg: null, ollama_models: [], python: null },
          },
          freeSlots: { cpu: 4, gpu: 0 },
        }),
      );
      tokens.push(token);
    }

    // Heartbeat cho mỗi node để cập nhật capabilities
    await Promise.all(
      tokens.map((t) =>
        request(app.getHttpServer())
          .post('/v1/worker/heartbeat')
          .set('Authorization', `Node ${t}`)
          .send({
            agent_version: '1.0',
            kinds: ['scan.extract'],
            capabilities: {
              os: 'linux',
              cpu_cores: 4,
              ram_mb: 8192,
              gpus: [],
              engines: { ffmpeg: null, ollama_models: [], python: null },
            },
            free_slots: { cpu: 4, gpu: 0 },
            running_job_ids: [],
          }),
      ),
    );

    // Claim song song ~20 lần
    const claims = await Promise.all(
      [...tokens, ...tokens].map((t) =>
        request(app.getHttpServer())
          .post('/v1/worker/claim')
          .set('Authorization', `Node ${t}`)
          .send({
            kinds: ['scan.extract'],
            free_slots: { cpu: 4, gpu: 0 },
            cached_affinity: [],
          }),
      ),
    );

    const claimedIds = claims
      .filter((r) => r.body.data?.job != null)
      .map((r) => r.body.data.job.id as string);

    // Không trùng lặp
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    // Không vượt quá số job
    expect(claimedIds.length).toBeLessThanOrEqual(5);
  });

  // ---- Lane ordering: interactive trước batch ----
  it('interactive lane claimed before batch', async () => {
    const { key } = await createOwner(ds, 'studio', ['studio.render_preview']);
    await createOwner(ds, 'ag-go');
    const { token } = await createNode(ds, ['scan.extract', 'studio.render_preview']);

    // heartbeat
    await request(app.getHttpServer())
      .post('/v1/worker/heartbeat')
      .set('Authorization', `Node ${token}`)
      .send({
        agent_version: '1.0',
        kinds: ['scan.extract', 'studio.render_preview'],
        capabilities: {
          os: 'linux',
          cpu_cores: 4,
          ram_mb: 8192,
          gpus: [],
          engines: { ffmpeg: null, ollama_models: [], python: null },
        },
        free_slots: { cpu: 2, gpu: 0 },
        running_job_ids: [],
      });

    // Submit một batch job (scan.extract)
    const batchOwnerKey = (await createOwner(ds, 'ag-go2', ['scan.extract'])).key;
    await request(app.getHttpServer())
      .post('/v1/owner/jobs')
      .set('Authorization', `Owner ${batchOwnerKey}`)
      .send({
        type: 'scan.extract',
        priority: 100, // cao nhất
        correlation_id: 'batch-1',
        payload: {
          asset: {
            id: 'a1b2c3d4-e5f6-4a7b-8c9d-000000000010',
            kind: 'video',
            mime_type: 'video/mp4',
            size_bytes: null,
            checksum_sha256: null,
            duration_ms: null,
            width: null,
            height: null,
          },
          extract_version: 'x1',
        },
        max_attempts: 1,
      });

    // Submit một interactive job (studio.render_preview) với priority thấp hơn
    await request(app.getHttpServer())
      .post('/v1/owner/jobs')
      .set('Authorization', `Owner ${key}`)
      .send({
        type: 'studio.render_preview',
        priority: 0,
        correlation_id: 'interactive-1',
        payload: {
          production_id: 'prod-1',
          revision: 1,
          composition: 'stage:renders/1/composition.json',
          canvas: { width: 1280, height: 720 },
          output: 'renders/1/preview.mp4',
        },
        max_attempts: 1,
      });

    // Claim → phải lấy interactive trước
    const claimRes = await request(app.getHttpServer())
      .post('/v1/worker/claim')
      .set('Authorization', `Node ${token}`)
      .send({
        kinds: ['scan.extract', 'studio.render_preview'],
        free_slots: { cpu: 2, gpu: 0 },
        lanes: ['interactive', 'batch'],
        cached_affinity: [],
      });
    expect(claimRes.status).toBe(200);
    expect(claimRes.body.data.job).not.toBeNull();
    expect(claimRes.body.data.job.lane).toBe('interactive');
  });

  // ---- Hết slot: hub báo job interactive đang chờ để worker batch cùng máy nhường slot ----
  it('reports interactive jobs waiting for a slot, and nothing when none wait', async () => {
    const { key } = await createOwner(ds, 'studio', ['studio.render_preview']);
    const { token } = await createNode(ds, ['studio.render_preview']);
    const caps = {
      os: 'linux',
      cpu_cores: 4,
      ram_mb: 8192,
      gpus: [],
      engines: { ffmpeg: null, ollama_models: [], python: null },
    };
    await request(app.getHttpServer())
      .post('/v1/worker/heartbeat')
      .set('Authorization', `Node ${token}`)
      .send({ agent_version: '1.0', kinds: ['studio.render_preview'], capabilities: caps, free_slots: { cpu: 0, gpu: 0 }, running_job_ids: [] });
    const claim = () =>
      request(app.getHttpServer())
        .post('/v1/worker/claim')
        .set('Authorization', `Node ${token}`)
        .send({ kinds: ['studio.render_preview'], free_slots: { cpu: 0, gpu: 0 }, lanes: ['interactive'], cached_affinity: [] });

    const empty = await claim();
    expect(empty.body.data).toEqual({ job: null });

    await request(app.getHttpServer())
      .post('/v1/owner/jobs')
      .set('Authorization', `Owner ${key}`)
      .send({
        type: 'studio.render_preview',
        correlation_id: 'waiting-1',
        payload: {
          production_id: 'prod-1',
          revision: 1,
          composition: 'stage:renders/1/composition.json',
          canvas: { width: 1280, height: 720 },
          output: 'renders/1/preview.mp4',
        },
        max_attempts: 1,
      });
    const blocked = await claim();
    expect(blocked.body.data).toEqual({ job: null, waiting_interactive: { cpu: 1, gpu: 0 } });
  });

  // ---- Tạm dừng / chạy tiếp / huỷ theo nhóm ----
  it('pauses a batch (queued and running), resumes it and cancels it, without touching other groups or owners', async () => {
    const { key } = await createOwner(ds, 'ag-go');
    const { key: otherKey } = await createOwner(ds, 'other', ['scan.extract']);
    const { token } = await createNode(ds, ['scan.extract']);
    const submit = (ownerKey: string, correlation: string, group: string | null) =>
      request(app.getHttpServer())
        .post('/v1/owner/jobs')
        .set('Authorization', `Owner ${ownerKey}`)
        .send({
          type: 'scan.extract',
          correlation_id: correlation,
          group_key: group,
          payload: {
            asset: { id: randomUUID(), kind: 'video', mime_type: 'video/mp4', size_bytes: null, checksum_sha256: null, duration_ms: null, width: null, height: null },
            extract_version: 'x2',
          },
        });
    const a1 = (await submit(key, 'a1', 'batch:1')).body.data.job;
    const a2 = (await submit(key, 'a2', 'batch:1')).body.data.job;
    const b1 = (await submit(key, 'b1', 'batch:2')).body.data.job;
    const other = (await submit(otherKey, 'o1', 'batch:1')).body.data.job;
    expect(a1.group_key).toBe('batch:1');

    // a1 đang chạy trên worker
    const claim = await request(app.getHttpServer())
      .post('/v1/worker/claim')
      .set('Authorization', `Node ${token}`)
      .send({ kinds: ['scan.extract'], free_slots: { cpu: 1, gpu: 0 }, lanes: ['batch'] });
    const running = claim.body.data.job;
    expect(running.attempt).toBe(1);

    const control = (action: string, body: object, ownerKey = key) =>
      request(app.getHttpServer()).post(`/v1/owner/jobs/${action}`).set('Authorization', `Owner ${ownerKey}`).send(body);

    const paused = await control('pause', { group_key: 'batch:1' });
    expect(paused.body.data).toEqual({ affected: 2 });
    const statusOf = async (id: string) => (await ds.getRepository(FarmJobEntity).findOneByOrFail({ id }));
    expect((await statusOf(other.id)).status).toBe('queued'); // nhóm cùng tên của chủ job khác: không đụng
    expect((await statusOf(b1.id)).status).toBe('queued');

    // Worker đang chạy job bị tạm dừng: 409 job_paused, lần thử không bị tính
    const progress = await request(app.getHttpServer())
      .post(`/v1/worker/jobs/${running.id}/progress`)
      .set('Authorization', `Node ${token}`)
      .send({ lease_token: running.lease_token, percent: 50 });
    expect(progress.status).toBe(409);
    expect(progress.body.error.code).toBe('job_paused');
    const pausedRunning = await statusOf(running.id);
    expect(pausedRunning.status).toBe('paused');
    expect(pausedRunning.attemptCount).toBe(0);
    expect(pausedRunning.nodeId).toBeNull();

    // Job đang tạm dừng không được giao
    const claimWhilePaused = await request(app.getHttpServer())
      .post('/v1/worker/claim')
      .set('Authorization', `Node ${token}`)
      .send({ kinds: ['scan.extract'], free_slots: { cpu: 1, gpu: 0 }, lanes: ['batch'] });
    expect([b1.id, other.id]).toContain(claimWhilePaused.body.data.job.id);

    const resumed = await control('resume', { ids: [a1.id, a2.id, b1.id] });
    expect(resumed.body.data).toEqual({ affected: 2 }); // b1 không ở trạng thái paused
    expect((await statusOf(a2.id)).status).toBe('queued');

    const cancelled = await control('cancel', { group_key: 'batch:1' });
    expect(cancelled.body.data).toEqual({ affected: 2 });
    expect((await statusOf(a1.id)).status).toBe('cancelled');
    expect((await statusOf(other.id)).status).not.toBe('cancelled');

    const bad = await control('pause', {});
    expect(bad.status).toBe(400);
  });

  // ---- Mã cài đặt máy worker ----
  it('enrollment code gives one token per role, once, and re-enrolling a machine rotates its tokens', async () => {
    const enroll = app.get(EnrollService);
    const caps = { os: 'windows', cpu_cores: 28, ram_mb: 65536, gpus: [{ name: 'RTX 4060 Ti', vram_mb: 16380 }] };

    const first = await enroll.create({ machine: 'lan-4060ti', roles: ['scan', 'render'] });
    const res = await request(app.getHttpServer()).post('/v1/enroll').send({ code: first.code, ...caps });
    expect(res.status).toBe(200);
    const nodes = res.body.data.nodes as Array<{ role: string; name: string; kinds: string[]; token: string; package: string }>;
    expect(nodes.map((n) => [n.role, n.name, n.package])).toEqual([
      ['scan', 'lan-4060ti-scan', 'ag-scan-worker'],
      ['render', 'lan-4060ti-render', 'ag-render-worker'],
    ]);
    expect(nodes[0]!.kinds).toEqual(['scan.extract', 'scan.ai']);
    // Bộ cài tải đúng model chủ job dùng
    expect(res.body.data.ollama_models).toEqual(['qwen2.5vl:3b', 'qwen2.5vl:7b']);

    // Token dùng được ngay với API worker
    const me = await request(app.getHttpServer()).get('/v1/worker/me').set('Authorization', `Node ${nodes[0]!.token}`);
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ name: 'lan-4060ti-scan', status: 'active', last_seen_at: null, ollama_models: ['qwen2.5vl:3b', 'qwen2.5vl:7b'] });

    // Mã chỉ dùng một lần
    const again = await request(app.getHttpServer()).post('/v1/enroll').send({ code: first.code, ...caps });
    expect(again.status).toBe(403);

    // Cài lại máy: cùng node, token mới, token cũ hết hiệu lực
    const second = await enroll.create({ machine: 'lan-4060ti', roles: ['scan'] });
    const res2 = await request(app.getHttpServer()).post('/v1/enroll').send({ code: second.code, ...caps });
    expect(res2.status).toBe(200);
    expect(res2.body.data.nodes[0].node_id).toBe(res.body.data.nodes[0].node_id);
    const oldToken = await request(app.getHttpServer()).get('/v1/worker/me').set('Authorization', `Node ${nodes[0]!.token}`);
    expect(oldToken.status).toBe(401);
    expect(await ds.getRepository(FarmNodeEntity).count()).toBe(2);
  });

  it('rejects unknown and expired enrollment codes the same way', async () => {
    const enroll = app.get(EnrollService);
    const caps = { os: 'windows', cpu_cores: 8, ram_mb: 16384 };
    const unknown = await request(app.getHttpServer()).post('/v1/enroll').send({ code: 'agf_not-a-real-code-000000000', ...caps });
    expect(unknown.status).toBe(403);

    const created = await enroll.create({ machine: 'old-box', roles: ['render'] });
    await ds.query(`UPDATE farm_enrollments SET expires_at = now() - interval '1 minute' WHERE id = $1`, [created.id]);
    const expired = await request(app.getHttpServer()).post('/v1/enroll').send({ code: created.code, ...caps });
    expect(expired.status).toBe(403);
    expect(await ds.getRepository(FarmNodeEntity).count()).toBe(0);
  });

  // ---- Owner không thấy job của owner khác ----
  it('owner cannot see other owner jobs', async () => {
    const { key: k1 } = await createOwner(ds, 'ag-go');
    const { key: k2 } = await createOwner(ds, 'studio', ['studio.tts']);

    // k1 gửi job
    const r = await request(app.getHttpServer())
      .post('/v1/owner/jobs')
      .set('Authorization', `Owner ${k1}`)
      .send({
        type: 'scan.extract',
        correlation_id: 'xowner-test',
        payload: {
          asset: {
            id: 'a1b2c3d4-e5f6-4a7b-8c9d-000000000020',
            kind: 'video',
            mime_type: 'video/mp4',
            size_bytes: null,
            checksum_sha256: null,
            duration_ms: null,
            width: null,
            height: null,
          },
          extract_version: 'x1',
        },
        max_attempts: 1,
      });
    const jobId = r.body.data.job.id;

    // k2 không thể lấy job của k1
    const getRes = await request(app.getHttpServer())
      .get(`/v1/owner/jobs/${jobId}`)
      .set('Authorization', `Owner ${k2}`);
    expect(getRes.status).toBe(404);

    // k2 không thể ack job của k1
    const ackRes = await request(app.getHttpServer())
      .post(`/v1/owner/jobs/${jobId}/ack`)
      .set('Authorization', `Owner ${k2}`);
    expect(ackRes.status).toBe(404);
  });

  // ---- Retry backoff và final failure ----
  it('retry backoff and final failure', async () => {
    const { key } = await createOwner(ds, 'ag-go');
    const { token, node } = await createNode(ds);

    // Heartbeat
    await request(app.getHttpServer())
      .post('/v1/worker/heartbeat')
      .set('Authorization', `Node ${token}`)
      .send({
        agent_version: '1.0',
        kinds: ['scan.extract'],
        capabilities: {
          os: 'linux',
          cpu_cores: 4,
          ram_mb: 8192,
          gpus: [],
          engines: { ffmpeg: null, ollama_models: [], python: null },
        },
        free_slots: { cpu: 2, gpu: 0 },
        running_job_ids: [],
      });

    // Submit với max_attempts = 2
    const submitRes = await request(app.getHttpServer())
      .post('/v1/owner/jobs')
      .set('Authorization', `Owner ${key}`)
      .send({
        type: 'scan.extract',
        correlation_id: 'retry-test',
        max_attempts: 2,
        payload: {
          asset: {
            id: 'a1b2c3d4-e5f6-4a7b-8c9d-000000000030',
            kind: 'video',
            mime_type: 'video/mp4',
            size_bytes: null,
            checksum_sha256: null,
            duration_ms: null,
            width: null,
            height: null,
          },
          extract_version: 'x1',
        },
      });
    const jobId = submitRes.body.data.job.id;

    // Attempt 1: claim → fail (retryable)
    const c1 = await request(app.getHttpServer())
      .post('/v1/worker/claim')
      .set('Authorization', `Node ${token}`)
      .send({ kinds: ['scan.extract'], free_slots: { cpu: 2, gpu: 0 }, cached_affinity: [] });
    expect(c1.body.data.job).not.toBeNull();
    const lt1 = c1.body.data.job.lease_token;

    await request(app.getHttpServer())
      .post(`/v1/worker/jobs/${jobId}/fail`)
      .set('Authorization', `Node ${token}`)
      .send({ lease_token: lt1, error: { code: 'test_err', message: 'err', retryable: true } });

    // Job trở về queued với not_before
    const g1 = await ds.getRepository(FarmJobEntity).findOneByOrFail({ id: jobId });
    expect(g1.status).toBe('queued');
    expect(g1.notBefore).toBeTruthy();

    // Đặt not_before về quá khứ để claim được ngay
    await ds.getRepository(FarmJobEntity).update(jobId, { notBefore: new Date(Date.now() - 1000) });

    // Attempt 2: claim → fail lần nữa
    const c2 = await request(app.getHttpServer())
      .post('/v1/worker/claim')
      .set('Authorization', `Node ${token}`)
      .send({ kinds: ['scan.extract'], free_slots: { cpu: 2, gpu: 0 }, cached_affinity: [] });
    expect(c2.body.data.job).not.toBeNull();
    const lt2 = c2.body.data.job.lease_token;

    await request(app.getHttpServer())
      .post(`/v1/worker/jobs/${jobId}/fail`)
      .set('Authorization', `Node ${token}`)
      .send({ lease_token: lt2, error: { code: 'test_err', message: 'err2', retryable: true } });

    // Hết attempts → failed
    const g2 = await ds.getRepository(FarmJobEntity).findOneByOrFail({ id: jobId });
    expect(g2.status).toBe('failed');
    expect(g2.error?.code).toBe('test_err');
  });

  // ---- Reaper: lease hết hạn → job về queue, token cũ bị reject ----
  it('reaper returns expired leases', async () => {
    const { key } = await createOwner(ds, 'ag-go');
    const { token } = await createNode(ds);

    await request(app.getHttpServer())
      .post('/v1/worker/heartbeat')
      .set('Authorization', `Node ${token}`)
      .send({
        agent_version: '1.0',
        kinds: ['scan.extract'],
        capabilities: {
          os: 'linux',
          cpu_cores: 4,
          ram_mb: 8192,
          gpus: [],
          engines: { ffmpeg: null, ollama_models: [], python: null },
        },
        free_slots: { cpu: 2, gpu: 0 },
        running_job_ids: [],
      });

    const submitRes = await request(app.getHttpServer())
      .post('/v1/owner/jobs')
      .set('Authorization', `Owner ${key}`)
      .send({
        type: 'scan.extract',
        correlation_id: 'reaper-test',
        max_attempts: 3,
        payload: {
          asset: {
            id: 'a1b2c3d4-e5f6-4a7b-8c9d-000000000040',
            kind: 'video',
            mime_type: 'video/mp4',
            size_bytes: null,
            checksum_sha256: null,
            duration_ms: null,
            width: null,
            height: null,
          },
          extract_version: 'x1',
        },
      });
    const jobId = submitRes.body.data.job.id;

    // Claim
    const c = await request(app.getHttpServer())
      .post('/v1/worker/claim')
      .set('Authorization', `Node ${token}`)
      .send({ kinds: ['scan.extract'], free_slots: { cpu: 2, gpu: 0 }, cached_affinity: [] });
    const lt = c.body.data.job.lease_token as string;

    // Đặt lease_expires_at về quá khứ
    await ds
      .getRepository(FarmJobEntity)
      .update(jobId, { leaseExpiresAt: new Date(Date.now() - 1000) });

    // Chạy reaper thủ công
    const reaper = app.get(ReaperService);
    const count = await reaper.reap();
    expect(count).toBeGreaterThanOrEqual(1);

    // Job về queued
    const g = await ds.getRepository(FarmJobEntity).findOneByOrFail({ id: jobId });
    expect(g.status).toBe('queued');

    // Token cũ bị reject
    const lateProgress = await request(app.getHttpServer())
      .post(`/v1/worker/jobs/${jobId}/progress`)
      .set('Authorization', `Node ${token}`)
      .send({ lease_token: lt, percent: 50 });
    expect(lateProgress.status).toBe(409);
    expect(lateProgress.body.error.code).toBe('lease_lost');
  });

  // ---- Lease cũ không nộp đè được sau khi máy khác đã claim lại ----
  it('stale lease cannot complete after the job is reclaimed by another node', async () => {
    const { key } = await createOwner(ds, 'ag-go');
    const nodeA = await createNode(ds, ['scan.extract']);
    const nodeB = await createNode(ds, ['scan.extract']);

    const submit = (correlationId: string, assetId: string) =>
      request(app.getHttpServer())
        .post('/v1/owner/jobs')
        .set('Authorization', `Owner ${key}`)
        .send({
          type: 'scan.extract',
          correlation_id: correlationId,
          max_attempts: 3,
          payload: {
            asset: {
              id: assetId,
              kind: 'video',
              mime_type: 'video/mp4',
              size_bytes: null,
              checksum_sha256: null,
              duration_ms: null,
              width: null,
              height: null,
            },
            extract_version: 'x1',
          },
        });
    const claim = (token: string) =>
      request(app.getHttpServer())
        .post('/v1/worker/claim')
        .set('Authorization', `Node ${token}`)
        .send({ kinds: ['scan.extract'], free_slots: { cpu: 1, gpu: 0 }, cached_affinity: [] });
    const complete = (token: string, jobId: string, leaseToken: string) =>
      request(app.getHttpServer())
        .post(`/v1/worker/jobs/${jobId}/complete`)
        .set('Authorization', `Node ${token}`)
        .send({ lease_token: leaseToken, result: { manifest: 'extract.json', summary: {} } });

    const jobId = (await submit('reclaim-race', 'a1b2c3d4-e5f6-4a7b-8c9d-000000000041')).body.data.job
      .id as string;
    const claimA = await claim(nodeA.token);
    expect(claimA.body.data.job.id).toBe(jobId);

    // Lease của A hết hạn, reaper trả job về hàng đợi, B claim lại ngay.
    await ds
      .getRepository(FarmJobEntity)
      .update(jobId, { leaseExpiresAt: new Date(Date.now() - 1000) });
    expect(await app.get(ReaperService).reap()).toBe(1);
    await ds.getRepository(FarmJobEntity).update(jobId, { notBefore: null });
    const claimB = await claim(nodeB.token);
    expect(claimB.body.data.job.id).toBe(jobId);

    const stale = await complete(nodeA.token, jobId, claimA.body.data.job.lease_token);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('lease_lost');
    const stillLeased = await ds.getRepository(FarmJobEntity).findOneByOrFail({ id: jobId });
    expect(stillLeased.status).toBe('leased');
    expect(stillLeased.nodeId).toBe(nodeB.node.id);

    const ok = await complete(nodeB.token, jobId, claimB.body.data.job.lease_token);
    expect(ok.status).toBeLessThan(300);
    expect((await ds.getRepository(FarmJobEntity).findOneByOrFail({ id: jobId })).status).toBe(
      'completed',
    );

    // Reaper không động vào lease vừa được gia hạn.
    await submit('reaper-skip', 'a1b2c3d4-e5f6-4a7b-8c9d-000000000042');
    const claimC = await claim(nodeA.token);
    const progress = await request(app.getHttpServer())
      .post(`/v1/worker/jobs/${claimC.body.data.job.id}/progress`)
      .set('Authorization', `Node ${nodeA.token}`)
      .send({ lease_token: claimC.body.data.job.lease_token, percent: 10 });
    expect(progress.status).toBeLessThan(300);
    expect(await app.get(ReaperService).reap()).toBe(0);
  });

  // ---- Disabled node cannot claim ----
  it('disabled node cannot claim', async () => {
    const { key } = await createOwner(ds, 'ag-go');
    const { token, node } = await createNode(ds);

    // Heartbeat
    await request(app.getHttpServer())
      .post('/v1/worker/heartbeat')
      .set('Authorization', `Node ${token}`)
      .send({
        agent_version: '1.0',
        kinds: ['scan.extract'],
        capabilities: {
          os: 'linux',
          cpu_cores: 4,
          ram_mb: 8192,
          gpus: [],
          engines: { ffmpeg: null, ollama_models: [], python: null },
        },
        free_slots: { cpu: 2, gpu: 0 },
        running_job_ids: [],
      });

    // Submit job
    await request(app.getHttpServer())
      .post('/v1/owner/jobs')
      .set('Authorization', `Owner ${key}`)
      .send({
        type: 'scan.extract',
        correlation_id: 'disabled-test',
        max_attempts: 1,
        payload: {
          asset: {
            id: 'a1b2c3d4-e5f6-4a7b-8c9d-000000000050',
            kind: 'video',
            mime_type: 'video/mp4',
            size_bytes: null,
            checksum_sha256: null,
            duration_ms: null,
            width: null,
            height: null,
          },
          extract_version: 'x1',
        },
      });

    // Disable node
    await ds.getRepository(FarmNodeEntity).update(node.id, { status: 'disabled' });

    // Heartbeat vẫn trả được
    const hb = await request(app.getHttpServer())
      .post('/v1/worker/heartbeat')
      .set('Authorization', `Node ${token}`)
      .send({
        agent_version: '1.0',
        kinds: ['scan.extract'],
        capabilities: {
          os: 'linux',
          cpu_cores: 4,
          ram_mb: 8192,
          gpus: [],
          engines: { ffmpeg: null, ollama_models: [], python: null },
        },
        free_slots: { cpu: 2, gpu: 0 },
        running_job_ids: [],
      });
    expect(hb.status).toBe(200);
    expect(hb.body.data.status).toBe('disabled');

    // Claim trả về null job
    const claimRes = await request(app.getHttpServer())
      .post('/v1/worker/claim')
      .set('Authorization', `Node ${token}`)
      .send({ kinds: ['scan.extract'], free_slots: { cpu: 2, gpu: 0 }, cached_affinity: [] });
    expect(claimRes.status).toBe(200);
    expect(claimRes.body.data.job).toBeNull();
  });

  // ---- Ticket verifies with public key ----
  it('ticket verifies with public key', async () => {
    const { key } = await createOwner(ds, 'ag-go');
    const { token } = await createNode(ds);

    await request(app.getHttpServer())
      .post('/v1/worker/heartbeat')
      .set('Authorization', `Node ${token}`)
      .send({
        agent_version: '1.0',
        kinds: ['scan.extract'],
        capabilities: {
          os: 'linux',
          cpu_cores: 4,
          ram_mb: 8192,
          gpus: [],
          engines: { ffmpeg: null, ollama_models: [], python: null },
        },
        free_slots: { cpu: 4, gpu: 0 },
        running_job_ids: [],
      });

    const submitRes = await request(app.getHttpServer())
      .post('/v1/owner/jobs')
      .set('Authorization', `Owner ${key}`)
      .send({
        type: 'scan.extract',
        correlation_id: 'ticket-test',
        max_attempts: 1,
        payload: {
          asset: {
            id: 'a1b2c3d4-e5f6-4a7b-8c9d-000000000060',
            kind: 'video',
            mime_type: 'video/mp4',
            size_bytes: null,
            checksum_sha256: null,
            duration_ms: null,
            width: null,
            height: null,
          },
          extract_version: 'x1',
        },
      });
    const jobId = submitRes.body.data.job.id;

    const claimRes = await request(app.getHttpServer())
      .post('/v1/worker/claim')
      .set('Authorization', `Node ${token}`)
      .send({ kinds: ['scan.extract'], free_slots: { cpu: 4, gpu: 0 }, cached_affinity: [] });
    expect(claimRes.body.data.job).not.toBeNull();
    const ticket = claimRes.body.data.job.ticket as string;

    // Kiểm bằng PUB_KEY
    const claims = verifyTicket(ticket, PUB_KEY, { owner: 'ag-go' });
    expect(claims.job_id).toBe(jobId);
    expect(claims.owner).toBe('ag-go');
    expect(claims.type).toBe('scan.extract');
    expect(claims.attempt).toBe(1);
  });
});

// ============================================================
// GĐ4: Admin list endpoints, node kinds intersection, delete-with-lease
// ============================================================

describe('ag-farm GĐ4 DB integration', () => {
  let app: INestApplication;
  let ds: DataSource;

  beforeAll(async () => {
    app = await buildAdminApp();
    ds = getDs(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE TABLE farm_jobs, farm_nodes, farm_owners, farm_enrollments RESTART IDENTITY CASCADE');
  });

  // Helper: tạo nhiều jobs cùng owner
  async function seedJobs(ownerKey: string, count: number, type = 'scan.extract') {
    for (let i = 0; i < count; i++) {
      await request(app.getHttpServer())
        .post('/v1/owner/jobs')
        .set('Authorization', `Owner ${ownerKey}`)
        .send({
          type,
          correlation_id: `seed-${i}-${Math.random()}`,
          priority: i,
          payload: {
            asset: {
              id: randomUUID(),
              kind: 'video',
              mime_type: 'video/mp4',
              size_bytes: null,
              checksum_sha256: null,
              duration_ms: null,
              width: null,
              height: null,
            },
            extract_version: 'x1',
          },
        });
    }
  }

  // ---- GET /v1/admin/jobs: pagination ----
  it('GET /v1/admin/jobs returns paged response with correct totals', async () => {
    const { key } = await createOwner(ds, 'ag-go');
    await seedJobs(key, 15);

    const res = await request(app.getHttpServer()).get('/v1/admin/jobs?page=1&pageSize=5');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(5);
    expect(res.body.data.total).toBe(15);
    expect(res.body.data.page).toBe(1);
    expect(res.body.data.pageSize).toBe(5);

    // page 2 cũng đúng
    const res2 = await request(app.getHttpServer()).get('/v1/admin/jobs?page=2&pageSize=5');
    expect(res2.status).toBe(200);
    expect(res2.body.data.items).toHaveLength(5);
    expect(res2.body.data.page).toBe(2);
  });

  // ---- GET /v1/admin/jobs?status=queued: filter ----
  it('GET /v1/admin/jobs filters by status', async () => {
    const { key } = await createOwner(ds, 'ag-go');
    await seedJobs(key, 5);

    // Tất cả vừa tạo đều là queued
    const res = await request(app.getHttpServer()).get('/v1/admin/jobs?status=queued');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(5);
    expect(res.body.data.items.every((j: { status: string }) => j.status === 'queued')).toBe(true);

    // status=failed → 0 kết quả
    const res2 = await request(app.getHttpServer()).get('/v1/admin/jobs?status=failed');
    expect(res2.status).toBe(200);
    expect(res2.body.data.total).toBe(0);
  });

  // ---- GET /v1/admin/jobs?owner=ag-go: filter by owner ----
  it('GET /v1/admin/jobs filters by owner', async () => {
    const { key: k1 } = await createOwner(ds, 'ag-go');
    const { key: k2 } = await createOwner(ds, 'studio', ['scan.extract']);
    await seedJobs(k1, 3);
    await seedJobs(k2, 2);

    const res = await request(app.getHttpServer()).get('/v1/admin/jobs?owner=ag-go');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.items.every((j: { owner: string }) => j.owner === 'ag-go')).toBe(true);
  });

  // ---- GET /v1/admin/jobs?sortBy=priority&sortOrder=asc ----
  it('GET /v1/admin/jobs sorts by priority asc', async () => {
    const { key } = await createOwner(ds, 'ag-go');
    await seedJobs(key, 5); // priority 0..4

    const res = await request(app.getHttpServer()).get('/v1/admin/jobs?sortBy=priority&sortOrder=asc&pageSize=5');
    expect(res.status).toBe(200);
    const priorities = res.body.data.items.map((j: { priority: number }) => j.priority) as number[];
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
  });

  // ---- GET /v1/admin/jobs invalid query → 400 ----
  it('GET /v1/admin/jobs returns 400 for invalid sortBy', async () => {
    const res = await request(app.getHttpServer()).get('/v1/admin/jobs?sortBy=invalid_col');
    expect(res.status).toBe(400);
  });

  it('GET /v1/admin/jobs returns 400 for pageSize > 200', async () => {
    const res = await request(app.getHttpServer()).get('/v1/admin/jobs?pageSize=999');
    expect(res.status).toBe(400);
  });

  it('GET /v1/admin/jobs returns 400 for negative page', async () => {
    const res = await request(app.getHttpServer()).get('/v1/admin/jobs?page=0');
    expect(res.status).toBe(400);
  });

  // ---- GET /v1/admin/jobs/:id returns node_name ----
  it('GET /v1/admin/jobs/:id includes node_name after claim', async () => {
    const { key } = await createOwner(ds, 'ag-go');
    const { token } = await createNode(ds);

    await request(app.getHttpServer())
      .post('/v1/worker/heartbeat')
      .set('Authorization', `Node ${token}`)
      .send({
        agent_version: '1.0',
        kinds: ['scan.extract'],
        capabilities: { os: 'linux', cpu_cores: 4, ram_mb: 8192, gpus: [], engines: { ffmpeg: null, ollama_models: [], python: null } },
        free_slots: { cpu: 2, gpu: 0 },
        running_job_ids: [],
      });

    const submit = await request(app.getHttpServer())
      .post('/v1/owner/jobs')
      .set('Authorization', `Owner ${key}`)
      .send({
        type: 'scan.extract',
        correlation_id: 'detail-test',
        payload: {
          asset: { id: randomUUID(), kind: 'video', mime_type: 'video/mp4', size_bytes: null, checksum_sha256: null, duration_ms: null, width: null, height: null },
          extract_version: 'x1',
        },
      });
    const jobId = submit.body.data.job.id as string;

    await request(app.getHttpServer())
      .post('/v1/worker/claim')
      .set('Authorization', `Node ${token}`)
      .send({ kinds: ['scan.extract'], free_slots: { cpu: 2, gpu: 0 }, cached_affinity: [] });

    const res = await request(app.getHttpServer()).get(`/v1/admin/jobs/${jobId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.node_name).toBe('test-node');
    expect(res.body.data.status).toBe('leased');
    expect(res.body.data).toHaveProperty('payload');
    expect(res.body.data).toHaveProperty('lease_expires_at');
  });

  // ---- GET /v1/admin/nodes pagination ----
  it('GET /v1/admin/nodes returns paged list', async () => {
    for (let i = 0; i < 6; i++) {
      await createNode(ds);
    }
    const res = await request(app.getHttpServer()).get('/v1/admin/nodes?pageSize=4');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(4);
    expect(res.body.data.total).toBe(6);
    expect(res.body.data.pageSize).toBe(4);
  });

  // ---- GET /v1/admin/nodes invalid query → 400 ----
  it('GET /v1/admin/nodes returns 400 for invalid status', async () => {
    const res = await request(app.getHttpServer()).get('/v1/admin/nodes?status=unknown_status');
    expect(res.status).toBe(400);
  });

  // ---- GET /v1/admin/owners pagination ----
  it('GET /v1/admin/owners returns paged list', async () => {
    await createOwner(ds, 'owner-1');
    await createOwner(ds, 'owner-2');
    await createOwner(ds, 'owner-3');

    const res = await request(app.getHttpServer()).get('/v1/admin/owners?pageSize=2&page=1');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.total).toBe(3);
  });

  // ---- Node kinds intersection: allowed_kinds restricts claim ----
  it('allowed_kinds intersection: intersection is empty → no jobs claimed', async () => {
    const { key } = await createOwner(ds, 'ag-go');
    const { token, node } = await createNode(ds, ['scan.extract']);

    // Heartbeat để set kinds
    await request(app.getHttpServer())
      .post('/v1/worker/heartbeat')
      .set('Authorization', `Node ${token}`)
      .send({
        agent_version: '1.0',
        kinds: ['scan.extract'],
        capabilities: { os: 'linux', cpu_cores: 4, ram_mb: 8192, gpus: [], engines: { ffmpeg: null, ollama_models: [], python: null } },
        free_slots: { cpu: 4, gpu: 0 },
        running_job_ids: [],
      });

    // Tạo job scan.extract
    const submit = await request(app.getHttpServer())
      .post('/v1/owner/jobs')
      .set('Authorization', `Owner ${key}`)
      .send({
        type: 'scan.extract',
        correlation_id: 'kinds-intersection-test',
        payload: {
          asset: { id: randomUUID(), kind: 'video', mime_type: 'video/mp4', size_bytes: null, checksum_sha256: null, duration_ms: null, width: null, height: null },
          extract_version: 'x1',
        },
      });
    expect(submit.status).toBe(200);
    const jobId = submit.body.data.job.id as string;

    // Đặt allowed_kinds = ['scan.ai'] → node chỉ được phép claim scan.ai
    // nhưng node báo cáo kinds = ['scan.extract'], giao = [] → không claim được
    await ds.getRepository(FarmNodeEntity).update(node.id, { allowedKinds: ['scan.ai'] });

    const claimRes = await request(app.getHttpServer())
      .post('/v1/worker/claim')
      .set('Authorization', `Node ${token}`)
      .send({ kinds: ['scan.extract'], free_slots: { cpu: 4, gpu: 0 }, cached_affinity: [] });
    expect(claimRes.status).toBe(200);
    // Giao rỗng → không nhận được job nào
    expect(claimRes.body.data.job).toBeNull();

    // Job vẫn queued
    const j = await ds.getRepository(FarmJobEntity).findOneByOrFail({ id: jobId });
    expect(j.status).toBe('queued');
  });

  // ---- Node kinds intersection: allowed_kinds = subset → only matching jobs claimed ----
  it('allowed_kinds intersection: only jobs whose type is in the intersection are claimed', async () => {
    const { key } = await createOwner(ds, 'ag-go');
    const { token, node } = await createNode(ds, ['scan.extract']);

    await request(app.getHttpServer())
      .post('/v1/worker/heartbeat')
      .set('Authorization', `Node ${token}`)
      .send({
        agent_version: '1.0',
        kinds: ['scan.extract'],
        capabilities: { os: 'linux', cpu_cores: 4, ram_mb: 8192, gpus: [], engines: { ffmpeg: null, ollama_models: [], python: null } },
        free_slots: { cpu: 4, gpu: 0 },
        running_job_ids: [],
      });

    // Tạo job scan.extract
    const submit = await request(app.getHttpServer())
      .post('/v1/owner/jobs')
      .set('Authorization', `Owner ${key}`)
      .send({
        type: 'scan.extract',
        correlation_id: 'kinds-subset-test',
        payload: {
          asset: { id: randomUUID(), kind: 'video', mime_type: 'video/mp4', size_bytes: null, checksum_sha256: null, duration_ms: null, width: null, height: null },
          extract_version: 'x1',
        },
      });
    expect(submit.status).toBe(200);

    // allowed_kinds = ['scan.extract'] (khớp) → claim được
    await ds.getRepository(FarmNodeEntity).update(node.id, { allowedKinds: ['scan.extract'] });

    const claimRes = await request(app.getHttpServer())
      .post('/v1/worker/claim')
      .set('Authorization', `Node ${token}`)
      .send({ kinds: ['scan.extract'], free_slots: { cpu: 4, gpu: 0 }, cached_affinity: [] });
    expect(claimRes.status).toBe(200);
    expect(claimRes.body.data.job).not.toBeNull();
    expect(claimRes.body.data.job.type).toBe('scan.extract');
  });

  // ---- Node kinds intersection: allowed_kinds = null → tất cả kinds được phép ----
  it('allowed_kinds = null allows all reported kinds', async () => {
    const { key } = await createOwner(ds, 'ag-go');
    const { token } = await createNode(ds, ['scan.extract']);

    await request(app.getHttpServer())
      .post('/v1/worker/heartbeat')
      .set('Authorization', `Node ${token}`)
      .send({
        agent_version: '1.0',
        kinds: ['scan.extract'],
        capabilities: { os: 'linux', cpu_cores: 4, ram_mb: 8192, gpus: [], engines: { ffmpeg: null, ollama_models: [], python: null } },
        free_slots: { cpu: 4, gpu: 0 },
        running_job_ids: [],
      });

    // allowed_kinds là null (mặc định) → nhận được job scan.extract
    await request(app.getHttpServer())
      .post('/v1/owner/jobs')
      .set('Authorization', `Owner ${key}`)
      .send({
        type: 'scan.extract',
        correlation_id: 'null-kinds-test',
        payload: {
          asset: { id: randomUUID(), kind: 'video', mime_type: 'video/mp4', size_bytes: null, checksum_sha256: null, duration_ms: null, width: null, height: null },
          extract_version: 'x1',
        },
      });

    const claimRes = await request(app.getHttpServer())
      .post('/v1/worker/claim')
      .set('Authorization', `Node ${token}`)
      .send({ kinds: ['scan.extract'], free_slots: { cpu: 4, gpu: 0 }, cached_affinity: [] });
    expect(claimRes.status).toBe(200);
    expect(claimRes.body.data.job).not.toBeNull();
    expect(claimRes.body.data.job.type).toBe('scan.extract');
  });

  // ---- DELETE /v1/admin/nodes/:id with leased job → 409 ----
  it('DELETE /v1/admin/nodes/:id returns 409 when node has a leased job', async () => {
    const { key } = await createOwner(ds, 'ag-go');
    const { token, node } = await createNode(ds);

    await request(app.getHttpServer())
      .post('/v1/worker/heartbeat')
      .set('Authorization', `Node ${token}`)
      .send({
        agent_version: '1.0',
        kinds: ['scan.extract'],
        capabilities: { os: 'linux', cpu_cores: 4, ram_mb: 8192, gpus: [], engines: { ffmpeg: null, ollama_models: [], python: null } },
        free_slots: { cpu: 2, gpu: 0 },
        running_job_ids: [],
      });

    await request(app.getHttpServer())
      .post('/v1/owner/jobs')
      .set('Authorization', `Owner ${key}`)
      .send({
        type: 'scan.extract',
        correlation_id: 'delete-node-test',
        payload: {
          asset: { id: randomUUID(), kind: 'video', mime_type: 'video/mp4', size_bytes: null, checksum_sha256: null, duration_ms: null, width: null, height: null },
          extract_version: 'x1',
        },
      });

    // Node claim job
    await request(app.getHttpServer())
      .post('/v1/worker/claim')
      .set('Authorization', `Node ${token}`)
      .send({ kinds: ['scan.extract'], free_slots: { cpu: 2, gpu: 0 }, cached_affinity: [] });

    // Xoá node đang giữ job → 409
    const del = await request(app.getHttpServer()).delete(`/v1/admin/nodes/${node.id}`);
    expect(del.status).toBe(409);
    expect(del.body.error?.code).toBe('node_has_leased_jobs');
  });

  // ---- DELETE /v1/admin/nodes/:id without leased jobs → 204 ----
  it('DELETE /v1/admin/nodes/:id succeeds when node has no leased jobs', async () => {
    const { node } = await createNode(ds);
    const del = await request(app.getHttpServer()).delete(`/v1/admin/nodes/${node.id}`);
    expect(del.status).toBe(204);
  });
});

