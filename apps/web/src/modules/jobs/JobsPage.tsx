import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Badge,
  Button,
  Col,
  Drawer,
  Dropdown,
  Input,
  Popconfirm,
  Progress,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import { parseAsInteger, parseAsString, parseAsStringEnum, useQueryStates } from 'nuqs';
import { useState } from 'react';
import {
  cancelJob,
  cancelJobs,
  getJob,
  listJobs,
  pauseJobs,
  resumeJobs,
  retryJob,
} from '../../api/admin';
import { SortDropdown } from '../../shared/components/SortDropdown';
import { TableRefreshButton } from '../../shared/components/TableRefreshButton';
import { jobTypeLabel, jobTypeOptions, laneLabel } from '../../shared/lib/job-labels';
import { statusColor, statusLabel } from '../../shared/lib/status';
import { PAGE_TABLE_STICKY } from '../../shared/lib/sticky-table-header';
import { SELECTION_COLUMN_WIDTH, columnsWidth } from '../../shared/lib/table-width';
import type { JobSortBy, JobStatus, JobType, JobView, Lane, SortOrder } from '../../types/api';
import { TERMINAL_JOB_STATUSES } from '../../types/api';
import { formatDateTime } from '../../i18n/language';
import { useTranslation } from 'react-i18next';
import { Ban, ChevronDown, Eye, Pause, Play, RotateCcw } from 'lucide-react';

const { Text } = Typography;

const ALL_STATUSES: JobStatus[] = ['queued', 'leased', 'paused', 'completed', 'failed', 'cancelled'];

const OWNER_OPTIONS = [
  { value: 'ag-go', label: 'ag-go' },
  { value: 'studio', label: 'studio' },
];

type JobSortField = JobSortBy;
const JOB_SORT_FIELDS: readonly { value: JobSortField; label: string }[] = [
  { value: 'createdAt', label: 'Tạo lúc' },
  { value: 'updatedAt', label: 'Cập nhật' },
  { value: 'priority', label: 'Ưu tiên' },
  { value: 'status', label: 'Trạng thái' },
  { value: 'type', label: 'Loại' },
];

/** Trả true khi trạng thái job cần auto-refresh (đang chờ / đang chạy / tạm dừng nhưng có lease). */
function needsRefresh(jobs: JobView[]): boolean {
  return jobs.some((j) => j.status === 'queued' || j.status === 'leased');
}

export function JobsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([]);

  // URL state via nuqs
  const [query, setQuery] = useQueryStates({
    page: parseAsInteger.withDefault(1),
    pageSize: parseAsInteger.withDefault(20),
    sortBy: parseAsStringEnum<JobSortBy>(['createdAt', 'updatedAt', 'priority', 'status', 'type']).withDefault('createdAt'),
    sortOrder: parseAsStringEnum<SortOrder>(['asc', 'desc']).withDefault('desc'),
    status: parseAsString.withDefault(''),
    type: parseAsString.withDefault(''),
    owner: parseAsString.withDefault(''),
    q: parseAsString.withDefault(''),
  });

  const apiQuery = {
    page: query.page,
    pageSize: query.pageSize,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    status: query.status || undefined,
    type: query.type || undefined,
    owner: query.owner || undefined,
    q: query.q || undefined,
  };

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['jobs', apiQuery],
    queryFn: () => listJobs(apiQuery),
    refetchInterval: (q) => {
      const items = q.state.data?.items ?? [];
      return needsRefresh(items) ? 5_000 : false;
    },
  });

  const jobs = data?.items ?? [];
  const total = data?.total ?? 0;

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

  const pauseMut = useMutation({
    mutationFn: (id: string) => pauseJobs({ ids: [id] }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void messageApi.success(t('jobs.paused'));
    },
    onError: (e) => void messageApi.error(String(e)),
  });

  const resumeMut = useMutation({
    mutationFn: (id: string) => resumeJobs({ ids: [id] }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void messageApi.success(t('jobs.resumed'));
    },
    onError: (e) => void messageApi.error(String(e)),
  });

  // Bulk actions
  const bulkPauseMut = useMutation({
    mutationFn: () => pauseJobs({ ids: selectedRowKeys }),
    onSuccess: (r) => {
      setSelectedRowKeys([]);
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void messageApi.success(t('jobs.bulkPaused', { count: r.affected }));
    },
    onError: (e) => void messageApi.error(String(e)),
  });

  const bulkResumeMut = useMutation({
    mutationFn: () => resumeJobs({ ids: selectedRowKeys }),
    onSuccess: (r) => {
      setSelectedRowKeys([]);
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void messageApi.success(t('jobs.bulkResumed', { count: r.affected }));
    },
    onError: (e) => void messageApi.error(String(e)),
  });

  const bulkCancelMut = useMutation({
    mutationFn: () => cancelJobs({ ids: selectedRowKeys }),
    onSuccess: (r) => {
      setSelectedRowKeys([]);
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void messageApi.success(t('jobs.bulkCancelled', { count: r.affected }));
    },
    onError: (e) => void messageApi.error(String(e)),
  });

  // Pause all matching current filters
  const pauseAllMut = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {};
      if (query.status) body.statuses = query.status.split(',').filter(Boolean);
      if (query.type) body.types = query.type.split(',').filter(Boolean);
      if (query.owner) body.owner = query.owner;
      // Fallback: if nothing specific, use statuses queued+leased
      if (!body.statuses && !body.types && !body.owner) {
        body.statuses = ['queued', 'leased'];
      }
      return pauseJobs(body);
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void messageApi.success(t('jobs.pauseAllSuccess', { count: r.affected }));
    },
    onError: (e) => void messageApi.error(String(e)),
  });

  const columns: ColumnsType<JobView> = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 120,
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v}>
          <Text
            style={{ cursor: 'pointer', fontFamily: 'monospace' }}
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
      width: 100,
      ellipsis: true,
    },
    {
      title: t('jobs.type'),
      dataIndex: 'type',
      key: 'type',
      width: 200,
      ellipsis: true,
      render: (v: JobType) => (
        <Tooltip title={v}>
          <Tag color="cyan" style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {jobTypeLabel(v)}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: <Tooltip title={t('jobs.laneHelp')}>{t('jobs.lane')}</Tooltip>,
      dataIndex: 'lane',
      key: 'lane',
      width: 110,
      ellipsis: true,
      render: (v: Lane) => (
        <Tag color={v === 'interactive' ? 'purple' : 'default'}>{laneLabel(v)}</Tag>
      ),
    },
    {
      title: t('jobs.status'),
      dataIndex: 'status',
      key: 'status',
      width: 130,
      ellipsis: true,
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
      width: 100,
      ellipsis: true,
    },
    {
      title: t('jobs.attempts'),
      key: 'attempts',
      width: 110,
      ellipsis: true,
      render: (_: unknown, r: JobView) => `${r.attempt_count}/${r.max_attempts}`,
    },
    {
      title: t('jobs.node'),
      key: 'node',
      width: 160,
      ellipsis: true,
      render: (_: unknown, r: JobView) => {
        const name = r.node_name ?? (r.node_id ? r.node_id.slice(0, 8) + '…' : null);
        return name ? (
          <Tooltip title={r.node_id ?? name}>
            <Text>{name}</Text>
          </Tooltip>
        ) : (
          <Text type="secondary">-</Text>
        );
      },
    },
    {
      title: t('jobs.progress'),
      key: 'progress',
      width: 150,
      ellipsis: true,
      render: (_: unknown, r: JobView) => {
        if (r.progress_percent == null && !r.progress_stage) return <Text type="secondary">-</Text>;
        const pct = r.progress_percent ?? 0;
        return (
          <Tooltip title={`${Math.round(pct)}% ${r.progress_stage ?? ''}`}>
            <Progress percent={Math.round(pct)} size="small" style={{ marginBottom: 0 }} />
          </Tooltip>
        );
      },
    },
    {
      title: t('common.createdAt'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 200,
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v}>
          <Text>{formatDateTime(v)}</Text>
        </Tooltip>
      ),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 120,
      fixed: 'right' as const,
      render: (_: unknown, r: JobView) => {
        const canRetry = r.status === 'failed' || r.status === 'cancelled';
        const canCancel = r.status === 'queued' || r.status === 'leased';
        const canPause = r.status === 'queued' || r.status === 'leased';
        const canResume = r.status === 'paused';
        return (
          <Space size={4}>
            <Tooltip title={t('jobs.details')}>
              <Button size="small" icon={<Eye size={14} />} aria-label={t('jobs.details')} onClick={() => setSelectedJobId(r.id)} />
            </Tooltip>
            {canRetry && (
              <Popconfirm
                title={t('jobs.retryConfirm')}
                onConfirm={() => retryMut.mutate(r.id)}
                okText={t('jobs.retry')}
                cancelText={t('common.cancel')}
              >
                <Tooltip title={t('jobs.retry')}>
                  <Button size="small" type="primary" icon={<RotateCcw size={14} />} aria-label={t('jobs.retry')} />
                </Tooltip>
              </Popconfirm>
            )}
            {canPause && (
              <Popconfirm
                title={t('jobs.pauseConfirm')}
                onConfirm={() => pauseMut.mutate(r.id)}
                okText={t('jobs.pause')}
                cancelText={t('common.cancel')}
              >
                <Tooltip title={t('jobs.pause')}>
                  <Button size="small" icon={<Pause size={14} />} aria-label={t('jobs.pause')} />
                </Tooltip>
              </Popconfirm>
            )}
            {canResume && (
              <Popconfirm
                title={t('jobs.resumeConfirm')}
                onConfirm={() => resumeMut.mutate(r.id)}
                okText={t('jobs.resume')}
                cancelText={t('common.cancel')}
              >
                <Tooltip title={t('jobs.resume')}>
                  <Button size="small" icon={<Play size={14} />} aria-label={t('jobs.resume')} />
                </Tooltip>
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
                <Tooltip title={t('jobs.cancel')}>
                  <Button size="small" danger icon={<Ban size={14} />} aria-label={t('jobs.cancel')} />
                </Tooltip>
              </Popconfirm>
            )}
          </Space>
        );
      },
    },
  ];

  const pagination: TablePaginationConfig = {
    current: query.page,
    pageSize: query.pageSize,
    total,
    showSizeChanger: true,
    pageSizeOptions: ['10', '20', '50', '100', '200'],
    onChange: (p, ps) => {
      void setQuery({ page: p, pageSize: ps });
    },
  };

  return (
    <>
      {contextHolder}
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }} gutter={[8, 8]}>
        <Col>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('jobs.title')}
          </Typography.Title>
        </Col>
        <Col>
          <Space wrap>
            <Input.Search
              placeholder={t('common.search')}
              allowClear
              value={query.q ?? ''}
              onChange={(e) => void setQuery({ q: e.target.value || '', page: 1 })}
              style={{ width: 200 }}
            />
            <Select
              mode="multiple"
              allowClear
              placeholder={t('jobs.status')}
              style={{ minWidth: 160 }}
              value={query.status ? query.status.split(',').filter(Boolean) : []}
              options={ALL_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))}
              onChange={(vals: string[]) =>
                void setQuery({ status: vals.join(',') || '', page: 1 })
              }
            />
            <Select
              mode="multiple"
              allowClear
              placeholder={t('common.jobType')}
              style={{ minWidth: 220 }}
              value={query.type ? query.type.split(',').filter(Boolean) : []}
              options={jobTypeOptions()}
              onChange={(vals: string[]) =>
                void setQuery({ type: vals.join(',') || '', page: 1 })
              }
            />
            <Select
              allowClear
              placeholder={t('jobs.owner')}
              style={{ minWidth: 100 }}
              value={query.owner || undefined}
              options={OWNER_OPTIONS}
              onChange={(val: string | undefined) =>
                void setQuery({ owner: val ?? '', page: 1 })
              }
            />
            <SortDropdown
              fields={JOB_SORT_FIELDS}
              sortBy={query.sortBy}
              sortOrder={query.sortOrder}
              onChange={(change) => void setQuery({ ...change, page: 1 })}
            />
            <TableRefreshButton onRefresh={() => void refetch()} refreshing={isFetching} />
            <Popconfirm
              title={t('jobs.pauseAllConfirm')}
              onConfirm={() => pauseAllMut.mutate()}
              okText={t('jobs.pauseAll')}
              cancelText={t('common.cancel')}
            >
              <Button loading={pauseAllMut.isPending}>{t('jobs.pauseAll')}</Button>
            </Popconfirm>
          </Space>
        </Col>
      </Row>

      {/* Bulk action bar */}
      {selectedRowKeys.length > 0 && (
        <Row style={{ marginBottom: 8 }}>
          <Col>
            <Space>
              <Text>{t('common.selected', { count: selectedRowKeys.length })}</Text>
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    {
                      key: 'pause',
                      label: t('jobs.bulkPause'),
                      onClick: () => bulkPauseMut.mutate(),
                    },
                    {
                      key: 'resume',
                      label: t('jobs.bulkResume'),
                      onClick: () => bulkResumeMut.mutate(),
                    },
                    {
                      key: 'cancel',
                      label: t('jobs.bulkCancel'),
                      danger: true,
                      onClick: () => bulkCancelMut.mutate(),
                    },
                  ],
                }}
              >
                <Button>
                  {t('common.bulkActions')} <ChevronDown size={14} />
                </Button>
              </Dropdown>
              <Button size="small" onClick={() => setSelectedRowKeys([])}>
                {t('common.cancel')}
              </Button>
            </Space>
          </Col>
        </Row>
      )}

      <Table
        rowKey="id"
        dataSource={jobs}
        columns={columns}
        loading={isLoading}
        pagination={pagination}
        sticky={PAGE_TABLE_STICKY}
        tableLayout="fixed"
        scroll={{ x: columnsWidth(columns, SELECTION_COLUMN_WIDTH) }}
        rowSelection={{
          selectedRowKeys,
          onChange: (keys) => setSelectedRowKeys(keys as string[]),
        }}
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
            <JobDetailSection job={selectedJobQuery.data} />
          </Space>
        )}
      </Drawer>
    </>
  );
}

function JobDetailSection({ job }: { job: JobView }) {
  const { t } = useTranslation();
  const rows = [
    ['ID', job.id],
    [t('jobs.owner'), job.owner],
    [t('jobs.type'), `${jobTypeLabel(job.type)} (${job.type})`],
    [t('jobs.lane'), `${laneLabel(job.lane)} (${job.lane})`],
    [t('jobs.status'), statusLabel(job.status)],
    [t('jobs.priority'), String(job.priority)],
    ['Correlation ID', job.correlation_id],
    ['Affinity key', job.affinity_key ?? '-'],
    ['Group key', job.group_key ?? '-'],
    [t('jobs.attempts'), `${job.attempt_count}/${job.max_attempts}`],
    [t('jobs.node'), job.node_name ?? job.node_id ?? '-'],
    [t('jobs.progress'), job.progress_percent != null ? `${Math.round(job.progress_percent)}%` : '-'],
    [t('jobs.stage'), job.progress_stage ?? '-'],
    [t('jobs.notBeforeLabel'), job.not_before ?? '-'],
    [t('jobs.leaseExpiresAtLabel'), job.lease_expires_at ?? '-'],
    [t('common.createdAt'), job.created_at],
    [t('jobs.updatedAt'), job.updated_at],
    [t('jobs.finishedAt'), job.finished_at ?? '-'],
    [t('jobs.ackedAt'), job.acked_at ?? '-'],
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Typography.Text strong>{t('jobs.general')}</Typography.Text>
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={String(label)}>
              <td style={{ padding: '3px 8px 3px 0', color: '#888', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                {label}
              </td>
              <td style={{ padding: '3px 0', wordBreak: 'break-all' }}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {job.payload !== undefined && (
        <>
          <Typography.Text strong>{t('jobs.payload')}</Typography.Text>
          <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 6, overflow: 'auto', fontSize: 11 }}>
            {JSON.stringify(job.payload, null, 2)}
          </pre>
        </>
      )}

      {job.requirements && Object.keys(job.requirements).length > 0 && (
        <>
          <Typography.Text strong>{t('jobs.requirements')}</Typography.Text>
          <pre style={{ background: '#f5f5f5', padding: 12, borderRadius: 6, overflow: 'auto', fontSize: 11 }}>
            {JSON.stringify(job.requirements, null, 2)}
          </pre>
        </>
      )}

      {job.result && (
        <>
          <Typography.Text strong>{t('jobs.result')}</Typography.Text>
          <pre style={{ background: '#f0fff0', padding: 12, borderRadius: 6, overflow: 'auto', fontSize: 11 }}>
            {JSON.stringify(job.result, null, 2)}
          </pre>
        </>
      )}
      {job.error && (
        <>
          <Typography.Text strong type="danger">{t('jobs.error')}</Typography.Text>
          <pre style={{ background: '#fff0f0', padding: 12, borderRadius: 6, overflow: 'auto', fontSize: 11 }}>
            {JSON.stringify(job.error, null, 2)}
          </pre>
        </>
      )}
    </Space>
  );
}
