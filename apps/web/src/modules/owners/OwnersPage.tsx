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
import type { JobType, Lane, OwnerView, PatchOwnerRequest } from '../../types/api';
import { JOB_TYPES } from '../../types/api';

const { Text } = Typography;

const LANE_OPTIONS: { value: Lane; label: string }[] = [
  { value: 'interactive', label: 'interactive' },
  { value: 'batch', label: 'batch' },
];

export function OwnersPage() {
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
      title: 'Loai viec duoc phep',
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
      title: 'Lane mac dinh',
      dataIndex: 'default_lane',
      key: 'default_lane',
      render: (v: string) => (
        <Tag color={v === 'interactive' ? 'purple' : 'default'}>{v}</Tag>
      ),
    },
    {
      title: 'Tao luc',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 140,
      render: (v: string) => (
        <Text style={{ fontSize: 11 }}>{new Date(v).toLocaleString('vi-VN')}</Text>
      ),
    },
    {
      title: 'Thao tac',
      key: 'actions',
      width: 80,
      render: (_: unknown, r: OwnerView) => (
        <Tooltip title="Sua">
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
            Chu job
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
            Them chu job
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
      />

      {/* Create modal */}
      <Modal
        title="Them chu job moi"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={createMut.isPending}
        okText="Tao"
        cancelText="Huy"
      >
        <Form form={form} layout="vertical" onFinish={(values) => createMut.mutate(values)}>
          <Form.Item
            name="id"
            label="ID chu job (vd: ag-go, studio)"
            rules={[
              { required: true, message: 'Nhap ID' },
              {
                pattern: /^[a-z][a-z0-9-]*$/,
                message: 'Chi ky tu thuong, chu so va gach ngang',
              },
            ]}
          >
            <Input placeholder="vd: ag-go" />
          </Form.Item>
          <Form.Item
            name="sign_url"
            label="Sign URL"
            rules={[{ required: true, type: 'url', message: 'Nhap URL hop le' }]}
          >
            <Input placeholder="https://api.example.com/farm/sign" />
          </Form.Item>
          <Form.Item
            name="allowed_types"
            label="Loai viec duoc phep"
            rules={[{ required: true, type: 'array', min: 1, message: 'Chon it nhat 1 loai' }]}
          >
            <Select
              mode="multiple"
              options={JOB_TYPES.map((t) => ({ value: t, label: t }))}
              placeholder="Chon loai viec"
            />
          </Form.Item>
          <Form.Item name="default_lane" label="Lane mac dinh" initialValue="batch">
            <Select options={LANE_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Edit modal */}
      <Modal
        title={`Sua chu job: ${editOwner?.id ?? ''}`}
        open={editOwner !== null}
        onCancel={() => setEditOwner(null)}
        onOk={() => editForm.submit()}
        confirmLoading={patchMut.isPending}
        okText="Luu"
        cancelText="Huy"
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
            rules={[{ required: true, type: 'url', message: 'Nhap URL hop le' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item
            name="allowed_types"
            label="Loai viec duoc phep"
            rules={[{ required: true, type: 'array', min: 1, message: 'Chon it nhat 1 loai' }]}
          >
            <Select
              mode="multiple"
              options={JOB_TYPES.map((t) => ({ value: t, label: t }))}
            />
          </Form.Item>
          <Form.Item name="default_lane" label="Lane mac dinh">
            <Select options={LANE_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Key shown once */}
      {secret !== null && (
        <SecretModal
          open
          title="Khoa chu job"
          label="Key (luu ngay bay gio)"
          secret={secret}
          onClose={() => setSecret(null)}
        />
      )}
    </>
  );
}
