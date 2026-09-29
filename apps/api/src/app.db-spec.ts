/**
 * DB integration tests cho ag-farm.
 * Yêu cầu Postgres đang chạy ở port 55433 (docker compose -f docker-compose.test.yml up -d).
 * Chạy: yarn workspace @ag-farm/api test:db
 */
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Capabilities, signTicket, verifyTicket } from '@ag-farm/protocol';
import { createHash, generateKeyPairSync as genKeyPair, randomBytes } from 'node:crypto';
import supertest from 'supertest';
const request = supertest;
import { DataSource } from 'typeorm';
import { FarmJobEntity } from './database/entities/farm-job.entity';
import { FarmNodeEntity } from './database/entities/farm-node.entity';
import { FarmOwnerEntity } from './database/entities/farm-owner.entity';
import { Initial1000000000000 } from './database/migrations/1000000000000-initial';
import { ACCOUNT_ME_CLIENT, AdminGuard } from './auth/admin.guard';
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
        entities: [FarmOwnerEntity, FarmNodeEntity, FarmJobEntity],
        migrations: [Initial1000000000000],
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
    defaultLane: 'batch',
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
    await ds.query('TRUNCATE TABLE farm_jobs, farm_nodes, farm_owners RESTART IDENTITY CASCADE');
  });

  // ---- Migration up/down/up ----
  it('migration up/down/up', async () => {
    const runner = ds.createQueryRunner();
    try {
      // down
      await runner.query(`DROP TABLE IF EXISTS farm_jobs`);
      await runner.query(`DROP TABLE IF EXISTS farm_nodes`);
      await runner.query(`DROP TABLE IF EXISTS farm_owners`);
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
    expect(res.body.status).toBe('ok');
  });

  // ---- Full lifecycle: submit â†’ claim â†’ progress â†’ complete â†’ list unacked â†’ ack ----
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
    expect(hbRes.body.node_id).toBe(nodeId);
    expect(hbRes.body.status).toBe('active');

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
    expect(submitRes.body.created).toBe(true);
    const jobId = submitRes.body.job.id as string;

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
    expect(claimRes.body.job).not.toBeNull();
    expect(claimRes.body.job.id).toBe(jobId);
    const leaseToken = claimRes.body.job.lease_token as string;
    const ticket = claimRes.body.job.ticket as string;

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
    expect(progRes.body.ticket).toBeTruthy();

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
    expect(listRes.body.jobs).toHaveLength(1);
    expect(listRes.body.jobs[0].id).toBe(jobId);
    expect(listRes.body.jobs[0].status).toBe('completed');

    // 8. Ack
    const ackRes = await request(app.getHttpServer())
      .post(`/v1/owner/jobs/${jobId}/ack`)
      .set('Authorization', `Owner ${agGoKey}`);
    expect(ackRes.status).toBe(200);
    expect(ackRes.body.acked_at).toBeTruthy();

    // 9. List unacked lại → rỗng
    const listRes2 = await request(app.getHttpServer())
      .get('/v1/owner/jobs?unacked=1')
      .set('Authorization', `Owner ${agGoKey}`);
    expect(listRes2.body.jobs).toHaveLength(0);
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
    expect(r1.body.created).toBe(true);
    const id1 = r1.body.job.id;

    const r2 = await request(app.getHttpServer())
      .post('/v1/owner/jobs')
      .set('Authorization', `Owner ${key}`)
      .send(body);
    expect(r2.status).toBe(200);
    expect(r2.body.created).toBe(false);
    expect(r2.body.job.id).toBe(id1);
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
      jobIds.push(r.body.job.id);
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
      .filter((r) => r.body.job != null)
      .map((r) => r.body.job.id as string);

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
    expect(claimRes.body.job).not.toBeNull();
    expect(claimRes.body.job.lane).toBe('interactive');
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
    const jobId = r.body.job.id;

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
    const jobId = submitRes.body.job.id;

    // Attempt 1: claim â†’ fail (retryable)
    const c1 = await request(app.getHttpServer())
      .post('/v1/worker/claim')
      .set('Authorization', `Node ${token}`)
      .send({ kinds: ['scan.extract'], free_slots: { cpu: 2, gpu: 0 }, cached_affinity: [] });
    expect(c1.body.job).not.toBeNull();
    const lt1 = c1.body.job.lease_token;

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
    expect(c2.body.job).not.toBeNull();
    const lt2 = c2.body.job.lease_token;

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
    const jobId = submitRes.body.job.id;

    // Claim
    const c = await request(app.getHttpServer())
      .post('/v1/worker/claim')
      .set('Authorization', `Node ${token}`)
      .send({ kinds: ['scan.extract'], free_slots: { cpu: 2, gpu: 0 }, cached_affinity: [] });
    const lt = c.body.job.lease_token as string;

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
    expect(lateProgress.body.error).toBe('lease_lost');
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

    const jobId = (await submit('reclaim-race', 'a1b2c3d4-e5f6-4a7b-8c9d-000000000041')).body.job
      .id as string;
    const claimA = await claim(nodeA.token);
    expect(claimA.body.job.id).toBe(jobId);

    // Lease của A hết hạn, reaper trả job về hàng đợi, B claim lại ngay.
    await ds
      .getRepository(FarmJobEntity)
      .update(jobId, { leaseExpiresAt: new Date(Date.now() - 1000) });
    expect(await app.get(ReaperService).reap()).toBe(1);
    await ds.getRepository(FarmJobEntity).update(jobId, { notBefore: null });
    const claimB = await claim(nodeB.token);
    expect(claimB.body.job.id).toBe(jobId);

    const stale = await complete(nodeA.token, jobId, claimA.body.job.lease_token);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('lease_lost');
    const stillLeased = await ds.getRepository(FarmJobEntity).findOneByOrFail({ id: jobId });
    expect(stillLeased.status).toBe('leased');
    expect(stillLeased.nodeId).toBe(nodeB.node.id);

    const ok = await complete(nodeB.token, jobId, claimB.body.job.lease_token);
    expect(ok.status).toBeLessThan(300);
    expect((await ds.getRepository(FarmJobEntity).findOneByOrFail({ id: jobId })).status).toBe(
      'completed',
    );

    // Reaper không động vào lease vừa được gia hạn.
    await submit('reaper-skip', 'a1b2c3d4-e5f6-4a7b-8c9d-000000000042');
    const claimC = await claim(nodeA.token);
    const progress = await request(app.getHttpServer())
      .post(`/v1/worker/jobs/${claimC.body.job.id}/progress`)
      .set('Authorization', `Node ${nodeA.token}`)
      .send({ lease_token: claimC.body.job.lease_token, percent: 10 });
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
    expect(hb.body.status).toBe('disabled');

    // Claim trả về null job
    const claimRes = await request(app.getHttpServer())
      .post('/v1/worker/claim')
      .set('Authorization', `Node ${token}`)
      .send({ kinds: ['scan.extract'], free_slots: { cpu: 2, gpu: 0 }, cached_affinity: [] });
    expect(claimRes.status).toBe(200);
    expect(claimRes.body.job).toBeNull();
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
    const jobId = submitRes.body.job.id;

    const claimRes = await request(app.getHttpServer())
      .post('/v1/worker/claim')
      .set('Authorization', `Node ${token}`)
      .send({ kinds: ['scan.extract'], free_slots: { cpu: 4, gpu: 0 }, cached_affinity: [] });
    expect(claimRes.body.job).not.toBeNull();
    const ticket = claimRes.body.job.ticket as string;

    // Kiểm bằng PUB_KEY
    const claims = verifyTicket(ticket, PUB_KEY, { owner: 'ag-go' });
    expect(claims.job_id).toBe(jobId);
    expect(claims.owner).toBe('ag-go');
    expect(claims.type).toBe('scan.extract');
    expect(claims.attempt).toBe(1);
  });
});

