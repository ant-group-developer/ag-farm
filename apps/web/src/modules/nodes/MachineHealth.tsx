import { useQuery } from '@tanstack/react-query';
import { Alert, Descriptions, Drawer, Empty, Flex, Progress, Segmented, Tag, Tooltip, Typography, theme } from 'antd';
import dayjs from 'dayjs';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { getMachineMetrics } from '../../api/admin';
import { formatDateTime } from '../../i18n/language';
import type { MachineMetricPoint, MetricRange, NodeView } from '../../types/api';
import { SERIES_COLORS } from '../stats/TimeSeriesChart';
import {
  diskLevel,
  formatGb,
  formatPct,
  formatRate,
  formatUptime,
  gpuView,
  healthSummary,
  isStale,
  levelOf,
  ramPct,
  worstDisk,
  type Level,
} from './machine-health';
import { MetricChart, type MetricSeries } from './MetricChart';

const { Text } = Typography;

/** Lines in the drawer charts: validated pair for two series, then the rest of the stats palette. */
const LINE_COLORS = [SERIES_COLORS.completed, SERIES_COLORS.created, SERIES_COLORS.failed, SERIES_COLORS.cancelled];

function useLevelColor(): (level: Level) => string {
  const { token } = theme.useToken();
  return (level) => (level === 'danger' ? token.colorError : level === 'warning' ? token.colorWarning : token.colorPrimary);
}

/** Greys out a reading the worker stopped refreshing, and says when it is from. */
function Freshness({ node, children }: { node: NodeView; children: ReactNode }) {
  const { t } = useTranslation();
  const stale = isStale(node);
  return (
    <Tooltip title={stale && node.metrics_at ? t('nodes.health.stale', { at: formatDateTime(node.metrics_at) }) : undefined}>
      <div data-stale={stale || undefined} style={{ opacity: stale ? 0.45 : 1, minWidth: 0 }}>
        {children}
      </div>
    </Tooltip>
  );
}

function NoReading() {
  const { t } = useTranslation();
  return (
    <Tooltip title={t('nodes.health.none')}>
      <Text type="secondary">-</Text>
    </Tooltip>
  );
}

/** Number on top, bar below (yellow ≥ 80 %, red ≥ 95 %), optional detail line. */
function MetricBar({ pct, text, level, detail }: { pct: number; text: string; level: Level; detail?: ReactNode }) {
  const color = useLevelColor();
  const { token } = theme.useToken();
  return (
    <Flex vertical gap={0} style={{ minWidth: 0 }}>
      <Text
        style={{
          fontVariantNumeric: 'tabular-nums',
          color: level === 'normal' ? undefined : color(level),
          fontWeight: level === 'normal' ? undefined : 600,
        }}
      >
        {text}
      </Text>
      <Progress
        percent={Math.max(0, Math.min(100, pct))}
        size="small"
        showInfo={false}
        strokeColor={color(level)}
        trailColor={token.colorFillSecondary}
        style={{ margin: 0, lineHeight: 1 }}
        aria-label={text}
      />
      {detail && (
        <Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: '100%' }}>
          {detail}
        </Text>
      )}
    </Flex>
  );
}

export function CpuCell({ node }: { node: NodeView }) {
  const pct = node.metrics?.cpu_pct;
  if (pct == null) return <NoReading />;
  return (
    <Freshness node={node}>
      <MetricBar pct={pct} text={formatPct(pct)} level={levelOf(pct)} />
    </Freshness>
  );
}

export function RamCell({ node }: { node: NodeView }) {
  const { t } = useTranslation();
  const pct = ramPct(node.metrics);
  if (pct == null) return <NoReading />;
  return (
    <Freshness node={node}>
      <MetricBar
        pct={pct}
        text={formatPct(pct)}
        level={levelOf(pct)}
        detail={t('nodes.health.ramOf', {
          used: formatGb(node.metrics!.ram_used_mb!),
          total: formatGb(node.metrics!.ram_total_mb!),
        })}
      />
    </Freshness>
  );
}

export function DiskCell({ node }: { node: NodeView }) {
  const { t } = useTranslation();
  const disk = worstDisk(node.metrics);
  if (!disk) return <NoReading />;
  const all = node.metrics?.disks ?? [];
  return (
    <Freshness node={node}>
      <Tooltip
        title={all.map((d) => (
          <div key={d.path}>
            {t('nodes.health.diskOf', { path: d.path, free: formatGb(d.free_mb), total: formatGb(d.total_mb) })}
          </div>
        ))}
      >
        <div>
          <MetricBar
            pct={disk.used_pct}
            text={t('nodes.health.diskFree', { free: formatGb(disk.free_mb) })}
            level={diskLevel(disk)}
            detail={`${disk.path} · ${formatPct(disk.used_pct)}`}
          />
        </div>
      </Tooltip>
    </Freshness>
  );
}

export function NetCell({ node }: { node: NodeView }) {
  const { t } = useTranslation();
  const m = node.metrics;
  if (m?.net_rx_bps == null && m?.net_tx_bps == null) return <NoReading />;
  return (
    <Freshness node={node}>
      <Flex vertical style={{ fontVariantNumeric: 'tabular-nums' }}>
        <Text aria-label={t('nodes.health.rx')}>↓ {formatRate(m?.net_rx_bps)}</Text>
        <Text type="secondary" aria-label={t('nodes.health.tx')}>
          ↑ {formatRate(m?.net_tx_bps)}
        </Text>
      </Flex>
    </Freshness>
  );
}

export function GpuCell({ node }: { node: NodeView }) {
  const { t } = useTranslation();
  const color = useLevelColor();
  const g = gpuView(node.metrics);
  if (!g || (g.util_pct == null && g.vram_pct == null && g.temp_c == null)) return <NoReading />;
  const gpus = node.metrics?.gpus ?? [];
  const vram = gpus.length === 1 && gpus[0]!.vram_used_mb != null && gpus[0]!.vram_total_mb
    ? t('nodes.health.vram', { used: formatGb(gpus[0]!.vram_used_mb!), total: formatGb(gpus[0]!.vram_total_mb!) })
    : g.vram_pct != null
      ? `VRAM ${formatPct(g.vram_pct)}`
      : null;
  const hot: Level = g.temp_c == null ? 'normal' : g.temp_c >= 90 ? 'danger' : g.temp_c >= 85 ? 'warning' : 'normal';
  const detail = (
    <>
      {vram}
      {vram && g.temp_c != null ? ' · ' : null}
      {g.temp_c != null && (
        <span style={hot === 'normal' ? undefined : { color: color(hot), fontWeight: 600 }}>
          {t('nodes.health.temp', { temp: Math.round(g.temp_c) })}
        </span>
      )}
    </>
  );
  return (
    <Freshness node={node}>
      <Tooltip title={g.count > 1 ? t('nodes.health.gpuCount', { count: g.count }) : undefined}>
        <div>
          <MetricBar
            pct={g.util_pct ?? 0}
            text={formatPct(g.util_pct)}
            level={levelOf(Math.max(g.util_pct ?? 0, g.vram_pct ?? 0))}
            detail={detail}
          />
        </div>
      </Tooltip>
    </Freshness>
  );
}

/** "2 máy sắp đầy ổ, 1 máy RAM > 90 %": per machine, fresh readings only; nothing when every machine is fine. */
export function HealthSummaryBar({ nodes }: { nodes: NodeView[] }) {
  const { t } = useTranslation();
  const s = healthSummary(nodes);
  const parts = (['diskLow', 'ramHigh', 'cpuHigh', 'gpuHot'] as const).filter((k) => s[k].length > 0);
  if (!parts.length) return null;
  const danger = s.diskLow.length > 0 || s.ramHigh.length > 0;
  return (
    <Alert
      type={danger ? 'error' : 'warning'}
      showIcon
      style={{ marginBottom: 12 }}
      message={
        <span>
          {parts.map((k, i) => (
            <span key={k}>
              {i > 0 && ', '}
              <Tooltip title={s[k].join(', ')}>
                <span style={{ textDecoration: 'underline dotted' }}>
                  {t(`nodes.health.summary.${k}`, { count: s[k].length })}
                </span>
              </Tooltip>
            </span>
          ))}
        </span>
      }
    />
  );
}

// ---- Drawer: one machine over time ----

const RANGES: MetricRange[] = ['1h', '24h', '7d'];

function timeLabelFor(range: MetricRange) {
  return (t: string, long?: boolean) => {
    const d = dayjs(t);
    if (long) return d.format('HH:mm DD/MM/YYYY');
    return range === '7d' ? d.format('DD/MM') : d.format('HH:mm');
  };
}

function gpuSeries(points: MachineMetricPoint[], pick: (g: MachineMetricPoint['gpus'][number]) => number | null, label: (i: number) => string): MetricSeries[] {
  const indexes = [...new Set(points.flatMap((p) => p.gpus.map((g) => g.index)))].sort((a, b) => a - b);
  return indexes.map((index, k) => ({
    key: `gpu${index}`,
    label: label(index),
    color: LINE_COLORS[k % LINE_COLORS.length]!,
    values: points.map((p) => {
      const g = p.gpus.find((x) => x.index === index);
      return g ? pick(g) : null;
    }),
  }));
}

export function MachineDrawer({
  machine,
  nodes,
  onClose,
}: {
  machine: string | null;
  /** Nodes of this machine (their latest reading heads the drawer). */
  nodes: NodeView[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [range, setRange] = useState<MetricRange>('1h');
  const query = useQuery({
    queryKey: ['machine-metrics', machine, range],
    queryFn: () => getMachineMetrics(machine!, range),
    enabled: machine !== null,
    refetchInterval: range === '1h' ? 30_000 : 120_000,
    placeholderData: (prev) => (prev?.machine === machine ? prev : undefined),
  });

  const latest = nodes
    .filter((n) => n.metrics && n.metrics_at)
    .sort((a, b) => Date.parse(b.metrics_at!) - Date.parse(a.metrics_at!))[0];
  const points = query.data?.points ?? [];
  const times = points.map((p) => p.t);
  const timeLabel = timeLabelFor(range);
  const hasHistory = points.some((p) => p.cpu_pct != null || p.ram_used_mb != null || p.disk_free_mb != null || p.net_rx_bps != null || p.gpus.length > 0);
  const ramTotalMb = Math.max(0, ...points.map((p) => p.ram_total_mb ?? 0));
  const gb = (v: number) => formatGb(v * 1024);
  const gpuLabel = (index: number) => t('nodes.health.gpuN', { index });
  const gpuUse = gpuSeries(points, (g) => g.util_pct, gpuLabel);
  const gpuTemp = gpuSeries(points, (g) => g.temp_c, gpuLabel);

  return (
    <Drawer
      open={machine !== null}
      onClose={onClose}
      width={760}
      title={machine ? t('nodes.health.drawerTitle', { machine }) : undefined}
      destroyOnHidden
    >
      <Descriptions size="small" column={{ xs: 1, sm: 2 }} style={{ marginBottom: 16 }}>
        <Descriptions.Item label={t('nodes.health.workers')}>
          <Flex wrap gap={4}>
            {nodes.map((n) => (
              <Tag key={n.id} bordered={false} style={{ marginInlineEnd: 0 }}>
                {n.name}
              </Tag>
            ))}
          </Flex>
        </Descriptions.Item>
        <Descriptions.Item label={t('nodes.health.updated')}>
          {latest?.metrics_at ? (
            <Text type={isStale(latest) ? 'secondary' : undefined}>{formatDateTime(latest.metrics_at)}</Text>
          ) : (
            '-'
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t('nodes.health.uptime')}>{formatUptime(latest?.metrics?.uptime_s)}</Descriptions.Item>
        <Descriptions.Item label={t('nodes.health.disks')}>
          <Flex vertical>
            {(latest?.metrics?.disks ?? []).map((d) => (
              <Text key={d.path}>
                {t('nodes.health.diskOf', { path: d.path, free: formatGb(d.free_mb), total: formatGb(d.total_mb) })}
              </Text>
            ))}
            {!latest?.metrics?.disks?.length && '-'}
          </Flex>
        </Descriptions.Item>
      </Descriptions>

      <Segmented<MetricRange>
        value={range}
        onChange={setRange}
        options={RANGES.map((r) => ({ value: r, label: t(`nodes.health.range.${r}`) }))}
        style={{ marginBottom: 16 }}
      />

      {query.isError ? (
        <Alert type="error" showIcon message={t('nodes.health.loadError')} />
      ) : !query.isLoading && !hasHistory ? (
        <Empty description={t('nodes.health.noHistory')} />
      ) : (
        <div
          style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px 24px' }}
          aria-busy={query.isFetching}
        >
          <MetricChart
            title={t('nodes.health.chart.cpu')}
            times={times}
            max={100}
            format={(v) => `${Math.round(v)}%`}
            timeLabel={timeLabel}
            stale={query.isPlaceholderData}
            series={[{ key: 'cpu', label: 'CPU', color: LINE_COLORS[0]!, values: points.map((p) => p.cpu_pct) }]}
          />
          <MetricChart
            title={t('nodes.health.chart.ram')}
            times={times}
            {...(ramTotalMb > 0 ? { max: ramTotalMb / 1024 } : {})}
            format={gb}
            timeLabel={timeLabel}
            stale={query.isPlaceholderData}
            series={[
              {
                key: 'ram',
                label: 'RAM',
                color: LINE_COLORS[1]!,
                values: points.map((p) => (p.ram_used_mb == null ? null : p.ram_used_mb / 1024)),
              },
            ]}
          />
          <MetricChart
            title={t('nodes.health.chart.disk')}
            times={times}
            format={gb}
            timeLabel={timeLabel}
            stale={query.isPlaceholderData}
            series={[
              {
                key: 'disk',
                label: t('nodes.health.disk'),
                color: LINE_COLORS[0]!,
                values: points.map((p) => (p.disk_free_mb == null ? null : p.disk_free_mb / 1024)),
              },
            ]}
          />
          <MetricChart
            title={t('nodes.health.chart.net')}
            times={times}
            format={formatRate}
            timeLabel={timeLabel}
            stale={query.isPlaceholderData}
            series={[
              { key: 'rx', label: `↓ ${t('nodes.health.rx')}`, color: LINE_COLORS[0]!, values: points.map((p) => p.net_rx_bps) },
              { key: 'tx', label: `↑ ${t('nodes.health.tx')}`, color: LINE_COLORS[1]!, values: points.map((p) => p.net_tx_bps) },
            ]}
          />
          {gpuUse.length > 0 && (
            <MetricChart
              title={t('nodes.health.chart.gpu')}
              times={times}
              max={100}
              format={(v) => `${Math.round(v)}%`}
              timeLabel={timeLabel}
              stale={query.isPlaceholderData}
              series={gpuUse}
            />
          )}
          {gpuTemp.some((s) => s.values.some((v) => v != null)) && (
            <MetricChart
              title={t('nodes.health.chart.gpuTemp')}
              times={times}
              format={(v) => `${Math.round(v)}°`}
              timeLabel={timeLabel}
              stale={query.isPlaceholderData}
              series={gpuTemp}
            />
          )}
        </div>
      )}
    </Drawer>
  );
}
