import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Badge,
  Button,
  Col,
  Dropdown,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import { parseAsInteger, parseAsString, parseAsStringEnum, useQueryStates } from 'nuqs';
import { useState } from 'react';
import { createNode, deleteNode, listNodes, patchNode } from '../../api/admin';
import { SecretModal } from '../../shared/components/SecretModal';
import { SortDropdown } from '../../shared/components/SortDropdown';
import { TableRefreshButton } from '../../shared/components/TableRefreshButton';
import { PAGE_TABLE_STICKY } from '../../shared/lib/sticky-table-header';
import type { JobType, NodeSortBy, NodeView, SortOrder } from '../../types/api';
import { JOB_TYPES } from '../../types/api';
import { formatDateTime } from '../../i18n/language';
import { useTranslation } from 'react-i18next';
import { ChevronDown, KeyRound, Plus, TerminalSquare } from 'lucide-react';
import { EnrollModal } from './EnrollModal';

const { Text } = Typography;

const NODE_SORT_FIELDS: readonly { value: NodeSortBy; label: string }[] = [
  { value: 'createdAt', label: 'Tạo lúc' },
  { value: 'name', label: 'Tên' },
  { value: 'lastSeenAt', label: 'Lần cuối thấy' },
];

function CapabilitiesSummary({ node }: { node: NodeView }) {
  const caps = node.capabilities;
  if (!caps) return <Text type="secondary">—</Text>;
  const parts: string[] = [];
  parts.push(`${caps.os}`);
  parts.push(`${caps.cpu_cores} CPU`);
  parts.push(`${Math.round(caps.ram_mb / 1024)} GB RAM`);
  if (caps.gpus.length > 0) {
    for (const gpu of caps.gpus) {
      parts.push(`${gpu.name} ${Math.round(gpu.vram_mb / 1024)}GB${gpu.nvenc ? ' NVENC' : ''}`);
    }
  }
  if (caps.engines.ffmpeg) parts.push('ffmpeg');
  if (caps.engines.ollama_models.length > 0) {
    parts.push(`Ollama: ${caps.engines.ollama_models.join(', ')}`);
  }
  if (caps.engines.python) parts.push(`py${caps.engines.python}`);
  return (
    <Tooltip title={parts.join(' | ')}>
      <Text ellipsis style={{ maxWidth: 280 }}>
        {parts.join(' | ')}
      </Text>
    </Tooltip>
  );
}

export function NodesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();
  const [createOpen, setCreateOpen] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [editNode, setEditNode] = useState<NodeView | null>(null);
  const [secret, setSecret] = useState<{ title: string; label: string; value: string } | null>(null);
  const [form] = Form.useForm<{ name: string; machine?: string; kinds: JobType[] }>();
  const [editForm] = Form.useForm<{ name: string; kinds: JobType[]; allowed_kinds: JobType[] | null }>();

  // URL state via nuqs
  const [query, setQuery] = useQueryStates({
    page: parseAsInteger.withDefault(1),
    pageSize: parseAsInteger.withDefault(20),
    sortBy: parseAsStringEnum<NodeSortBy>(['name', 'lastSeenAt', 'createdAt']).withDefault('createdAt'),
    sortOrder: parseAsStringEnum<SortOrder>(['asc', 'desc']).withDefault('desc'),
    q: parseAsString.withDefault(''),
  });

  const apiQuery = {
    page: query.page,
    pageSize: query.pageSize,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    q: query.q || undefined,
  };

  const nodesQuery = useQuery({
    queryKey: ['nodes', apiQuery],
    queryFn: () => listNodes(apiQuery),
    refetchInterval: 10_000,
  });

  const nodes = nodesQuery.data?.items ?? [];
  const total = nodesQuery.data?.total ?? 0;

  const createMut = useMutation({
    mutationFn: createNode,
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['nodes'] });
      setCreateOpen(false);
      form.resetFields();
      setSecret({ title: t('nodes.tokenTitle'), label: t('nodes.tokenLabel'), value: data.token });
    },
    onError: (e) => void messageApi.error(String(e)),
  });

  const patchMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof patchNode>[1] }) =>
      patchNode(id, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['nodes'] }),
    onError: (e) => void messageApi.error(String(e)),
  });

  const deleteMut = useMutation({
    mutationFn: deleteNode,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['nodes'] }),
    onError: (e) => void messageApi.error(String(e)),
  });

  const columns: ColumnsType<NodeView> = [
    {
      title: t('nodes.connection'),
      key: 'online',
      width: 90,
      ellipsis: true,
      render: (_: unknown, r: NodeView) => (
        <Badge
          status={r.online ? 'success' : 'default'}
          text={r.online ? t('nodes.online') : t('nodes.offline')}
        />
      ),
    },
    {
      title: t('nodes.name'),
      dataIndex: 'name',
      key: 'name',
      width: 180,
      ellipsis: true,
      render: (v: string, r: NodeView) => (
        <Tooltip title={`${v}${r.machine ? ` (${r.machine})` : ''}`}>
          <Space direction="vertical" size={0}>
            <Text strong>{v}</Text>
            <Text type="secondary" style={{ fontSize: 11 }}>{r.machine || '—'}</Text>
          </Space>
        </Tooltip>
      ),
    },
    {
      title: t('nodes.enabled'),
      key: 'status',
      width: 110,
      ellipsis: true,
      render: (_: unknown, r: NodeView) => (
        <Switch
          checked={r.status === 'active'}
          checkedChildren={t('nodes.active')}
          unCheckedChildren={t('nodes.off')}
          loading={patchMut.isPending}
          onChange={(checked) =>
            patchMut.mutate({ id: r.id, body: { status: checked ? 'active' : 'disabled' } })
          }
        />
      ),
    },
    {
      title: t('common.jobTypes'),
      key: 'kinds',
      width: 220,
      ellipsis: true,
      render: (_: unknown, r: NodeView) => {
        const effective = r.allowed_kinds ?? r.kinds;
        const isRestricted = r.allowed_kinds !== null;
        return (
          <Tooltip title={isRestricted ? `${t('nodes.allowedKinds')}: ${effective.join(', ')}` : undefined}>
            <Space wrap size={4}>
              {effective.map((k) => (
                <Tag key={k} color={isRestricted ? 'orange' : 'blue'} style={{ fontSize: 11 }}>
                  {k}
                </Tag>
              ))}
            </Space>
          </Tooltip>
        );
      },
    },
    {
      title: t('nodes.capabilities'),
      key: 'caps',
      ellipsis: true,
      render: (_: unknown, r: NodeView) => <CapabilitiesSummary node={r} />,
    },
    {
      title: t('nodes.freeSlots'),
      key: 'slots',
      width: 100,
      ellipsis: true,
      render: (_: unknown, r: NodeView) =>
        r.free_slots ? (
          <Text>CPU {r.free_slots.cpu} / GPU {r.free_slots.gpu}</Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: t('nodes.running'),
      key: 'running',
      width: 110,
      ellipsis: true,
      render: (_: unknown, r: NodeView) => (
        <Text>{r.running_job_ids.length > 0 ? r.running_job_ids.length : '—'}</Text>
      ),
    },
    {
      title: t('nodes.lastSeen'),
      key: 'last_seen',
      width: 160,
      ellipsis: true,
      render: (_: unknown, r: NodeView) =>
        r.last_seen_at ? (
          <Tooltip title={r.last_seen_at}>
            <Text>{formatDateTime(r.last_seen_at)}</Text>
          </Tooltip>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: t('nodes.version'),
      dataIndex: 'agent_version',
      key: 'version',
      width: 90,
      ellipsis: true,
      render: (v: string | null) => <Text style={{ fontSize: 11 }}>{v ?? '—'}</Text>,
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 120,
      fixed: 'right' as const,
      render: (_: unknown, r: NodeView) => (
        <Space size={4}>
          <Tooltip title={t('common.edit')}>
            <Button
              size="small"
              onClick={() => {
                setEditNode(r);
                editForm.setFieldsValue({
                  name: r.name,
                  kinds: r.kinds,
                  allowed_kinds: r.allowed_kinds ?? undefined,
                });
              }}
            >
              {t('common.edit')}
            </Button>
          </Tooltip>
          <Popconfirm
            title={t('nodes.deleteConfirm')}
            description={t('nodes.deleteConfirmDesc')}
            onConfirm={() => deleteMut.mutate(r.id)}
            okText={t('common.delete')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
          >
            <Tooltip title={t('common.delete')}>
              <Button size="small" danger>
                {t('common.delete')}
              </Button>
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const pagination: TablePaginationConfig = {
    current: query.page,
    pageSize: query.pageSize,
    total,
    showSizeChanger: true,
    pageSizeOptions: ['10', '20', '50', '100'],
    onChange: (p, ps) => void setQuery({ page: p, pageSize: ps }),
  };

  return (
    <>
      {contextHolder}
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }} gutter={[8, 8]}>
        <Col>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('nodes.title')}
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
            <SortDropdown
              fields={NODE_SORT_FIELDS}
              sortBy={query.sortBy}
              sortOrder={query.sortOrder}
              onChange={(change) => void setQuery({ ...change, page: 1 })}
            />
            <TableRefreshButton
              onRefresh={() => void nodesQuery.refetch()}
              refreshing={nodesQuery.isFetching}
            />
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  { key: 'install', icon: <TerminalSquare size={16} />, label: t('enroll.menuInstall') },
                  { key: 'manual', icon: <KeyRound size={16} />, label: t('enroll.menuManual') },
                ],
                onClick: ({ key }: { key: string }) => {
                  if (key === 'install') {
                    setEnrollOpen(true);
                  } else {
                    form.resetFields();
                    setCreateOpen(true);
                  }
                },
              }}
            >
              <Button type="primary" icon={<Plus size={16} />}>
                {t('nodes.add')} <ChevronDown size={14} />
              </Button>
            </Dropdown>
          </Space>
        </Col>
      </Row>

      <Table
        rowKey="id"
        dataSource={nodes}
        columns={columns}
        loading={nodesQuery.isLoading}
        pagination={pagination}
        sticky={PAGE_TABLE_STICKY}
        scroll={{ x: 1200 }}
      />

      {/* Create modal */}
      <Modal
        title={t('nodes.addTitle')}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={createMut.isPending}
        okText={t('common.create')}
        cancelText={t('common.cancel')}
      >
        <Form form={form} layout="vertical" onFinish={(values) => createMut.mutate(values)}>
          <Form.Item name="name" label={t('nodes.nameLabel')} rules={[{ required: true, message: t('nodes.nameRequired') }]}>
            <Input placeholder={t('nodes.namePlaceholder')} />
          </Form.Item>
          <Form.Item name="machine" label={t('nodes.machineLabel')}>
            <Input placeholder={t('nodes.machinePlaceholder')} />
          </Form.Item>
          <Form.Item
            name="kinds"
            label={t('common.jobTypes')}
            rules={[{ required: true, type: 'array', min: 1, message: t('common.pickAtLeastOneType') }]}
          >
            <Select mode="multiple" options={JOB_TYPES.map((tp) => ({ value: tp, label: tp }))} placeholder={t('common.pickJobTypes')} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Edit modal */}
      <Modal
        title={t('nodes.editTitle')}
        open={editNode !== null}
        onCancel={() => setEditNode(null)}
        onOk={() => editForm.submit()}
        confirmLoading={patchMut.isPending}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
      >
        <Form
          form={editForm}
          layout="vertical"
          onFinish={(values) => {
            if (!editNode) return;
            patchMut.mutate(
              { id: editNode.id, body: values },
              { onSuccess: () => setEditNode(null) },
            );
          }}
        >
          <Form.Item name="name" label={t('nodes.nameLabel')} rules={[{ required: true, message: t('nodes.nameRequired') }]}>
            <Input placeholder={t('nodes.namePlaceholder')} />
          </Form.Item>
          <Form.Item
            name="kinds"
            label={`${t('common.jobTypes')} (reported)`}
            rules={[{ required: true, type: 'array', min: 1, message: t('common.pickAtLeastOneType') }]}
          >
            <Select mode="multiple" options={JOB_TYPES.map((tp) => ({ value: tp, label: tp }))} placeholder={t('common.pickJobTypes')} />
          </Form.Item>
          <Form.Item
            name="allowed_kinds"
            label={t('nodes.allowedKinds')}
            tooltip={t('nodes.allowedKindsHelp')}
          >
            <Select
              mode="multiple"
              allowClear
              options={
                editNode
                  ? editNode.kinds.map((k) => ({ value: k, label: k }))
                  : JOB_TYPES.map((tp) => ({ value: tp, label: tp }))
              }
              placeholder={t('nodes.allowedKindsAll')}
              onChange={(vals: JobType[]) => {
                editForm.setFieldValue('allowed_kinds', vals.length > 0 ? vals : null);
              }}
            />
          </Form.Item>
        </Form>
      </Modal>

      <EnrollModal
        open={enrollOpen}
        onClose={() => {
          setEnrollOpen(false);
          void qc.invalidateQueries({ queryKey: ['nodes'] });
        }}
      />

      {/* Secret modal */}
      {secret && (
        <SecretModal
          open
          title={secret.title}
          label={secret.label}
          secret={secret.value}
          onClose={() => setSecret(null)}
        />
      )}
    </>
  );
}
