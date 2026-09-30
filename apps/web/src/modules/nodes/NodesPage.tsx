import {
  DeleteOutlined,
  EditOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Col,
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
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { createNode, deleteNode, listNodes, patchNode } from '../../api/admin';
import { SecretModal } from '../../shared/components/SecretModal';
import { PAGE_TABLE_STICKY } from '../../shared/lib/sticky-table-header';
import type { JobType, NodeView } from '../../types/api';
import { JOB_TYPES } from '../../types/api';
import { formatDateTime } from '../../i18n/language';
import { useTranslation } from 'react-i18next';

const { Text } = Typography;

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
  const [editNode, setEditNode] = useState<NodeView | null>(null);
  const [secret, setSecret] = useState<{ title: string; label: string; value: string } | null>(
    null,
  );
  const [form] = Form.useForm<{ name: string; machine?: string; kinds: JobType[] }>();
  const [editForm] = Form.useForm<{ name: string; kinds: JobType[] }>();

  const nodes = useQuery({
    queryKey: ['nodes'],
    queryFn: listNodes,
    refetchInterval: 10_000,
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

  const columns: ColumnsType<NodeView> = [
    {
      title: t('nodes.connection'),
      key: 'online',
      width: 90,
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
      render: (v: string, r: NodeView) => (
        <Space direction="vertical" size={0}>
          <Text strong>{v}</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {r.machine || '—'}
          </Text>
        </Space>
      ),
    },
    {
      title: t('nodes.enabled'),
      key: 'status',
      width: 110,
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
      render: (_: unknown, r: NodeView) => (
        <Space wrap size={4}>
          {r.kinds.map((k) => (
            <Tag key={k} color="blue" style={{ fontSize: 11 }}>
              {k}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: t('nodes.capabilities'),
      key: 'caps',
      render: (_: unknown, r: NodeView) => <CapabilitiesSummary node={r} />,
    },
    {
      title: t('nodes.freeSlots'),
      key: 'slots',
      width: 100,
      render: (_: unknown, r: NodeView) =>
        r.free_slots ? (
          <Text>
            CPU {r.free_slots.cpu} / GPU {r.free_slots.gpu}
          </Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: t('nodes.running'),
      key: 'running',
      width: 110,
      render: (_: unknown, r: NodeView) => (
        <Text>{r.running_job_ids.length > 0 ? r.running_job_ids.length : '—'}</Text>
      ),
    },
    {
      title: t('nodes.lastSeen'),
      key: 'last_seen',
      width: 160,
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
      render: (v: string | null) => <Text style={{ fontSize: 11 }}>{v ?? '—'}</Text>,
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 120,
      render: (_: unknown, r: NodeView) => (
        <Space size={4}>
          <Tooltip title={t('common.edit')}>
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => {
                setEditNode(r);
                editForm.setFieldsValue({ name: r.name, kinds: r.kinds });
              }}
            />
          </Tooltip>
          <Tooltip title={r.status === 'active' ? t('nodes.disable') : t('nodes.enable')}>
            <Button
              size="small"
              icon={r.status === 'active' ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
              onClick={() =>
                patchMut.mutate({
                  id: r.id,
                  body: { status: r.status === 'active' ? 'disabled' : 'active' },
                })
              }
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
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      {contextHolder}
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('nodes.title')}
          </Typography.Title>
        </Col>
        <Col>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              form.resetFields();
              setCreateOpen(true);
            }}
          >
            {t('nodes.add')}
          </Button>
        </Col>
      </Row>

      <Table
        rowKey="id"
        dataSource={nodes.data ?? []}
        columns={columns}
        loading={nodes.isLoading}
        pagination={false}
        size="small"
        sticky={PAGE_TABLE_STICKY}
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
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => createMut.mutate(values)}
        >
          <Form.Item
            name="name"
            label={t('nodes.nameLabel')}
            rules={[{ required: true, message: t('nodes.nameRequired') }]}
          >
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
            <Select
              mode="multiple"
              options={JOB_TYPES.map((t) => ({ value: t, label: t }))}
              placeholder={t('common.pickJobTypes')}
            />
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
          <Form.Item
            name="name"
            label={t('nodes.nameLabel')}
            rules={[{ required: true, message: t('nodes.nameRequired') }]}
          >
            <Input placeholder={t('nodes.namePlaceholder')} />
          </Form.Item>
          <Form.Item
            name="kinds"
            label={t('common.jobTypes')}
            rules={[{ required: true, type: 'array', min: 1, message: t('common.pickAtLeastOneType') }]}
          >
            <Select
              mode="multiple"
              options={JOB_TYPES.map((t) => ({ value: t, label: t }))}
              placeholder={t('common.pickJobTypes')}
            />
          </Form.Item>
        </Form>
      </Modal>

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
