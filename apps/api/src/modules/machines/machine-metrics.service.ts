import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MachineMetrics } from '@ag-farm/protocol';
import { DataSource } from 'typeorm';
import { METRIC_RANGES, downsample, toMetricColumns, type MetricRange, type MetricRow } from './machine-metrics';

/** Mặc định giữ lịch sử số đo máy 7 ngày. */
export const MACHINE_METRICS_KEEP_DAYS_DEFAULT = 7;

/** Lịch sử tình trạng máy (`farm_machine_metrics`): ghi từ heartbeat, đọc cho biểu đồ, reaper dọn. */
@Injectable()
export class MachineMetricsService {
  constructor(
    private readonly ds: DataSource,
    private readonly config: ConfigService,
  ) {}

  /**
   * Ghi số đo vào dòng của phút hiện tại. Các node cùng máy (và các heartbeat trong cùng phút) ghi chung một dòng: giữ
   * số mới nhất, số nào lần này không có thì giữ số cũ (GPU/mạng đo thay phiên).
   */
  async record(machine: string, metrics: MachineMetrics, at: Date = new Date()): Promise<void> {
    const c = toMetricColumns(metrics);
    await this.ds.query(
      `INSERT INTO farm_machine_metrics
         (machine, at, cpu_pct, ram_used_mb, ram_total_mb, disk_free_mb, disk_total_mb, disks, net_rx_bps, net_tx_bps, gpu)
       VALUES ($1, date_trunc('minute', $2::timestamptz), $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb)
       ON CONFLICT (machine, at) DO UPDATE SET
         cpu_pct = COALESCE(EXCLUDED.cpu_pct, farm_machine_metrics.cpu_pct),
         ram_used_mb = COALESCE(EXCLUDED.ram_used_mb, farm_machine_metrics.ram_used_mb),
         ram_total_mb = COALESCE(EXCLUDED.ram_total_mb, farm_machine_metrics.ram_total_mb),
         disk_free_mb = COALESCE(EXCLUDED.disk_free_mb, farm_machine_metrics.disk_free_mb),
         disk_total_mb = COALESCE(EXCLUDED.disk_total_mb, farm_machine_metrics.disk_total_mb),
         disks = COALESCE(EXCLUDED.disks, farm_machine_metrics.disks),
         net_rx_bps = COALESCE(EXCLUDED.net_rx_bps, farm_machine_metrics.net_rx_bps),
         net_tx_bps = COALESCE(EXCLUDED.net_tx_bps, farm_machine_metrics.net_tx_bps),
         gpu = COALESCE(EXCLUDED.gpu, farm_machine_metrics.gpu)`,
      [
        machine,
        at.toISOString(),
        c.cpu_pct,
        c.ram_used_mb,
        c.ram_total_mb,
        c.disk_free_mb,
        c.disk_total_mb,
        c.disks ? JSON.stringify(c.disks) : null,
        c.net_rx_bps,
        c.net_tx_bps,
        c.gpu ? JSON.stringify(c.gpu) : null,
      ],
    );
  }

  /** Chuỗi điểm cho biểu đồ một máy, gom còn ≤ 300 điểm. */
  async series(machine: string, range: MetricRange, now: Date = new Date()) {
    const spec = METRIC_RANGES[range];
    const from = new Date(now.getTime() - spec.ms);
    const rows: MetricRow[] = await this.ds.query(
      `SELECT machine, at, cpu_pct, ram_used_mb, ram_total_mb, disk_free_mb, disk_total_mb, disks,
              net_rx_bps, net_tx_bps, gpu
       FROM farm_machine_metrics
       WHERE machine = $1 AND at >= $2 AND at <= $3
       ORDER BY at`,
      [machine, from.toISOString(), now.toISOString()],
    );
    return {
      machine,
      range,
      bucket_seconds: spec.bucketSeconds,
      from: from.toISOString(),
      to: now.toISOString(),
      points: downsample(rows, from, now, spec.bucketSeconds),
    };
  }

  keepDays(): number {
    return Number(this.config.get('MACHINE_METRICS_KEEP_DAYS') ?? MACHINE_METRICS_KEEP_DAYS_DEFAULT);
  }

  /** Xoá dòng cũ hơn `before`, từng lô (không khoá bảng lâu); trả số dòng đã xoá. */
  async prune(before: Date, batch = 5_000, maxBatches = 100): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const res: unknown = await this.ds.query(
        `DELETE FROM farm_machine_metrics
         WHERE ctid = ANY(ARRAY(SELECT ctid FROM farm_machine_metrics WHERE at < $1 LIMIT $2))`,
        [before.toISOString(), batch],
      );
      // pg qua TypeORM trả [rows, rowCount] cho DELETE
      const n = Array.isArray(res) && typeof res[1] === 'number' ? res[1] : 0;
      total += n;
      if (n < batch) break;
    }
    return total;
  }
}
