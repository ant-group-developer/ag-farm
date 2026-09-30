import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FarmJobEntity } from '../../database/entities/farm-job.entity';

/** Kiểu giá trị cho UPDATE của TypeORM (khác Partial ở các cột jsonb). */
type JobPatch = Parameters<Repository<FarmJobEntity>['update']>[1];

function backoffMs(attempt: number): number {
  return Math.min(30_000 * Math.pow(2, attempt - 1), 15 * 60_000);
}

/**
 * Reaper: quét định kỳ các job đang leased nhưng đã hết hạn.
 * Job hết hạn: nếu còn lần thử thì đưa về queued + not_before (backoff), không thì failed.
 */
@Injectable()
export class ReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReaperService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    @InjectRepository(FarmJobEntity)
    private readonly jobRepo: Repository<FarmJobEntity>,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.config.get<number>('REAPER_INTERVAL_MS') ?? 15_000;
    this.timer = setInterval(() => {
      this.reap().catch((err: unknown) => {
        this.logger.error('Reaper error', err);
      });
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Dùng trong test để gọi thủ công */
  async reap(): Promise<number> {
    const now = new Date();

    // Tìm tất cả job leased đã hết hạn
    const expired = await this.jobRepo
      .createQueryBuilder('j')
      .where('j.status = :status', { status: 'leased' })
      .andWhere('j.lease_expires_at < :now', { now })
      .getMany();

    if (expired.length === 0) return 0;

    let processed = 0;
    for (const job of expired) {
      const canRetry = job.attemptCount < job.maxAttempts;
      const patch: JobPatch = canRetry
        ? {
            status: 'queued',
            nodeId: null,
            leaseToken: null,
            leaseExpiresAt: null,
            notBefore: new Date(now.getTime() + backoffMs(job.attemptCount)),
            error: { code: 'lease_expired', message: 'Lease expired', retryable: true },
            progressPercent: null,
            progressStage: null,
            updatedAt: now,
          }
        : {
            status: 'failed',
            error: { code: 'lease_expired', message: 'Lease expired, no more retries', retryable: false },
            finishedAt: now,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: now,
          };
      // Chỉ lấy lại khi lease vẫn đúng là lease đã hết hạn lúc quét: progress vừa gia hạn
      // (lease_expires_at mới) hay complete xen vào thì câu UPDATE không khớp dòng nào.
      const result = await this.jobRepo
        .createQueryBuilder()
        .update(FarmJobEntity)
        .set(patch)
        .where('id = :id', { id: job.id })
        .andWhere(`status = 'leased'`)
        .andWhere('lease_token = :token', { token: job.leaseToken })
        .andWhere('lease_expires_at < :now', { now })
        .execute();
      if (result.affected) processed++;
    }

    if (processed > 0) {
      this.logger.log(`Reaper processed ${processed} expired leases`);
    }
    return processed;
  }
}
