import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Card, Col, Collapse, Empty, Row, Segmented, Statistic, Table, Tag, Typography, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { parseAsString, parseAsStringEnum, useQueryStates } from 'nuqs';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { getStats, getStatsPeriod } from '../../api/admin';
import { PageHeader } from '../../shared/components/PageHeader';
import { jobTypeLabel } from '../../shared/lib/job-labels';
import { statusColor, statusLabel } from '../../shared/lib/status';
import type { JobStatus, JobType, StatsPeriodPoint, StatsPeriodResponse, StatsPeriodTotals } from '../../types/api';
import { PeriodFilter } from './PeriodFilter';
import {
  PERIOD_MODES,
  bucketLabel,
  formatDuration,
  includesNow,
  previousPeriod,
  resolvePeriod,
  successRate,
  toStatsQuery,
  type PeriodMode,
  type PeriodSelection,
} from './period';
import { TimeSeriesChart } from './TimeSeriesChart';

export function StatsPage() {
  const { t } = useTranslation();

  // ---- Hiện tại (không theo kỳ) ----
  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: getStats,
    refetchInterval: 30_000,
  });
  const data = stats.data;
  const countStatus = (status: JobStatus) =>
    data?.jobs.filter((j) => j.status === status).reduce((s, j) => s + j.count, 0) ?? 0;

  // ---- Theo kỳ: lựa chọn lưu trên URL ----
  const [query, setQuery] = useQueryStates({
    period: parseAsStringEnum<PeriodMode>([...PERIOD_MODES]).withDefault('day'),
    date: parseAsString.withDefault(''),
    start: parseAsString.withDefault(''),
    end: parseAsString.withDefault(''),
  });
  const selection: PeriodSelection = {
    mode: query.period,
    date: query.date,
    start: query.start,
    end: query.end,
  };
  // "Bây giờ" làm tròn phút, đổi mỗi phút: query của kỳ trước (cắt theo phần đã trôi qua) giữ được key ổn định
  const now = useMinute();
  const period = resolvePeriod(selection, now);
  const live = includesNow(period, now);
  const periodQuery = toStatsQuery(period);
  const prevQuery = toStatsQuery(previousPeriod(period, now));

  const current = useQuery({
    queryKey: ['stats-period', periodQuery],
    queryFn: () => getStatsPeriod(periodQuery),
    placeholderData: keepPreviousData,
    refetchInterval: live ? 60_000 : false,
  });
  const previous = useQuery({
    queryKey: ['stats-period', prevQuery],
    queryFn: () => getStatsPeriod(prevQuery),
    placeholderData: keepPreviousData,
  });

  const onFilter = (patch: Partial<PeriodSelection>) =>
    void setQuery({
      ...(patch.mode !== undefined ? { period: patch.mode } : {}),
      ...(patch.date !== undefined ? { date: patch.date || null } : {}),
      ...(patch.start !== undefined ? { start: patch.start || null } : {}),
      ...(patch.end !== undefined ? { end: patch.end || null } : {}),
    });

  const summary = current.data?.summary;
  const prevSummary = previous.data?.summary;

  return (
    <>
      <PageHeader title={t('stats.title')} description={t('stats.description')} />

      <SectionTitle>{t('stats.now')}</SectionTitle>
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} md={6}>
          <Card loading={stats.isLoading}>
            <Statistic
              title={t('stats.nodesOnline')}
              value={data?.nodes.online ?? 0}
              suffix={`/ ${data?.nodes.total ?? 0}`}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card loading={stats.isLoading}>
            <Statistic title={t('stats.running')} value={countStatus('leased')} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card loading={stats.isLoading}>
            <Statistic title={t('stats.queued')} value={countStatus('queued')} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card loading={stats.isLoading}>
            <Statistic title={t('stats.paused')} value={countStatus('paused')} />
          </Card>
        </Col>
      </Row>
      <Collapse
        style={{ marginBottom: 32 }}
        items={[
          {
            key: 'all-time',
            label: t('stats.breakdown'),
            children: <AllTimeTable rows={data?.jobs ?? []} loading={stats.isLoading} />,
          },
        ]}
      />

      <Row justify="space-between" align="middle" gutter={[16, 8]} style={{ marginBottom: 16 }}>
        <Col>
          <SectionTitle style={{ margin: 0 }}>{t('stats.byPeriod')}</SectionTitle>
        </Col>
        <Col>
          <PeriodFilter selection={selection} period={period} onChange={onFilter} />
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <KpiCol>
          <Kpi
            loading={current.isLoading}
            title={t('stats.kpi.created')}
            value={summary?.created ?? 0}
            delta={<Delta cur={summary?.created} prev={prevSummary?.created} good="none" />}
          />
        </KpiCol>
        <KpiCol>
          <Kpi
            loading={current.isLoading}
            title={t('stats.kpi.completed')}
            value={summary?.completed ?? 0}
            delta={<Delta cur={summary?.completed} prev={prevSummary?.completed} good="up" />}
          />
        </KpiCol>
        <KpiCol>
          <Kpi
            loading={current.isLoading}
            title={t('stats.kpi.failed')}
            value={summary?.failed ?? 0}
            delta={<Delta cur={summary?.failed} prev={prevSummary?.failed} good="down" />}
          />
        </KpiCol>
        <KpiCol>
          <Kpi
            loading={current.isLoading}
            title={t('stats.kpi.successRate')}
            value={formatRate(summary && successRate(summary.completed, summary.failed))}
            delta={
              <Delta
                cur={summary && successRate(summary.completed, summary.failed)}
                prev={prevSummary && successRate(prevSummary.completed, prevSummary.failed)}
                good="up"
                points
              />
            }
          />
        </KpiCol>
        <KpiCol>
          <Kpi
            loading={current.isLoading}
            title={t('stats.kpi.avgDuration')}
            tooltip={t('stats.durationHint')}
            value={formatDuration(summary?.avg_duration_ms ?? null)}
            delta={
              summary?.p95_duration_ms != null ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('stats.kpi.p95', { value: formatDuration(summary.p95_duration_ms) })}
                </Typography.Text>
              ) : null
            }
          />
        </KpiCol>
      </Row>

      <SeriesCard data={current.data} loading={current.isLoading} stale={current.isPlaceholderData} now={now} />

      <Card
        title={t('stats.byType')}
        loading={current.isLoading}
        style={{ marginTop: 16, opacity: current.isPlaceholderData ? 0.5 : 1 }}
      >
        <ByTypeTable rows={current.data?.by_type ?? []} />
      </Card>
    </>
  );
}

function useMinute(): Dayjs {
  const [now, setNow] = useState(() => dayjs().startOf('minute'));
  useEffect(() => {
    const id = window.setInterval(() => setNow(dayjs().startOf('minute')), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function SectionTitle({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 12, ...style }}>
      {children}
    </Typography.Title>
  );
}

function KpiCol({ children }: { children: ReactNode }) {
  return (
    <Col xs={12} md={8} xl={{ flex: '20%' }}>
      {children}
    </Col>
  );
}

function Kpi({
  title,
  tooltip,
  value,
  delta,
  loading,
}: {
  title: string;
  tooltip?: string;
  value: number | string;
  delta?: ReactNode;
  loading: boolean;
}) {
  return (
    <Card loading={loading} style={{ height: '100%' }}>
      <Statistic title={<span title={tooltip}>{title}</span>} value={value} />
      <div style={{ minHeight: 20, marginTop: 4 }}>{delta}</div>
    </Card>
  );
}

function formatRate(rate: number | null | undefined): string {
  return rate == null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

/**
 * Thay đổi so với kỳ trước: mũi tên + dấu + số, nên không dựa vào màu. `good` cho biết chiều nào là tốt
 * ("none": chỉ là lưu lượng, không tô màu). `points`: giá trị là tỷ lệ, so bằng điểm phần trăm.
 */
function Delta({
  cur,
  prev,
  good,
  points,
}: {
  cur: number | null | undefined;
  prev: number | null | undefined;
  good: 'up' | 'down' | 'none';
  points?: boolean;
}) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  if (cur == null || prev == null) return null;
  const muted = { color: token.colorTextTertiary, fontSize: 12 };

  const diff = cur - prev;
  if (diff === 0) return <span style={muted}>{t('stats.delta.unchanged')}</span>;
  if (!points && prev === 0) return <span style={muted}>{t('stats.delta.prevZero')}</span>;

  const up = diff > 0;
  const amount = points
    ? t('stats.delta.points', { value: Math.abs(diff * 100).toFixed(1) })
    : `${Math.abs((diff / prev) * 100).toFixed(Math.abs(diff / prev) < 0.1 ? 1 : 0)}%`;
  const color =
    good === 'none'
      ? token.colorTextSecondary
      : (good === 'up') === up
        ? token.colorSuccessText
        : token.colorErrorText;
  return (
    <span style={{ fontSize: 12 }}>
      <span style={{ color }}>
        {up ? '▲' : '▼'} {up ? '+' : '−'}
        {amount}
      </span>{' '}
      <span style={{ color: token.colorTextTertiary }}>{t('stats.delta.vsPrev')}</span>
    </span>
  );
}

function SeriesCard({
  data,
  loading,
  stale,
  now,
}: {
  data: StatsPeriodResponse | undefined;
  loading: boolean;
  stale: boolean;
  now: Dayjs;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const series = data?.series ?? [];
  const bucket = data?.range.bucket ?? 'hour';
  // Bảng chỉ liệt kê các ô đã diễn ra
  const pastSeries = series.filter((p) => !dayjs(p.t).isAfter(now));
  const empty = series.every((p) => p.created + p.completed + p.failed + p.cancelled === 0);

  const columns: ColumnsType<StatsPeriodPoint> = [
    { title: t('stats.time'), dataIndex: 't', key: 't', width: 180, render: (v: string) => bucketLabel(v, bucket, true) },
    ...(['created', 'completed', 'failed', 'cancelled'] as const).map((k) => ({
      title: t(`stats.series.${k}`),
      dataIndex: k,
      key: k,
      width: 120,
      align: 'right' as const,
    })),
  ];

  return (
    <Card
      title={t('stats.chartTitle')}
      loading={loading}
      extra={
        <Segmented
          size="small"
          value={view}
          onChange={(v) => setView(v as 'chart' | 'table')}
          options={[
            { value: 'chart', label: t('stats.view.chart') },
            { value: 'table', label: t('stats.view.table') },
          ]}
        />
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: -8, fontSize: 12 }}>
        {t('stats.chartHint')}
      </Typography.Paragraph>
      {empty && !loading ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('stats.empty')} />
      ) : view === 'chart' ? (
        <TimeSeriesChart points={series} bucket={bucket} stale={stale} now={now} />
      ) : (
        <Table
          size="small"
          rowKey="t"
          dataSource={pastSeries}
          columns={columns}
          pagination={pastSeries.length > 31 ? { pageSize: 31, showSizeChanger: false } : false}
          scroll={{ x: 'max-content' }}
          style={{ opacity: stale ? 0.5 : 1 }}
        />
      )}
    </Card>
  );
}

function ByTypeTable({ rows }: { rows: Array<StatsPeriodTotals & { type: JobType }> }) {
  const { t } = useTranslation();
  const num = (key: 'created' | 'completed' | 'failed' | 'cancelled') => ({
    title: t(`stats.series.${key}`),
    dataIndex: key,
    key,
    width: 110,
    align: 'right' as const,
    sorter: (a: StatsPeriodTotals, b: StatsPeriodTotals) => a[key] - b[key],
  });
  const columns: ColumnsType<StatsPeriodTotals & { type: JobType }> = [
    {
      title: t('common.jobType'),
      dataIndex: 'type',
      key: 'type',
      width: 220,
      render: (v: JobType) => <Tag color="cyan">{jobTypeLabel(v)}</Tag>,
    },
    { ...num('created'), defaultSortOrder: 'descend' },
    num('completed'),
    num('failed'),
    num('cancelled'),
    {
      title: t('stats.kpi.successRate'),
      key: 'rate',
      width: 140,
      align: 'right',
      render: (_, r) => formatRate(successRate(r.completed, r.failed)),
    },
    {
      title: <span title={t('stats.durationHint')}>{t('stats.avg')}</span>,
      key: 'avg',
      width: 110,
      align: 'right',
      render: (_, r) => formatDuration(r.avg_duration_ms),
      sorter: (a, b) => (a.avg_duration_ms ?? -1) - (b.avg_duration_ms ?? -1),
    },
    {
      title: 'p95',
      key: 'p95',
      width: 110,
      align: 'right',
      render: (_, r) => formatDuration(r.p95_duration_ms),
      sorter: (a, b) => (a.p95_duration_ms ?? -1) - (b.p95_duration_ms ?? -1),
    },
  ];
  return (
    <Table
      size="small"
      rowKey="type"
      dataSource={rows}
      columns={columns}
      pagination={false}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('stats.empty')} /> }}
    />
  );
}

function AllTimeTable({
  rows,
  loading,
}: {
  rows: Array<{ status: JobStatus; type: JobType; count: number }>;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const columns: ColumnsType<{ status: JobStatus; type: JobType; count: number }> = [
    {
      title: t('stats.status'),
      dataIndex: 'status',
      key: 'status',
      width: 160,
      render: (v: JobStatus) => (
        <Typography.Text>
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: antStatusToColor(statusColor(v)),
              marginRight: 6,
            }}
          />
          {statusLabel(v)}
        </Typography.Text>
      ),
    },
    {
      title: t('common.jobType'),
      dataIndex: 'type',
      key: 'type',
      width: 240,
      render: (v: JobType) => <Tag color="cyan">{jobTypeLabel(v)}</Tag>,
    },
    {
      title: t('stats.count'),
      dataIndex: 'count',
      key: 'count',
      width: 120,
      align: 'right',
    },
  ];
  return (
    <Table
      size="small"
      loading={loading}
      rowKey={(r) => `${r.status}-${r.type}`}
      dataSource={rows}
      columns={columns}
      pagination={false}
      scroll={{ x: 'max-content' }}
    />
  );
}

function antStatusToColor(antStatus: string): string {
  switch (antStatus) {
    case 'success':
      return '#52c41a';
    case 'processing':
      return '#1677ff';
    case 'error':
      return '#ff4d4f';
    case 'warning':
      return '#faad14';
    default:
      return '#d9d9d9';
  }
}
