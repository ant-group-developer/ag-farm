import { EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Col,
  Form,
  Input,
  Modal,
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
import { createOwner, listOwners, patchOwner } from '../../api/admin';
import { SecretModal } from '../../shared/components/SecretModal';
import { PAGE_TABLE_STICKY } from '../../shared/lib/sticky-table-header';
import type { JobType, Lane, OwnerView, PatchOwnerRequest } from '../../types/api';
import { JOB_TYPES } from '../../types/api';
import { formatDateTime } from '../../i18n/language';
import { useTranslation } from 'react-i18next';

const { Text } = Typography;

const LANE_OPTIONS: { value: Lane; label: string }[] = [
  { value: 'interactive', label: 'interactive' },
  { value: 'batch', label: 'batch' },
];

export function OwnersPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();
  const [createOpen, setCreateOpen] = useState(false);
  const [editOwner, setEditOwner] = useState<OwnerView | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [form] = Form.useForm<{
    id: string;
    sign_url: string;
    allowed_types: JobType[];
    default_lane: Lane;
  }>();
  const [editForm] = Form.useForm<PatchOwnerRequest>();

  const owners = useQuery({
    queryKey: ['owners'],
    queryFn: listOwners,
  });

  const createMut = useMutation({
    mutationFn: createOwner,
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['owners'] });
      setCreateOpen(false);
      form.resetFields();
      setSecret(data.key);
    },
    onError: (e) => void messageApi.error(String(e)),
  });

  const patchMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchOwnerRequest }) => patchOwner(id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['owners'] });
      setEditOwner(null);
    },
    onError: (e) => void messageApi.error(String(e)),
  });

  const columns: ColumnsType<OwnerView> = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      render: (v: string) => <Text strong>{v}</Text>,
    },
    {
      title: 'Sign URL',
      dataIndex: 'sign_url',
      key: 'sign_url',
      render: (v: string) => (
        <Tooltip title={v}>
          <Text ellipsis style={{ maxWidth: 280, fontSize: 12 }}>
            {v}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: t('owners.allowedTypes'),
      key: 'allowed_types',
      render: (_: unknown, r: OwnerView) => (
        <Space wrap size={4}>
          {r.allowed_types.map((t) => (
            <Tag key={t} color="blue" style={{ fontSize: 11 }}>
              {t}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: t('owners.defaultLane'),
      dataIndex: 'default_lane',
      key: 'default_lane',
      render: (v: string) => (
        <Tag color={v === 'interactive' ? 'purple' : 'default'}>{v}</Tag>
      ),
    },
    {
      title: t('common.createdAt'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 140,
      render: (v: string) => (
        <Text style={{ fontSize: 11 }}>{formatDateTime(v)}</Text>
      ),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 80,
      render: (_: unknown, r: OwnerView) => (
        <Tooltip title={t('common.edit')}>
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setEditOwner(r);
              editForm.setFieldsValue({
                sign_url: r.sign_url,
                allowed_types: r.allowed_types,
                default_lane: r.default_lane,
              });
            }}
          />
        </Tooltip>
      ),
    },
  ];

  return (
    <>
      {contextHolder}
      <Row justify="space-between" align="middle" style={{ marginBottom: 16 }}>
        <Col>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('owners.title')}
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
            {t('owners.add')}
          </Button>
        </Col>
      </Row>

      <Table
        rowKey="id"
        dataSource={owners.data ?? []}
        columns={columns}
        loading={owners.isLoading}
        pagination={false}
        size="small"
        sticky={PAGE_TABLE_STICKY}
      />

      {/* Create modal */}
      <Modal
        title={t('owners.addTitle')}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={createMut.isPending}
        okText={t('common.create')}
        cancelText={t('common.cancel')}
      >
        <Form form={form} layout="vertical" onFinish={(values) => createMut.mutate(values)}>
          <Form.Item
            name="id"
            label={t('owners.idLabel')}
            rules={[
              { required: true, message: t('owners.idRequired') },
              {
                pattern: /^[a-z][a-z0-9-]*$/,
                message: t('owners.idPattern'),
              },
            ]}
          >
            <Input placeholder={t('owners.idPlaceholder')} />
          </Form.Item>
          <Form.Item
            name="sign_url"
            label="Sign URL"
            rules={[{ required: true, type: 'url', message: t('owners.signUrlInvalid') }]}
          >
            <Input placeholder="https://api.example.com/farm/sign" />
          </Form.Item>
          <Form.Item
            name="allowed_types"
            label={t('owners.allowedTypes')}
            rules={[{ required: true, type: 'array', min: 1, message: t('common.pickAtLeastOneType') }]}
          >
            <Select
              mode="multiple"
              options={JOB_TYPES.map((t) => ({ value: t, label: t }))}
              placeholder={t('common.pickJobTypes')}
            />
          </Form.Item>
          <Form.Item name="default_lane" label={t('owners.defaultLane')} initialValue="batch">
            <Select options={LANE_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Edit modal */}
      <Modal
        title={t('owners.editTitle', { id: editOwner?.id ?? '' })}
        open={editOwner !== null}
        onCancel={() => setEditOwner(null)}
        onOk={() => editForm.submit()}
        confirmLoading={patchMut.isPending}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
      >
        <Form
          form={editForm}
          layout="vertical"
          onFinish={(values) => {
            if (!editOwner) return;
            patchMut.mutate({ id: editOwner.id, body: values });
          }}
        >
          <Form.Item
            name="sign_url"
            label="Sign URL"
            rules={[{ required: true, type: 'url', message: t('owners.signUrlInvalid') }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="allowed_types"
            label={t('owners.allowedTypes')}
            rules={[{ required: true, type: 'array', min: 1, message: t('common.pickAtLeastOneType') }]}
          >
            <Select
              mode="multiple"
              options={JOB_TYPES.map((t) => ({ value: t, label: t }))}
            />
          </Form.Item>
          <Form.Item name="default_lane" label={t('owners.defaultLane')}>
            <Select options={LANE_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Key shown once */}
      {secret !== null && (
        <SecretModal
          open
          title={t('owners.keyTitle')}
          label={t('owners.keyLabel')}
          secret={secret}
          onClose={() => setSecret(null)}
        />
      )}
    </>
  );
}
