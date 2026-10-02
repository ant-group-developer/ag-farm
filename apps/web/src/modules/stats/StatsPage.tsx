import { useQuery } from '@tanstack/react-query';
import { Card, Col, Row, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { getStats } from '../../api/admin';
import { jobTypeLabel } from '../../shared/lib/job-labels';
import { statusColor, statusLabel } from '../../shared/lib/status';
import { PAGE_TABLE_STICKY } from '../../shared/lib/sticky-table-header';
import type { JobStatus, JobType } from '../../types/api';
import { useTranslation } from 'react-i18next';

export function StatsPage() {
  const { t } = useTranslation();
  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: getStats,
    refetchInterval: 30_000,
  });

  const data = stats.data;

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
    <>
      <Typography.Title level={4} style={{ marginBottom: 16 }}>
        {t('stats.title')}
      </Typography.Title>

      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col xs={12} sm={6}>
          <Card loading={stats.isLoading}>
            <Statistic
              title={t('stats.nodesOnline')}
              value={data?.nodes.online ?? 0}
              suffix={`/ ${data?.nodes.total ?? 0}`}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card loading={stats.isLoading}>
            <Statistic
              title={t('stats.running')}
              value={data?.jobs.filter((j) => j.status === 'leased').reduce((s, j) => s + j.count, 0) ?? 0}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card loading={stats.isLoading}>
            <Statistic
              title={t('stats.queued')}
              value={data?.jobs.filter((j) => j.status === 'queued').reduce((s, j) => s + j.count, 0) ?? 0}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card loading={stats.isLoading}>
            <Statistic
              title={t('stats.failed')}
              value={data?.jobs.filter((j) => j.status === 'failed').reduce((s, j) => s + j.count, 0) ?? 0}
              valueStyle={{ color: '#cf1322' }}
            />
          </Card>
        </Col>
      </Row>

      <Card title={t('stats.breakdown')} loading={stats.isLoading}>
        <Table
          rowKey={(r) => `${r.status}-${r.type}`}
          dataSource={data?.jobs ?? []}
          columns={columns}
          pagination={false}
          sticky={PAGE_TABLE_STICKY}
        />
      </Card>
    </>
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
