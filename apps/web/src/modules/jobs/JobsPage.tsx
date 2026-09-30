import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Badge,
  Button,
  Col,
  Drawer,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { cancelJob, getJob, listJobs, retryJob } from '../../api/admin';
import { pollInterval } from '../../shared/lib/poll';
import { statusColor, statusLabel } from '../../shared/lib/status';
import type { AdminListJobsQuery, JobStatus, JobType, JobView } from '../../types/api';
import { JOB_TYPES, TERMINAL_JOB_STATUSES } from '../../types/api';
import { formatDateTime } from '../../i18n/language';
import { useTranslation } from 'react-i18next';

const { Text } = Typography;

const ALL_STATUSES: JobStatus[] = ['queued', 'leased', 'completed', 'failed', 'cancelled'];

const OWNER_OPTIONS = [
  { value: 'ag-go', label: 'ag-go' },
  { value: 'studio', label: 'studio' },
];

export function JobsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();
  const [filters, setFilters] = useState<AdminListJobsQuery>({ limit: 100 });
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, refetch } =
    useInfiniteQuery({
      queryKey: ['jobs', filters],
      queryFn: ({ pageParam }) => listJobs({ ...filters, after: pageParam as string | undefined }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
      refetchInterval: (query) => {
        const pages = (query.state.data?.pages ?? []) as Array<{ jobs: JobView[] }>;
        const statuses = pages.flatMap((p) => p.jobs).map((j: JobView) => j.status);
        return pollInterval(statuses, 5_000);
      },
    });

  const allJobs: JobView[] = data?.pages.flatMap((p) => p.jobs) ?? [];

  const selectedJobQuery = useQuery({
    queryKey: ['jobs', 'detail', selectedJobId],
    queryFn: () => getJob(selectedJobId!),
    enabled: selectedJobId !== null,
  });

  const retryMut = useMutation({
    mutationFn: retryJob,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void messageApi.success(t('jobs.retried'));
    },
    onError: (e) => void messageApi.error(String(e)),
  });

  const cancelMut = useMutation({
    mutationFn: cancelJob,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void messageApi.success(t('jobs.cancelled'));
    },
    onError: (e) => void messageApi.error(String(e)),
  });

  const columns: ColumnsType<JobView> = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 100,
      render: (v: string) => (
        <Tooltip title={v}>
          <Text
            style={{ cursor: 'pointer', fontFamily: 'monospace', fontSize: 11 }}
            onClick={() => setSelectedJobId(v)}
          >
            {v.slice(0, 8)}…
          </Text>
        </Tooltip>
      ),
    },
    {
      title: t('jobs.owner'),
      dataIndex: 'owner',
      key: 'owner',
      width: 80,
    },
    {
      title: t('jobs.type'),
      dataIndex: 'type',
      key: 'type',
      width: 150,
      render: (v: JobType) => <Tag color="cyan">{v}</Tag>,
    },
    {
      title: 'Lane',
      dataIndex: 'lane',
      key: 'lane',
      width: 90,
      render: (v: string) => (
        <Tag color={v === 'interactive' ? 'purple' : 'default'}>{v}</Tag>
      ),
    },
    {
      title: t('jobs.status'),
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (v: JobStatus) => (
        <Badge
          status={statusColor(v) as 'success' | 'error' | 'warning' | 'default' | 'processing'}
          text={statusLabel(v)}
        />
      ),
    },
    {
      title: t('jobs.priority'),
      dataIndex: 'priority',
      key: 'priority',
      width: 80,
    },
    {
      title: t('jobs.attempts'),
      key: 'attempts',
      width: 80,
      render: (_: unknown, r: JobView) => `${r.attempt_count}/${r.max_attempts}`,
    },
    {
      title: t('jobs.node'),
      dataIndex: 'node_id',
      key: 'node_id',
      width: 100,
      render: (v: string | null) =>
        v ? (
          <Tooltip title={v}>
            <Text style={{ fontFamily: 'monospace', fontSize: 11 }}>{v.slice(0, 8)}…</Text>
          </Tooltip>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: t('jobs.progress'),
      key: 'progress',
      width: 120,
      render: (_: unknown, r: JobView) => {
        if (r.progress_percent == null && !r.progress_stage) return <Text type="secondary">—</Text>;
        const pct = r.progress_percent != null ? `${Math.round(r.progress_percent)}%` : '';
        const stage = r.progress_stage ?? '';
        return (
          <Tooltip title={`${pct} ${stage}`}>
            <Text ellipsis style={{ maxWidth: 110, fontSize: 11 }}>
              {[pct, stage].filter(Boolean).join(' ')}
            </Text>
          </Tooltip>
        );
      },
    },
    {
      title: t('common.createdAt'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 140,
      render: (v: string) => (
        <Tooltip title={v}>
          <Text style={{ fontSize: 11 }}>{formatDateTime(v)}</Text>
        </Tooltip>
      ),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 140,
      render: (_: unknown, r: JobView) => {
        const canRetry = r.status === 'failed' || r.status === 'cancelled';
        const canCancel = r.status === 'queued' || r.status === 'leased';
        return (
          <Space size={4}>
            <Button size="small" onClick={() => setSelectedJobId(r.id)}>
              {t('jobs.details')}
            </Button>
            {canRetry && (
              <Popconfirm
                title={t('jobs.retryConfirm')}
                onConfirm={() => retryMut.mutate(r.id)}
                okText={t('jobs.retry')}
                cancelText={t('common.cancel')}
              >
                <Button size="small" type="primary">
                  {t('jobs.retry')}
                </Button>
              </Popconfirm>
            )}
            {canCancel && (
              <Popconfirm
                title={t('jobs.cancelConfirm')}
                onConfirm={() => cancelMut.mutate(r.id)}
                okText={t('jobs.cancelJob')}
                cancelText={t('common.no')}
                okButtonProps={{ danger: true }}
              >
                <Button size="small" danger>
                  {t('jobs.cancel')}
                </Button>
              </Popconfirm>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <>
      {contextHolder}
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }} gutter={8}>
        <Col>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('jobs.title')}
          </Typography.Title>
        </Col>
        <Col>
          <Space wrap>
            <Select
              mode="multiple"
              allowClear
              placeholder={t('jobs.status')}
              style={{ minWidth: 160 }}
              options={ALL_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))}
              onChange={(vals: JobStatus[]) =>
                setFilters((f) => ({ ...f, status: vals.join(',') || undefined, after: undefined }))
              }
            />
            <Select
              mode="multiple"
              allowClear
              placeholder={t('common.jobType')}
              style={{ minWidth: 180 }}
              options={JOB_TYPES.map((t) => ({ value: t, label: t }))}
              onChange={(vals: JobType[]) =>
                setFilters((f) => ({ ...f, type: vals.join(',') || undefined, after: undefined }))
              }
            />
            <Select
              allowClear
              placeholder={t('jobs.owner')}
              style={{ minWidth: 100 }}
              options={OWNER_OPTIONS}
              onChange={(val: string | undefined) =>
                setFilters((f) => ({ ...f, owner: val ?? undefined, after: undefined }))
              }
            />
            <Button onClick={() => void refetch()}>{t('common.reload')}</Button>
          </Space>
        </Col>
      </Row>

      <Table
        rowKey="id"
        dataSource={allJobs}
        columns={columns}
        loading={isLoading}
        pagination={false}
        size="small"
        scroll={{ x: 1200 }}
        footer={() =>
          hasNextPage ? (
            <Button
              loading={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
              block
            >
              {t('common.loadMore')}
            </Button>
          ) : null
        }
      />

      {/* Job detail drawer */}
      <Drawer
        title={t('jobs.detailTitle', { id: selectedJobId?.slice(0, 8) ?? '' })}
        open={selectedJobId !== null}
        onClose={() => setSelectedJobId(null)}
        width={640}
        extra={
          selectedJobQuery.data && (
            <Space>
              {(selectedJobQuery.data.status === 'failed' ||
                selectedJobQuery.data.status === 'cancelled') && (
                <Popconfirm
                  title={t('jobs.retryConfirm')}
                  onConfirm={() => {
                    if (selectedJobId) retryMut.mutate(selectedJobId);
                  }}
                  okText={t('jobs.retry')}
                  cancelText={t('common.cancel')}
                >
                  <Button type="primary" size="small">
                    {t('jobs.retry')}
                  </Button>
                </Popconfirm>
              )}
              {!TERMINAL_JOB_STATUSES.includes(selectedJobQuery.data.status) && (
                <Popconfirm
                  title={t('jobs.cancelConfirm')}
                  onConfirm={() => {
                    if (selectedJobId) cancelMut.mutate(selectedJobId);
                  }}
                  okText={t('jobs.cancelJob')}
                  cancelText={t('common.no')}
                  okButtonProps={{ danger: true }}
                >
                  <Button danger size="small">
                    {t('jobs.cancel')}
                  </Button>
                </Popconfirm>
              )}
            </Space>
          )
        }
      >
        {selectedJobQuery.isLoading && <Typography.Text>{t('common.loading')}</Typography.Text>}
        {selectedJobQuery.data && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <JobDetailSection title={t('jobs.general')} job={selectedJobQuery.data} />
            {selectedJobQuery.data.payload !== undefined && (
              <>
                <Typography.Text strong>Payload:</Typography.Text>
                <pre
                  style={{
                    background: '#f5f5f5',
                    padding: 12,
                    borderRadius: 6,
                    overflow: 'auto',
                    fontSize: 11,
                  }}
                >
                  {JSON.stringify(selectedJobQuery.data.payload, null, 2)}
                </pre>
              </>
            )}
            {selectedJobQuery.data.result && (
              <>
                <Typography.Text strong>{t('jobs.result')}</Typography.Text>
                <pre
                  style={{
                    background: '#f0fff0',
                    padding: 12,
                    borderRadius: 6,
                    overflow: 'auto',
                    fontSize: 11,
                  }}
                >
                  {JSON.stringify(selectedJobQuery.data.result, null, 2)}
                </pre>
              </>
            )}
            {selectedJobQuery.data.error && (
              <>
                <Typography.Text strong type="danger">
                  {t('jobs.error')}
                </Typography.Text>
                <pre
                  style={{
                    background: '#fff0f0',
                    padding: 12,
                    borderRadius: 6,
                    overflow: 'auto',
                    fontSize: 11,
                  }}
                >
                  {JSON.stringify(selectedJobQuery.data.error, null, 2)}
                </pre>
              </>
            )}
          </Space>
        )}
      </Drawer>
    </>
  );
}

function JobDetailSection({ title, job }: { title: string; job: JobView }) {
  const { t } = useTranslation();
  const rows = [
    ['ID', job.id],
    [t('jobs.owner'), job.owner],
    [t('jobs.type'), job.type],
    ['Lane', job.lane],
    [t('jobs.status'), statusLabel(job.status)],
    [t('jobs.priority'), job.priority],
    ['Correlation ID', job.correlation_id],
    ['Affinity key', job.affinity_key ?? '—'],
    [t('jobs.attempts'), `${job.attempt_count}/${job.max_attempts}`],
    [t('jobs.node'), job.node_id ?? '—'],
    [t('jobs.progress'), job.progress_percent != null ? `${Math.round(job.progress_percent)}%` : '—'],
    [t('jobs.stage'), job.progress_stage ?? '—'],
    [t('common.createdAt'), job.created_at],
    [t('jobs.updatedAt'), job.updated_at],
    [t('jobs.finishedAt'), job.finished_at ?? '—'],
    [t('jobs.ackedAt'), job.acked_at ?? '—'],
  ];

  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Typography.Text strong>{title}</Typography.Text>
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={String(label)}>
              <td
                style={{
                  padding: '3px 8px 3px 0',
                  color: '#888',
                  whiteSpace: 'nowrap',
                  verticalAlign: 'top',
                }}
              >
                {label}
              </td>
              <td style={{ padding: '3px 0', wordBreak: 'break-all' }}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Space>
  );
}
