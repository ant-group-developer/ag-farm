import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  ClaimRequest,
  ClaimResponse,
  CompleteRequest,
  FailRequest,
  HeartbeatRequest,
  HeartbeatResponse,
  LEASE_SECONDS,
  ProgressRequest,
  ProgressResponse,
  TICKET_GRACE_SECONDS,
  WorkerMeResponse,
  nodeMeetsRequirements,
  type Requirements,
  signTicket,
  JOB_TYPE_SPECS,
} from '@ag-farm/protocol';
import { randomBytes } from 'node:crypto';
import { DataSource, In, Repository } from 'typeorm';
import { FarmJobEntity } from '../../database/entities/farm-job.entity';

/** Kiểu giá trị cho UPDATE của TypeORM (khác Partial ở các cột jsonb). */
type JobPatch = Parameters<Repository<FarmJobEntity>['update']>[1];
import { FarmNodeEntity } from '../../database/entities/farm-node.entity';
import { FarmOwnerEntity } from '../../database/entities/farm-owner.entity';
import { ollamaModels, parseKeyPem } from '../../config/env';

function leaseToken(): string {
  return randomBytes(32).toString('base64url');
}

function backoffMs(attempt: number): number {
  // min(30s * 2^(attempt-1), 15 min)
  return Math.min(30_000 * Math.pow(2, attempt - 1), 15 * 60_000);
}

/**
 * Lịch chạy do worker tự áp theo giờ của chính máy đó (hub chạy UTC trên VPS, máy ở văn phòng),
 * nên hub chỉ lưu `schedule` để hiển thị. Ngoại lệ duy nhất: `{ paused: true }` để tạm dừng từ web.
 */
function isInsideSchedule(schedule: unknown): boolean {
  return !(schedule && typeof schedule === 'object' && (schedule as { paused?: unknown }).paused === true);
}

@Injectable()
export class WorkerService {
  private readonly logger = new Logger(WorkerService.name);

  constructor(
    @InjectRepository(FarmNodeEntity)
    private readonly nodeRepo: Repository<FarmNodeEntity>,
    @InjectRepository(FarmJobEntity)
    private readonly jobRepo: Repository<FarmJobEntity>,
    @InjectRepository(FarmOwnerEntity)
    private readonly ownerRepo: Repository<FarmOwnerEntity>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async me(node: FarmNodeEntity): Promise<WorkerMeResponse> {
    const fresh = await this.nodeRepo.findOneByOrFail({ id: node.id });
    return {
      node_id: fresh.id,
      name: fresh.name,
      status: fresh.status,
      agent_version: fresh.agentVersion ?? null,
      last_seen_at: fresh.lastSeenAt ? fresh.lastSeenAt.toISOString() : null,
      ollama_models: ollamaModels(this.config.get<string>('FARM_OLLAMA_MODELS')),
    };
  }

  async heartbeat(node: FarmNodeEntity, req: HeartbeatRequest): Promise<HeartbeatResponse> {
    // Chỉ cập nhật `kinds` (kinds báo cáo) — không ghi đè `allowed_kinds` (do admin chỉnh).
    await this.nodeRepo.update(node.id, {
      agentVersion: req.agent_version,
      kinds: req.kinds,
      capabilities: req.capabilities,
      freeSlots: req.free_slots,
      runningJobIds: req.running_job_ids,
      os: req.capabilities.os,
      cpuCores: req.capabilities.cpu_cores,
      ramMb: req.capabilities.ram_mb,
      gpus: req.capabilities.gpus,
      engines: req.capabilities.engines,
      lastSeenAt: new Date(),
    });
    return {
      node_id: node.id,
      server_time: new Date().toISOString(),
      status: node.status,
    };
  }

  async claim(node: FarmNodeEntity, req: ClaimRequest): Promise<ClaimResponse> {
    // Node disabled → từ chối claim
    if (node.status === 'disabled') {
      return { job: null };
    }
    // Kiểm lịch
    if (!isInsideSchedule(node.schedule)) {
      return { job: null };
    }

    const privateKeyPem = parseKeyPem(this.config.getOrThrow<string>('FARM_TICKET_PRIVATE_KEY'));
    const laneFilter = req.lanes ?? ['interactive', 'batch'];
    const cachedAffinity = req.cached_affinity ?? [];
    // Job interactive node làm được nhưng thiếu slot: worker báo cho worker batch cùng máy nhường slot.
    const waiting = { cpu: 0, gpu: 0 };

    const job = await this.dataSource.transaction(async (em) => {
      // Tính giao: reported_kinds ∩ allowed_kinds (null allowed_kinds = tất cả được phép)
      const freshNodeForKinds = await em
        .getRepository(FarmNodeEntity)
        .findOneByOrFail({ id: node.id });
      const effectiveKinds =
        freshNodeForKinds.allowedKinds != null
          ? req.kinds.filter((k) => freshNodeForKinds.allowedKinds!.includes(k))
          : req.kinds;

      if (effectiveKinds.length === 0) return null;

      // Lấy tối đa 50 job queued, SKIP LOCKED
      const qb = em
        .getRepository(FarmJobEntity)
        .createQueryBuilder('j')
        .where('j.status = :status', { status: 'queued' })
        .andWhere('j.type = ANY(:kinds)', { kinds: effectiveKinds })
        .andWhere('j.lane = ANY(:lanes)', { lanes: laneFilter })
        .andWhere('(j.not_before IS NULL OR j.not_before <= now())')
        .orderBy(`(j.lane = 'interactive')`, 'DESC')
        .addOrderBy('j.priority', 'DESC');

      if (cachedAffinity.length > 0) {
        qb.addOrderBy(`(j.affinity_key = ANY(ARRAY[:...aff]))`, 'DESC', 'NULLS LAST')
          .setParameter('aff', cachedAffinity);
      }

      const candidates = await qb
        .addOrderBy('j.created_at', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .limit(50)
        .getMany();

      // Lấy capabilities của node (đã cập nhật trong heartbeat)
      const freshNode = await em.getRepository(FarmNodeEntity).findOneByOrFail({ id: node.id });
      const caps = freshNode.capabilities;
      if (!caps) return null;
      const freeSlots = req.free_slots;

      // Chọn job đầu tiên mà node đáp ứng
      for (const candidate of candidates) {
        const spec = JOB_TYPE_SPECS[candidate.type as keyof typeof JOB_TYPE_SPECS];
        if (!spec) continue;

        // Kiểm requirements
        const reqs = candidate.requirements as Requirements;
        if (!nodeMeetsRequirements(freshNode.id, caps, reqs)) continue;

        // Kiểm slot
        const slotKind = spec.slot;
        const available = slotKind === 'gpu' ? freeSlots.gpu : freeSlots.cpu;
        if (available < 1) {
          if (candidate.lane === 'interactive') waiting[slotKind]++;
          continue;
        }

        // Đánh dấu leased
        const now = new Date();
        const leaseExpiresAt = new Date(now.getTime() + LEASE_SECONDS * 1000);
        const token = leaseToken();
        const newAttempt = candidate.attemptCount + 1;

        await em.getRepository(FarmJobEntity).update(candidate.id, {
          status: 'leased',
          nodeId: freshNode.id,
          leaseToken: token,
          // Tiến độ của lần thử trước không còn đúng
          progressPercent: null,
          progressStage: null,
          leaseExpiresAt,
          attemptCount: newAttempt,
          startedAt: now,
          updatedAt: now,
        });

        candidate.leaseToken = token;
        candidate.leaseExpiresAt = leaseExpiresAt;
        candidate.attemptCount = newAttempt;
        candidate.nodeId = freshNode.id;

        return { job: candidate, owner: null as FarmOwnerEntity | null };
      }
      return null;
    });

    if (!job) {
      return waiting.cpu + waiting.gpu > 0 ? { job: null, waiting_interactive: waiting } : { job: null };
    }

    const { job: claimedJob } = job;

    // Lấy owner để lấy sign_url
    const owner = await this.ownerRepo.findOneOrFail({ where: { id: claimedJob.owner } });

    const leaseExpiresAt = claimedJob.leaseExpiresAt!;
    const ticketExp = Math.floor(leaseExpiresAt.getTime() / 1000) + TICKET_GRACE_SECONDS;
    const ticket = signTicket(
      {
        sub: claimedJob.nodeId!,
        job_id: claimedJob.id,
        owner: claimedJob.owner,
        type: claimedJob.type as any,
        attempt: claimedJob.attemptCount,
        exp: ticketExp,
      },
      privateKeyPem,
    );

    return {
      job: {
        id: claimedJob.id,
        owner: claimedJob.owner,
        type: claimedJob.type as any,
        lane: claimedJob.lane,
        attempt: claimedJob.attemptCount,
        payload: claimedJob.payload,
        lease_token: claimedJob.leaseToken!,
        lease_expires_at: leaseExpiresAt.toISOString(),
        ticket,
        sign_url: owner.signUrl,
      },
    };
  }

  /**
   * Đổi job đang do node này giữ lease. Điều kiện nằm trong câu UPDATE, nên reaper hay huỷ
   * xen vào giữa không thể để lease cũ ghi đè: không dòng nào khớp thì trả 409.
   */
  private async updateOwnLease(
    node: FarmNodeEntity,
    jobId: string,
    leaseTokenValue: string,
    patch: JobPatch,
  ): Promise<void> {
    const result = await this.jobRepo
      .createQueryBuilder()
      .update(FarmJobEntity)
      .set(patch)
      .where('id = :id', { id: jobId })
      .andWhere(`status = 'leased'`)
      .andWhere('node_id = :nodeId', { nodeId: node.id })
      .andWhere('lease_token = :token', { token: leaseTokenValue })
      .execute();
    if (result.affected) return;

    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    if (job.status === 'cancelled') {
      throw new ConflictException({ code: 'job_cancelled', error: 'job_cancelled', message: 'Job has been cancelled' });
    }
    if (job.status === 'paused') {
      throw new ConflictException({ code: 'job_paused', error: 'job_paused', message: 'Job has been paused' });
    }
    throw new ConflictException({ code: 'lease_lost', error: 'lease_lost', message: 'Lease has been lost' });
  }

  async progress(
    node: FarmNodeEntity,
    jobId: string,
    req: ProgressRequest,
  ): Promise<ProgressResponse> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + LEASE_SECONDS * 1000);
    const patch: JobPatch = { leaseExpiresAt, updatedAt: now };
    if (req.percent !== undefined) patch.progressPercent = req.percent;
    if (req.stage !== undefined) patch.progressStage = req.stage;
    await this.updateOwnLease(node, jobId, req.lease_token, patch);

    const job = await this.jobRepo.findOneOrFail({ where: { id: jobId } });
    const privateKeyPem = parseKeyPem(this.config.getOrThrow<string>('FARM_TICKET_PRIVATE_KEY'));
    const ticketExp = Math.floor(leaseExpiresAt.getTime() / 1000) + TICKET_GRACE_SECONDS;
    const ticket = signTicket(
      {
        sub: node.id,
        job_id: jobId,
        owner: job.owner,
        type: job.type as any,
        attempt: job.attemptCount,
        exp: ticketExp,
      },
      privateKeyPem,
    );

    return {
      lease_expires_at: leaseExpiresAt.toISOString(),
      ticket,
    };
  }

  async complete(node: FarmNodeEntity, jobId: string, req: CompleteRequest): Promise<void> {
    const now = new Date();
    await this.updateOwnLease(node, jobId, req.lease_token, {
      status: 'completed',
      result: req.result as FarmJobEntity['result'],
      // The last progress a worker sent (often an early stage, progress is throttled) must not outlive the job.
      progressPercent: 100,
      progressStage: null,
      finishedAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: now,
    });
  }

  async fail(node: FarmNodeEntity, jobId: string, req: FailRequest): Promise<void> {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');

    const now = new Date();
    const canRetry = req.error.retryable && job.attemptCount < job.maxAttempts;
    const patch: JobPatch = canRetry
      ? {
          status: 'queued',
          nodeId: null,
          leaseToken: null,
          leaseExpiresAt: null,
          notBefore: new Date(now.getTime() + backoffMs(job.attemptCount)),
          error: req.error,
          progressPercent: null,
          progressStage: null,
          updatedAt: now,
        }
      : {
          status: 'failed',
          error: req.error,
          finishedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        };
    // attempt_count chỉ đổi khi claim lại, mà claim lại thì lease_token đổi: điều kiện
    // lease trong updateOwnLease đủ bảo đảm `job` đọc ở trên vẫn đúng.
    await this.updateOwnLease(node, jobId, req.lease_token, patch);
  }
}
