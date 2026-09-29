import { useQuery } from '@tanstack/react-query';
import { Card, Col, Row, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { getStats } from '../../api/admin';
import { statusColor, statusLabel } from '../../shared/lib/status';
import type { JobStatus, JobType } from '../../types/api';

export function StatsPage() {
  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: getStats,
    refetchInterval: 30_000,
  });

  const data = stats.data;

  const columns: ColumnsType<{ status: JobStatus; type: JobType; count: number }> = [
    {
      title: 'Trang thai',
      dataIndex: 'status',
      key: 'status',
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
      title: 'Loai viec',
      dataIndex: 'type',
      key: 'type',
      render: (v: JobType) => <Tag color="cyan">{v}</Tag>,
    },
    {
      title: 'So luong',
      dataIndex: 'count',
      key: 'count',
      align: 'right',
    },
  ];

  return (
    <>
      <Typography.Title level={4} style={{ marginBottom: 16 }}>
        Thong ke
      </Typography.Title>

      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col xs={12} sm={6}>
          <Card loading={stats.isLoading}>
            <Statistic
              title="May online"
              value={data?.nodes.online ?? 0}
              suffix={`/ ${data?.nodes.total ?? 0}`}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card loading={stats.isLoading}>
            <Statistic
              title="Viec dang chay"
              value={data?.jobs.filter((j) => j.status === 'leased').reduce((s, j) => s + j.count, 0) ?? 0}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card loading={stats.isLoading}>
            <Statistic
              title="Viec dang cho"
              value={data?.jobs.filter((j) => j.status === 'queued').reduce((s, j) => s + j.count, 0) ?? 0}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card loading={stats.isLoading}>
            <Statistic
              title="Viec that bai"
              value={data?.jobs.filter((j) => j.status === 'failed').reduce((s, j) => s + j.count, 0) ?? 0}
              valueStyle={{ color: '#cf1322' }}
            />
          </Card>
        </Col>
      </Row>

      <Card title="Chi tiet theo trang thai va loai viec" loading={stats.isLoading}>
        <Table
          rowKey={(r) => `${r.status}-${r.type}`}
          dataSource={data?.jobs ?? []}
          columns={columns}
          pagination={false}
          size="small"
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
