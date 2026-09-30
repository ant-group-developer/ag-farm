import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { JobViewSchema } from '@ag-farm/protocol';
import { createHash, randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { FarmJobEntity } from '../../database/entities/farm-job.entity';
import { FarmNodeEntity } from '../../database/entities/farm-node.entity';
import { FarmOwnerEntity } from '../../database/entities/farm-owner.entity';
import type {
  AdminListJobsQuery,
  CreateNodeDto,
  CreateOwnerDto,
  PatchNodeDto,
  PatchOwnerDto,
} from './admin.dto';
import { toNodeView, toOwnerView } from './admin.views';

type NodeView = ReturnType<typeof toNodeView>;
type OwnerView = ReturnType<typeof toOwnerView>;

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

function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ u: updatedAt.toISOString(), i: id }), 'utf8').toString(
    'base64url',
  );
}

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(FarmNodeEntity)
    private readonly nodeRepo: Repository<FarmNodeEntity>,
    @InjectRepository(FarmJobEntity)
    private readonly jobRepo: Repository<FarmJobEntity>,
    @InjectRepository(FarmOwnerEntity)
    private readonly ownerRepo: Repository<FarmOwnerEntity>,
    private readonly config: ConfigService,
  ) {}

  // ---- Nodes ----

  async listNodes() {
    const nodes = await this.nodeRepo.find({ order: { createdAt: 'ASC' } });
    return nodes.map((n) => toNodeView(n, this.isOnline(n)));
  }

  private isOnline(node: FarmNodeEntity): boolean {
    const offlineSeconds = this.config.get<number>('NODE_OFFLINE_AFTER_SECONDS') ?? 90;
    const threshold = new Date(Date.now() - offlineSeconds * 1000);
    return node.lastSeenAt != null && node.lastSeenAt >= threshold;
  }

  async createNode(dto: CreateNodeDto): Promise<{ node: NodeView; token: string }> {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const node = this.nodeRepo.create({
      name: dto.name,
      machine: dto.machine,
      kinds: dto.kinds,
      tokenHash,
      status: 'active',
    });
    const saved = await this.nodeRepo.save(node);
    return { node: toNodeView(saved, false), token };
  }

  async patchNode(id: string, dto: PatchNodeDto): Promise<NodeView> {
    const node = await this.nodeRepo.findOne({ where: { id } });
    if (!node) throw new NotFoundException('Node not found');
    if (dto.name !== undefined) node.name = dto.name;
    if (dto.kinds !== undefined) node.kinds = dto.kinds;
    if (dto.status !== undefined) node.status = dto.status as 'active' | 'disabled';
    if (dto.schedule !== undefined) node.schedule = dto.schedule;
    const saved = await this.nodeRepo.save(node);
    return toNodeView(saved, this.isOnline(saved));
  }

  async deleteNode(id: string): Promise<void> {
    const result = await this.nodeRepo.delete(id);
    if (!result.affected) throw new NotFoundException('Node not found');
  }

  // ---- Jobs ----

  async listJobs(query: AdminListJobsQuery) {
    const qb = this.jobRepo.createQueryBuilder('j');

    if (query.status) {
      const statuses = query.status.split(',').map((s) => s.trim()).filter(Boolean);
      qb.andWhere('j.status = ANY(:statuses)', { statuses });
    }
    if (query.type) {
      const types = query.type.split(',').map((s) => s.trim()).filter(Boolean);
      qb.andWhere('j.type = ANY(:types)', { types });
    }
    if (query.owner) {
      qb.andWhere('j.owner = :owner', { owner: query.owner });
    }

    const limit = query.limit ?? 100;
    if (query.after) {
      const cur = decodeCursor(query.after);
      if (cur) {
        qb.andWhere('(j.updated_at, j.id) > (:updatedAt, :id)', {
          updatedAt: cur.updatedAt,
          id: cur.id,
        });
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

    return { jobs: page.map((j) => JobViewSchema.parse({
      id: j.id,
      owner: j.owner,
      type: j.type,
      lane: j.lane,
      status: j.status,
      priority: j.priority,
      correlation_id: j.correlationId,
      affinity_key: j.affinityKey,
      attempt_count: j.attemptCount,
      max_attempts: j.maxAttempts,
      node_id: j.nodeId,
      progress_percent: j.progressPercent,
      progress_stage: j.progressStage,
      result: j.result,
      error: j.error,
      created_at: j.createdAt.toISOString(),
      updated_at: j.updatedAt.toISOString(),
      finished_at: j.finishedAt?.toISOString() ?? null,
      acked_at: j.ackedAt?.toISOString() ?? null,
    })), next_cursor: nextCursor };
  }

  async getJob(id: string) {
    const j = await this.jobRepo.findOne({ where: { id } });
    if (!j) throw new NotFoundException('Job not found');
    return JobViewSchema.parse({
      id: j.id,
      owner: j.owner,
      type: j.type,
      lane: j.lane,
      status: j.status,
      priority: j.priority,
      correlation_id: j.correlationId,
      affinity_key: j.affinityKey,
      attempt_count: j.attemptCount,
      max_attempts: j.maxAttempts,
      node_id: j.nodeId,
      progress_percent: j.progressPercent,
      progress_stage: j.progressStage,
      result: j.result,
      error: j.error,
      created_at: j.createdAt.toISOString(),
      updated_at: j.updatedAt.toISOString(),
      finished_at: j.finishedAt?.toISOString() ?? null,
      acked_at: j.ackedAt?.toISOString() ?? null,
    });
  }

  async retryJob(id: string) {
    const j = await this.jobRepo.findOne({ where: { id } });
    if (!j) throw new NotFoundException('Job not found');
    if (!['failed', 'cancelled'].includes(j.status)) {
      throw new ConflictException('Only failed or cancelled jobs can be retried');
    }
    await this.jobRepo.update(id, {
      status: 'queued',
      attemptCount: 0,
      error: null,
      result: null,
      nodeId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      startedAt: null,
      finishedAt: null,
      ackedAt: null,
      notBefore: null,
      progressPercent: null,
      progressStage: null,
      updatedAt: new Date(),
    });
    return this.getJob(id);
  }

  async cancelJob(id: string) {
    const j = await this.jobRepo.findOne({ where: { id } });
    if (!j) throw new NotFoundException('Job not found');
    const terminal = ['completed', 'failed', 'cancelled'];
    if (terminal.includes(j.status)) return this.getJob(id);
    await this.jobRepo.update(id, {
      status: 'cancelled',
      finishedAt: new Date(),
      updatedAt: new Date(),
    });
    return this.getJob(id);
  }

  async getStats() {
    const offlineSeconds = this.config.get<number>('NODE_OFFLINE_AFTER_SECONDS') ?? 90;
    const threshold = new Date(Date.now() - offlineSeconds * 1000);

    const [jobRows, nodeRows] = await Promise.all([
      this.jobRepo
        .createQueryBuilder('j')
        .select('j.status', 'status')
        .addSelect('j.type', 'type')
        .addSelect('COUNT(*)', 'count')
        .groupBy('j.status')
        .addGroupBy('j.type')
        .getRawMany<{ status: string; type: string; count: string }>(),
      this.nodeRepo.find(),
    ]);

    const totalNodes = nodeRows.length;
    const onlineNodes = nodeRows.filter(
      (n) => n.lastSeenAt != null && n.lastSeenAt >= threshold,
    ).length;

    return {
      jobs: jobRows.map((r) => ({ status: r.status, type: r.type, count: Number(r.count) })),
      nodes: { total: totalNodes, online: onlineNodes },
    };
  }

  // ---- Owners ----

  async listOwners() {
    const owners = await this.ownerRepo.find({ order: { id: 'ASC' } });
    return owners.map(toOwnerView);
  }

  async createOwner(dto: CreateOwnerDto): Promise<{ owner: OwnerView; key: string }> {
    const key = randomBytes(32).toString('base64url');
    const keyHash = createHash('sha256').update(key).digest('hex');

    const existing = await this.ownerRepo.findOne({ where: { id: dto.id } });
    if (existing) {
      throw new ConflictException(`Owner ${dto.id} already exists`);
    }

    const owner = this.ownerRepo.create({
      id: dto.id,
      keyHash,
      signUrl: dto.sign_url,
      allowedTypes: dto.allowed_types,
      defaultLane: dto.default_lane ?? 'batch',
    });
    const saved = await this.ownerRepo.save(owner);
    return { owner: toOwnerView(saved), key };
  }

  async patchOwner(id: string, dto: PatchOwnerDto): Promise<OwnerView> {
    const owner = await this.ownerRepo.findOne({ where: { id } });
    if (!owner) throw new NotFoundException('Owner not found');
    if (dto.sign_url !== undefined) owner.signUrl = dto.sign_url;
    if (dto.allowed_types !== undefined) owner.allowedTypes = dto.allowed_types;
    if (dto.default_lane !== undefined) owner.defaultLane = dto.default_lane;
    return toOwnerView(await this.ownerRepo.save(owner));
  }
}
