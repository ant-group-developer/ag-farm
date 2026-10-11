import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { Repository } from 'typeorm';
import { FarmJobEntity } from '../../database/entities/farm-job.entity';
import { controlJobs, type JobControlAction, type JobSelector } from '../../common/job-control';
import { FarmNodeEntity } from '../../database/entities/farm-node.entity';
import { FarmOwnerEntity } from '../../database/entities/farm-owner.entity';
import type {
  AdminListJobsQuery,
  AdminListNodesQuery,
  AdminListOwnersQuery,
  AdminStatsPeriodQuery,
  CreateNodeDto,
  CreateOwnerDto,
  PatchNodeDto,
  PatchOwnerDto,
} from './admin.dto';
import { toAdminJobView, toNodeView, toOwnerView } from './admin.views';

type NodeView = ReturnType<typeof toNodeView>;
type OwnerView = ReturnType<typeof toOwnerView>;

/** Tên cột DB tương ứng với tên field sortBy */
const JOB_SORT_COLUMNS: Record<string, string> = {
  createdAt: 'j.created_at',
  updatedAt: 'j.updated_at',
  priority: 'j.priority',
  status: 'j.status',
  type: 'j.type',
};

const NODE_SORT_COLUMNS: Record<string, string> = {
  name: 'n.name',
  lastSeenAt: 'n.last_seen_at',
  createdAt: 'n.created_at',
};

const OWNER_SORT_COLUMNS: Record<string, string> = {
  name: 'o.id',
  createdAt: 'o.created_at',
};

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

  async listNodes(query: AdminListNodesQuery) {
    const qb = this.nodeRepo.createQueryBuilder('n');

    if (query.status) {
      qb.andWhere('n.status = :status', { status: query.status });
    }
    if (query.q) {
      qb.andWhere('(n.name ILIKE :q OR n.machine ILIKE :q)', { q: `%${query.q}%` });
    }

    const sortCol = NODE_SORT_COLUMNS[query.sortBy] ?? 'n.created_at';
    const sortDir = (query.sortOrder?.toUpperCase() ?? 'DESC') as 'ASC' | 'DESC';

    const total = await qb.getCount();
    const page = query.page;
    const pageSize = query.pageSize;
    const offset = (page - 1) * pageSize;

    qb.orderBy(sortCol, sortDir).offset(offset).limit(pageSize);

    const nodes = await qb.getMany();
    return {
      items: nodes.map((n) => toNodeView(n, this.isOnline(n))),
      total,
      page,
      pageSize,
    };
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
    if (dto.allowed_kinds !== undefined) node.allowedKinds = dto.allowed_kinds;
    if (dto.status !== undefined) node.status = dto.status as 'active' | 'disabled';
    if (dto.schedule !== undefined) node.schedule = dto.schedule;
    const saved = await this.nodeRepo.save(node);
    return toNodeView(saved, this.isOnline(saved));
  }

  async deleteNode(id: string): Promise<void> {
    // Kiểm node có job đang leased không → 409
    const leasedCount = await this.jobRepo.count({
      where: { nodeId: id, status: 'leased' },
    });
    if (leasedCount > 0) {
      throw new ConflictException({
        code: 'node_has_leased_jobs',
        message: `Node ${id} currently holds ${leasedCount} leased job(s). Cancel or wait for them to finish before deleting.`,
      });
    }
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
    if (query.node) {
      qb.andWhere('j.node_id = :node', { node: query.node });
    }
    if (query.q) {
      qb.andWhere(
        `(j.id::text ILIKE :q OR j.correlation_id ILIKE :q OR j.group_key ILIKE :q OR j.type ILIKE :q)`,
        { q: `%${query.q}%` },
      );
    }

    const sortCol = JOB_SORT_COLUMNS[query.sortBy] ?? 'j.created_at';
    const sortDir = (query.sortOrder?.toUpperCase() ?? 'DESC') as 'ASC' | 'DESC';

    const total = await qb.getCount();
    const page = query.page;
    const pageSize = query.pageSize;
    const offset = (page - 1) * pageSize;

    qb.orderBy(sortCol, sortDir).addOrderBy('j.id', 'ASC').offset(offset).limit(pageSize);

    const rows = await qb.getMany();

    // Lấy tên node cho từng job (nếu có)
    const nodeIds = [...new Set(rows.map((j) => j.nodeId).filter((id): id is string => id != null))];
    const nodeMap = new Map<string, string>();
    if (nodeIds.length > 0) {
      const nodes = await this.nodeRepo
        .createQueryBuilder('n')
        .select(['n.id', 'n.name'])
        .where('n.id = ANY(:ids)', { ids: nodeIds })
        .getMany();
      for (const n of nodes) nodeMap.set(n.id, n.name);
    }

    return {
      items: rows.map((j) => toAdminJobView(j, j.nodeId ? nodeMap.get(j.nodeId) : null)),
      total,
      page,
      pageSize,
    };
  }

  async getJob(id: string) {
    const j = await this.jobRepo.findOne({ where: { id } });
    if (!j) throw new NotFoundException('Job not found');

    // Lấy tên node nếu có
    let nodeName: string | null = null;
    if (j.nodeId) {
      const node = await this.nodeRepo.findOne({ where: { id: j.nodeId }, select: { id: true, name: true } });
      nodeName = node?.name ?? null;
    }

    return toAdminJobView(j, nodeName);
  }

  /** Tạm dừng / chạy tiếp / huỷ hàng loạt theo id, nhóm, chủ job, loại hoặc trạng thái. */
  async controlJobs(action: JobControlAction, sel: JobSelector): Promise<{ affected: number }> {
    return { affected: await controlJobs(this.jobRepo, action, sel) };
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

  /**
   * Thống kê trong kỳ [from, to): job tạo ra (theo created_at) và job kết thúc (theo finished_at, trạng thái cuối),
   * thời gian chạy của job hoàn tất (lần chạy cuối: finished_at - started_at), gom theo loại và theo ô thời gian.
   * Ô thời gian tính trong múi giờ `tz`; mọi ô trong kỳ đều có mặt, kể cả ô trống.
   */
  async getStatsPeriod(query: AdminStatsPeriodQuery) {
    const { from, to, bucket, tz } = query;
    // bucket đã qua enum nên ghép thẳng được vào interval; from/to/tz đi qua tham số.
    const step = `1 ${bucket}`;

    const [seriesRows, typeRows] = await Promise.all([
      this.jobRepo.query(
        `WITH buckets AS (
           SELECT generate_series(
             date_trunc('${bucket}', $1::timestamptz AT TIME ZONE $3),
             date_trunc('${bucket}', ($2::timestamptz - interval '1 microsecond') AT TIME ZONE $3),
             interval '${step}'
           ) AS b
         ),
         created AS (
           SELECT date_trunc('${bucket}', created_at AT TIME ZONE $3) AS b, COUNT(*) AS n
           FROM farm_jobs
           WHERE created_at >= $1 AND created_at < $2
           GROUP BY 1
         ),
         finished AS (
           SELECT date_trunc('${bucket}', finished_at AT TIME ZONE $3) AS b,
                  COUNT(*) FILTER (WHERE status = 'completed') AS completed,
                  COUNT(*) FILTER (WHERE status = 'failed') AS failed,
                  COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled
           FROM farm_jobs
           WHERE finished_at >= $1 AND finished_at < $2
             AND status IN ('completed', 'failed', 'cancelled')
           GROUP BY 1
         )
         SELECT to_char(buckets.b, 'YYYY-MM-DD"T"HH24:MI:SS') AS t,
                COALESCE(created.n, 0) AS created,
                COALESCE(finished.completed, 0) AS completed,
                COALESCE(finished.failed, 0) AS failed,
                COALESCE(finished.cancelled, 0) AS cancelled
         FROM buckets
         LEFT JOIN created ON created.b = buckets.b
         LEFT JOIN finished ON finished.b = buckets.b
         ORDER BY buckets.b`,
        [from, to, tz],
      ) as Promise<Array<Record<'t' | 'created' | 'completed' | 'failed' | 'cancelled', string>>>,
      this.jobRepo.query(
        `WITH j AS (
           SELECT type, status,
                  created_at >= $1 AND created_at < $2 AS created_in,
                  finished_at >= $1 AND finished_at < $2 AS finished_in,
                  EXTRACT(EPOCH FROM finished_at - started_at) * 1000 AS run_ms
           FROM farm_jobs
           WHERE (created_at >= $1 AND created_at < $2) OR (finished_at >= $1 AND finished_at < $2)
         )
         SELECT type,
                COUNT(*) FILTER (WHERE created_in) AS created,
                COUNT(*) FILTER (WHERE finished_in AND status = 'completed') AS completed,
                COUNT(*) FILTER (WHERE finished_in AND status = 'failed') AS failed,
                COUNT(*) FILTER (WHERE finished_in AND status = 'cancelled') AS cancelled,
                AVG(run_ms) FILTER (WHERE finished_in AND status = 'completed') AS avg_ms,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY run_ms)
                  FILTER (WHERE finished_in AND status = 'completed') AS p95_ms
         FROM j
         GROUP BY GROUPING SETS ((type), ())
         ORDER BY type NULLS FIRST`,
        [from, to],
      ) as Promise<
        Array<{
          type: string | null;
          created: string;
          completed: string;
          failed: string;
          cancelled: string;
          avg_ms: string | number | null;
          p95_ms: string | number | null;
        }>
      >,
    ]);

    const toMs = (v: string | number | null) => (v == null ? null : Math.round(Number(v)));
    const toTotals = (r: (typeof typeRows)[number]) => ({
      created: Number(r.created),
      completed: Number(r.completed),
      failed: Number(r.failed),
      cancelled: Number(r.cancelled),
      avg_duration_ms: toMs(r.avg_ms),
      p95_duration_ms: toMs(r.p95_ms),
    });
    // GROUPING SETS: dòng type = null là tổng của cả kỳ (luôn có, kể cả khi không có job nào).
    const totalRow = typeRows.find((r) => r.type == null);

    return {
      range: { from, to, bucket, tz },
      summary: totalRow
        ? toTotals(totalRow)
        : { created: 0, completed: 0, failed: 0, cancelled: 0, avg_duration_ms: null, p95_duration_ms: null },
      series: seriesRows.map((r) => ({
        t: r.t,
        created: Number(r.created),
        completed: Number(r.completed),
        failed: Number(r.failed),
        cancelled: Number(r.cancelled),
      })),
      by_type: typeRows.filter((r) => r.type != null).map((r) => ({ type: r.type as string, ...toTotals(r) })),
    };
  }

  // ---- Owners ----

  async listOwners(query: AdminListOwnersQuery) {
    const qb = this.ownerRepo.createQueryBuilder('o');

    if (query.q) {
      qb.andWhere('o.id ILIKE :q', { q: `%${query.q}%` });
    }

    const sortCol = OWNER_SORT_COLUMNS[query.sortBy] ?? 'o.created_at';
    const sortDir = (query.sortOrder?.toUpperCase() ?? 'DESC') as 'ASC' | 'DESC';

    const total = await qb.getCount();
    const page = query.page;
    const pageSize = query.pageSize;
    const offset = (page - 1) * pageSize;

    qb.orderBy(sortCol, sortDir).offset(offset).limit(pageSize);

    const owners = await qb.getMany();
    return {
      items: owners.map(toOwnerView),
      total,
      page,
      pageSize,
    };
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
    });
    const saved = await this.ownerRepo.save(owner);
    return { owner: toOwnerView(saved), key };
  }

  async patchOwner(id: string, dto: PatchOwnerDto): Promise<OwnerView> {
    const owner = await this.ownerRepo.findOne({ where: { id } });
    if (!owner) throw new NotFoundException('Owner not found');
    if (dto.sign_url !== undefined) owner.signUrl = dto.sign_url;
    if (dto.allowed_types !== undefined) owner.allowedTypes = dto.allowed_types;
    return toOwnerView(await this.ownerRepo.save(owner));
  }

}

