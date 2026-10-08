import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  JOB_TYPE_SPECS,
  JobControlRequest,
  JobControlResponse,
  JobView,
  ListJobsQuery,
  ListOwnerNodesResponse,
  ListJobsResponse,
  SubmitJobRequest,
  SubmitJobResponse,
  mergeRequirements,
} from '@ag-farm/protocol';
import { Repository } from 'typeorm';
import { FarmJobEntity } from '../../database/entities/farm-job.entity';
import { FarmNodeEntity } from '../../database/entities/farm-node.entity';
import { FarmOwnerEntity } from '../../database/entities/farm-owner.entity';
import { controlJobs, type JobControlAction } from '../../common/job-control';
import { toJobView } from '../../common/job-view';
import { toOwnerNodeView } from './owner.views';

/** Encode cursor: base64(json({updated_at, id})) */
function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ u: updatedAt.toISOString(), i: id }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { updatedAt: string; id: string } | null {
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      u: string;
      i: string;
    };
    return { updatedAt: obj.u, id: obj.i };
  } catch {
    return null;
  }
}

@Injectable()
export class OwnerService {
  constructor(
    @InjectRepository(FarmJobEntity)
    private readonly jobRepo: Repository<FarmJobEntity>,
    @InjectRepository(FarmNodeEntity)
    private readonly nodeRepo: Repository<FarmNodeEntity>,
    private readonly config: ConfigService,
  ) {}

  /** The active nodes that take at least one of the owner's job types, by name. */
  async listNodes(owner: FarmOwnerEntity): Promise<ListOwnerNodesResponse> {
    const offlineSeconds = this.config.get<number>('NODE_OFFLINE_AFTER_SECONDS') ?? 90;
    const threshold = Date.now() - offlineSeconds * 1000;
    const nodes = await this.nodeRepo.find({ where: { status: 'active' }, order: { name: 'ASC' } });
    return {
      nodes: nodes
        .map((n) => toOwnerNodeView(n, n.lastSeenAt != null && n.lastSeenAt.getTime() >= threshold, owner.allowedTypes))
        .filter((v): v is NonNullable<typeof v> => v !== null),
    };
  }

  async submit(owner: FarmOwnerEntity, req: SubmitJobRequest): Promise<SubmitJobResponse> {
    const spec = JOB_TYPE_SPECS[req.type];
    if (!spec) {
      throw new ForbiddenException(`Unknown job type: ${req.type}`);
    }
    if (!owner.allowedTypes.includes(req.type)) {
      throw new ForbiddenException(`Job type ${req.type} is not allowed for owner ${owner.id}`);
    }

    // Validate payload với spec schema
    const payloadResult = spec.payload.safeParse(req.payload);
    if (!payloadResult.success) {
      throw new ForbiddenException({
        message: 'Invalid payload',
        issues: payloadResult.error.issues,
      });
    }

    // Lane của loại job (render: interactive, quét: batch) trừ khi chủ job chọn khác.
    const lane = req.lane ?? spec.lane;
    const requirements = mergeRequirements(req.type, req.requirements ?? {});

    // Idempotency: ON CONFLICT DO NOTHING
    const existing = await this.jobRepo.findOne({
      where: { owner: owner.id, correlationId: req.correlation_id },
    });
    if (existing) {
      return { job: toJobView(existing), created: false };
    }

    const entity = new FarmJobEntity();
    entity.owner = owner.id;
    entity.type = req.type;
    entity.lane = lane as 'interactive' | 'batch';
    entity.status = 'queued';
    entity.priority = req.priority ?? 0;
    entity.requirements = requirements as Record<string, unknown>;
    entity.affinityKey = req.affinity_key ?? null;
    entity.groupKey = req.group_key ?? null;
    entity.notBefore = req.not_before ? new Date(req.not_before) : null;
    entity.payload = payloadResult.data;
    entity.correlationId = req.correlation_id;
    entity.maxAttempts = req.max_attempts ?? 3;
    entity.attemptCount = 0;

    try {
      const saved = await this.jobRepo.save(entity);
      return { job: toJobView(saved), created: true };
    } catch (err: any) {
      // unique constraint (owner, correlation_id) → race condition
      if (err.code === '23505') {
        const existingAgain = await this.jobRepo.findOneOrFail({
          where: { owner: owner.id, correlationId: req.correlation_id },
        });
        return { job: toJobView(existingAgain), created: false };
      }
      throw err;
    }
  }

  async get(owner: FarmOwnerEntity, jobId: string): Promise<JobView> {
    const job = await this.jobRepo.findOne({ where: { id: jobId, owner: owner.id } });
    if (!job) throw new NotFoundException('Job not found');
    return toJobView(job);
  }

  async list(owner: FarmOwnerEntity, query: ListJobsQuery): Promise<ListJobsResponse> {
    const qb = this.jobRepo
      .createQueryBuilder('j')
      .where('j.owner = :owner', { owner: owner.id });

    if (query.status) {
      const statuses = query.status.split(',').map((s) => s.trim()).filter(Boolean);
      qb.andWhere('j.status = ANY(:statuses)', { statuses });
    }
    if (query.type) {
      const types = query.type.split(',').map((s) => s.trim()).filter(Boolean);
      qb.andWhere('j.type = ANY(:types)', { types });
    }
    if (query.unacked === '1') {
      qb.andWhere("j.status IN ('completed','failed','cancelled')");
      qb.andWhere('j.acked_at IS NULL');
    }

    const limit = Number(query.limit ?? 100);

    if (query.after) {
      const cur = decodeCursor(query.after);
      if (cur) {
        qb.andWhere(
          '(j.updated_at, j.id) > (:updatedAt, :id)',
          { updatedAt: cur.updatedAt, id: cur.id },
        );
      }
    }

    qb.orderBy('j.updated_at', 'ASC').addOrderBy('j.id', 'ASC').limit(limit + 1);

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && page.length > 0
        ? encodeCursor(page[page.length - 1]!.updatedAt, page[page.length - 1]!.id)
        : null;

    return { jobs: page.map(toJobView), next_cursor: nextCursor };
  }

  async ack(owner: FarmOwnerEntity, jobId: string): Promise<JobView> {
    const job = await this.jobRepo.findOne({ where: { id: jobId, owner: owner.id } });
    if (!job) throw new NotFoundException('Job not found');

    const terminal = ['completed', 'failed', 'cancelled'];
    if (!terminal.includes(job.status)) {
      throw new ConflictException('Cannot ack a non-terminal job');
    }
    if (!job.ackedAt) {
      await this.jobRepo.update(jobId, { ackedAt: new Date() });
      job.ackedAt = new Date();
    }
    return toJobView(job);
  }

  async cancel(owner: FarmOwnerEntity, jobId: string): Promise<JobView> {
    const job = await this.jobRepo.findOne({ where: { id: jobId, owner: owner.id } });
    if (!job) throw new NotFoundException('Job not found');

    const terminal = ['completed', 'failed', 'cancelled'];
    if (terminal.includes(job.status)) {
      // Đã kết thúc → trả về như cũ
      return toJobView(job);
    }

    const now = new Date();
    await this.jobRepo.update(jobId, {
      status: 'cancelled',
      finishedAt: now,
      updatedAt: now,
    });
    job.status = 'cancelled';
    job.finishedAt = now;
    return toJobView(job);
  }

  /** Tạm dừng / chạy tiếp / huỷ job của chính chủ job này, theo id hoặc nhóm. */
  async control(owner: FarmOwnerEntity, action: JobControlAction, req: JobControlRequest): Promise<JobControlResponse> {
    const affected = await controlJobs(this.jobRepo, action, {
      owner: owner.id,
      ...(req.ids ? { ids: req.ids } : {}),
      ...(req.group_key ? { groupKey: req.group_key } : {}),
    });
    return { affected };
  }
}
