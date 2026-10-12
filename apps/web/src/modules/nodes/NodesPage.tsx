import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Badge,
  Button,
  Dropdown,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { DragSortTable, type ProColumns } from '@ant-design/pro-components';
import type { TablePaginationConfig } from 'antd/es/table';
import { parseAsInteger, parseAsString, parseAsStringEnum, useQueryStates } from 'nuqs';
import { useState, type ReactNode } from 'react';
import { createNode, deleteNode, listNodes, patchNode, reorderNodes } from '../../api/admin';
import { SecretModal } from '../../shared/components/SecretModal';
import { PageHeader } from '../../shared/components/PageHeader';
import { SortDropdown } from '../../shared/components/SortDropdown';
import { TableRefreshButton } from '../../shared/components/TableRefreshButton';
import { jobTypeOptions } from '../../shared/lib/job-labels';
import { PAGE_TABLE_STICKY } from '../../shared/lib/sticky-table-header';
import { columnsWidth } from '../../shared/lib/table-width';
import { BlockedKindsField, KindSwitches } from './KindSwitches';
import type { JobType, NodeCapabilities, NodeSortBy, NodeView, PagedResponse, SortOrder } from '../../types/api';
import { formatDateTime } from '../../i18n/language';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  Cpu,
  GripVertical,
  Gpu,
  KeyRound,
  MemoryStick,
  Monitor,
  Pencil,
  Plus,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import { EnrollModal } from './EnrollModal';
import { NODE_ORDER_PAGE_SIZE, canDragSort, isOrderView, renumber, slotsAreLive } from './node-order';

const { Text } = Typography;

const OS_LABELS: Record<string, string> = { windows: 'Windows', linux: 'Linux', darwin: 'macOS' };

const SPEC_ICON_STYLE = { flexShrink: 0, color: 'rgba(0, 0, 0, 0.45)' } as const;

/** MB → GB: whole numbers from 10 GB up, one decimal below (8 GB VRAM vs 1.5 GB). */
function formatGb(mb: number): string {
  const gb = mb / 1024;
  return String(gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10);
}

function Spec({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <Flex align="center" gap={6} style={{ minWidth: 0 }}>
      {icon}
      {children}
    </Flex>
  );
}

/** Machine specs on separate lines: OS · CPU · RAM, one line per GPU, then installed engines. */
function NodeSpecs({ caps }: { caps: NodeCapabilities | null }) {
  const { t } = useTranslation();
  if (!caps) return <Text type="secondary">-</Text>;
  const { ffmpeg, python, ytdlp, ollama_models: models } = caps.engines;
  return (
    <Flex vertical gap={4}>
      <Flex wrap gap="4px 16px">
        <Spec icon={<Monitor size={14} style={SPEC_ICON_STYLE} />}>
          <Text>{OS_LABELS[caps.os] ?? caps.os}</Text>
        </Spec>
        <Spec icon={<Cpu size={14} style={SPEC_ICON_STYLE} />}>
          <Text>{t('nodes.cores', { count: caps.cpu_cores })}</Text>
        </Spec>
        <Spec icon={<MemoryStick size={14} style={SPEC_ICON_STYLE} />}>
          <Text>{formatGb(caps.ram_mb)} GB RAM</Text>
        </Spec>
      </Flex>
      {caps.gpus.length > 0 ? (
        caps.gpus.map((gpu, i) => (
          <Spec key={`${gpu.name}-${i}`} icon={<Gpu size={14} style={SPEC_ICON_STYLE} />}>
            <Text ellipsis={{ tooltip: gpu.name }} style={{ minWidth: 0 }}>
              {gpu.name}
            </Text>
            <Text type="secondary" style={{ flexShrink: 0 }}>
              {formatGb(gpu.vram_mb)} GB
            </Text>
            {gpu.nvenc && (
              <Tag color="green" bordered={false} style={{ marginInlineEnd: 0, flexShrink: 0 }}>
                NVENC
              </Tag>
            )}
          </Spec>
        ))
      ) : (
        <Spec icon={<Gpu size={14} style={SPEC_ICON_STYLE} />}>
          <Text type="secondary">{t('nodes.noGpu')}</Text>
        </Spec>
      )}
      {(ffmpeg || python || ytdlp || models.length > 0) && (
        <Flex wrap gap={4}>
          {ffmpeg && (
            <Tooltip title={`ffmpeg ${ffmpeg}`}>
              <Tag bordered={false} style={{ marginInlineEnd: 0 }}>ffmpeg</Tag>
            </Tooltip>
          )}
          {python && (
            <Tag bordered={false} style={{ marginInlineEnd: 0 }}>Python {python}</Tag>
          )}
          {ytdlp && (
            <Tooltip title={`yt-dlp ${ytdlp}`}>
              <Tag bordered={false} style={{ marginInlineEnd: 0 }}>yt-dlp</Tag>
            </Tooltip>
          )}
          {models.length > 0 && (
            <Tooltip title={models.join(', ')}>
              <Tag bordered={false} color="purple" style={{ marginInlineEnd: 0 }}>
                {t('nodes.ollamaModels', { count: models.length })}
              </Tag>
            </Tooltip>
          )}
        </Flex>
      )}
    </Flex>
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
  const [editForm] = Form.useForm<{ name: string; blocked_kinds: JobType[] }>();

  // URL state via nuqs
  const [query, setQuery] = useQueryStates({
    page: parseAsInteger.withDefault(1),
    pageSize: parseAsInteger.withDefault(20),
    sortBy: parseAsStringEnum<NodeSortBy>(['priorityOrder', 'name', 'lastSeenAt', 'createdAt']).withDefault(
      'priorityOrder',
    ),
    sortOrder: parseAsStringEnum<SortOrder>(['asc', 'desc']).withDefault('asc'),
    q: parseAsString.withDefault(''),
  });

  // Xem theo thứ tự nhận việc: tải cả danh sách một trang để kéo thả cả farm.
  const orderView = isOrderView(query);
  const apiQuery = {
    page: orderView ? 1 : query.page,
    pageSize: orderView ? NODE_ORDER_PAGE_SIZE : query.pageSize,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    q: query.q || undefined,
  };
  const queryKey = ['nodes', apiQuery];

  const nodesQuery = useQuery({
    queryKey,
    queryFn: () => listNodes(apiQuery),
    refetchInterval: 10_000,
  });

  const sortFields: readonly { value: NodeSortBy; label: string }[] = [
    { value: 'priorityOrder', label: t('nodes.order') },
    { value: 'createdAt', label: t('common.createdAt') },
    { value: 'name', label: t('nodes.name') },
    { value: 'lastSeenAt', label: t('nodes.lastSeen') },
  ];

  const nodes = nodesQuery.data?.items ?? [];
  const total = nodesQuery.data?.total ?? 0;
  const draggable = canDragSort(orderView, nodes.length, total);

  const reorderMut = useMutation({
    mutationFn: (ordered: NodeView[]) => reorderNodes(ordered.map((n) => n.id)),
    onMutate: async (ordered) => {
      // Hiện thứ tự mới ngay, không đợi hub (và không để lần tải định kỳ kéo về thứ tự cũ giữa chừng).
      await qc.cancelQueries({ queryKey: ['nodes'] });
      qc.setQueryData<PagedResponse<NodeView>>(queryKey, (old) => (old ? { ...old, items: renumber(ordered) } : old));
    },
    onSuccess: () => void messageApi.success(t('nodes.orderSaved')),
    onError: (e) => void messageApi.error(String(e)),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['nodes'] }),
  });

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

  const columns: ProColumns<NodeView>[] = [
    {
      // Cột chứa tay nắm kéo thả (dragSortKey) khi đang xem theo thứ tự.
      title: t('nodes.order'),
      tooltip: t('nodes.orderHelp'),
      key: 'priority_order',
      dataIndex: 'priority_order',
      width: 90,
      render: (_: unknown, r: NodeView) =>
        draggable ? (
          <Text strong>{r.priority_order}</Text>
        ) : (
          <Tooltip title={orderView ? undefined : t('nodes.orderDragOff')}>
            <Text type={orderView ? undefined : 'secondary'}>{r.priority_order}</Text>
          </Tooltip>
        ),
    },
    {
      title: t('nodes.connection'),
      key: 'online',
      width: 120,
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
      width: 200,
      render: (_: unknown, r: NodeView) => (
        <Flex vertical style={{ minWidth: 0 }}>
          <Text strong ellipsis={{ tooltip: r.name }}>{r.name}</Text>
          <Text type="secondary" ellipsis={{ tooltip: r.machine || undefined }}>
            {r.machine || '-'}
          </Text>
        </Flex>
      ),
    },
    {
      title: t('nodes.enabled'),
      key: 'status',
      width: 120,
      render: (_: unknown, r: NodeView) => (
        <Switch
          checked={r.status === 'active'}
          checkedChildren={t('nodes.active')}
          unCheckedChildren={t('nodes.off')}
          loading={patchMut.isPending && patchMut.variables?.id === r.id}
          onChange={(checked) =>
            patchMut.mutate({ id: r.id, body: { status: checked ? 'active' : 'disabled' } })
          }
        />
      ),
    },
    {
      // Worker tự báo loại làm được (ghi đè mỗi heartbeat); admin chỉ tắt/bật từng loại (`blocked_kinds`).
      title: t('nodes.kinds'),
      tooltip: t('nodes.kindsHelp'),
      key: 'kinds',
      width: 230,
      render: (_: unknown, r: NodeView) => (
        <KindSwitches
          reported={r.kinds}
          blocked={r.blocked_kinds ?? []}
          loading={patchMut.isPending && patchMut.variables?.id === r.id && patchMut.variables.body.blocked_kinds !== undefined}
          onChange={(blocked) => patchMut.mutate({ id: r.id, body: { blocked_kinds: blocked } })}
        />
      ),
    },
    {
      title: t('nodes.capabilities'),
      key: 'caps',
      width: 340,
      render: (_: unknown, r: NodeView) => <NodeSpecs caps={r.capabilities} />,
    },
    {
      title: t('nodes.freeSlots'),
      key: 'slots',
      width: 120,
      render: (_: unknown, r: NodeView) => {
        if (!r.free_slots) return <Text type="secondary">-</Text>;
        // Máy offline hay tắt: số này là của lần kết nối cuối, không phải chỗ nó đang nhận việc.
        const live = slotsAreLive(r);
        const slot = (label: string, free: number) => (
          <Tag
            bordered={false}
            color={live ? (free > 0 ? 'green' : 'default') : undefined}
            style={{ marginInlineEnd: 0, opacity: live ? 1 : 0.55 }}
          >
            {label} {free}
          </Tag>
        );
        return (
          <Tooltip title={live ? undefined : t('nodes.slotsStale')}>
            <Flex wrap gap={4}>
              {slot('CPU', r.free_slots.cpu)}
              {slot('GPU', r.free_slots.gpu)}
            </Flex>
          </Tooltip>
        );
      },
    },
    {
      title: t('nodes.running'),
      key: 'running',
      width: 150,
      align: 'center',
      render: (_: unknown, r: NodeView) =>
        r.running_job_ids.length > 0 ? (
          <Tooltip title={t('nodes.runningIds', { ids: r.running_job_ids.join(', ') })}>
            <Badge
              count={r.running_job_ids.length}
              color="blue"
              overflowCount={999}
              showZero={false}
            />
          </Tooltip>
        ) : (
          <Text type="secondary">0</Text>
        ),
    },
    {
      title: t('nodes.lastSeen'),
      key: 'last_seen',
      width: 200,
      ellipsis: true,
      render: (_: unknown, r: NodeView) =>
        r.last_seen_at ? (
          <Tooltip title={r.last_seen_at}>
            <Text>{formatDateTime(r.last_seen_at)}</Text>
          </Tooltip>
        ) : (
          <Text type="secondary">-</Text>
        ),
    },
    {
      title: t('nodes.version'),
      dataIndex: 'agent_version',
      key: 'version',
      width: 120,
      ellipsis: true,
      render: (_: unknown, r: NodeView) =>
        r.agent_version ? <Text>{r.agent_version}</Text> : <Text type="secondary">-</Text>,
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 100,
      fixed: 'right' as const,
      render: (_: unknown, r: NodeView) => (
        <Space size={4}>
          <Tooltip title={t('common.edit')}>
            <Button
              size="small"
              icon={<Pencil size={14} />}
              aria-label={t('common.edit')}
              onClick={() => {
                setEditNode(r);
                editForm.setFieldsValue({
                  name: r.name,
                  blocked_kinds: r.blocked_kinds ?? [],
                });
              }}
            />
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
              <Button size="small" danger icon={<Trash2 size={14} />} aria-label={t('common.delete')} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  // Xem theo thứ tự: cả danh sách trong một trang, không phân trang (trừ farm quá 200 máy).
  const pagination: TablePaginationConfig | false =
    orderView && total <= nodes.length
      ? false
      : {
          current: apiQuery.page,
          pageSize: apiQuery.pageSize,
          total,
          showSizeChanger: !orderView,
          pageSizeOptions: ['10', '20', '50', '100'],
          onChange: (p, ps) => void setQuery({ page: p, pageSize: ps }),
        };

  return (
    <>
      {contextHolder}
      <PageHeader
        title={t('nodes.title')}
        description={t('nodes.description')}
        extra={
          <Space wrap>
            <Input.Search
              placeholder={t('common.search')}
              allowClear
              value={query.q ?? ''}
              onChange={(e) => void setQuery({ q: e.target.value || '', page: 1 })}
              style={{ width: 200 }}
            />
            <SortDropdown
              fields={sortFields}
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
        }
      />

      <DragSortTable<NodeView>
        rowKey="id"
        dataSource={nodes}
        columns={columns}
        loading={nodesQuery.isLoading || reorderMut.isPending}
        pagination={pagination}
        sticky={PAGE_TABLE_STICKY}
        tableLayout="fixed"
        scroll={{ x: columnsWidth(columns) }}
        search={false}
        options={false}
        toolBarRender={false}
        ghost
        dragSortKey={draggable ? 'priority_order' : undefined}
        dragSortHandlerRender={() => (
          <Tooltip title={t('nodes.orderDragHint')}>
            <GripVertical size={16} style={{ cursor: 'grab', color: 'rgba(0, 0, 0, 0.45)' }} />
          </Tooltip>
        )}
        onDragSortEnd={(_from, _to, ordered) => reorderMut.mutate(ordered)}
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
            <Select mode="multiple" options={jobTypeOptions()} placeholder={t('common.pickJobTypes')} />
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
          {/* Worker ghi đè `kinds` ở mỗi heartbeat; admin chỉ tắt/bật từng loại (`blocked_kinds`). */}
          <Form.Item name="blocked_kinds" label={t('nodes.kinds')} tooltip={t('nodes.kindsHelp')}>
            <BlockedKindsField reported={editNode?.kinds ?? []} />
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
