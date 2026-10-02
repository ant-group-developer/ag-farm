import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Form,
  Input,
  Modal,
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
import { createOwner, listOwners, patchOwner } from '../../api/admin';
import { SecretModal } from '../../shared/components/SecretModal';
import { PageHeader } from '../../shared/components/PageHeader';
import { SortDropdown } from '../../shared/components/SortDropdown';
import { TableRefreshButton } from '../../shared/components/TableRefreshButton';
import { jobTypeLabel, jobTypeOptions } from '../../shared/lib/job-labels';
import { PAGE_TABLE_STICKY } from '../../shared/lib/sticky-table-header';
import { columnsWidth } from '../../shared/lib/table-width';
import type { CreateOwnerRequest, OwnerSortBy, OwnerView, PatchOwnerRequest, SortOrder } from '../../types/api';
import { formatDateTime } from '../../i18n/language';
import { useTranslation } from 'react-i18next';
import { Pencil, Plus } from 'lucide-react';

const { Text } = Typography;

export function OwnersPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();
  const [createOpen, setCreateOpen] = useState(false);
  const [editOwner, setEditOwner] = useState<OwnerView | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [form] = Form.useForm<CreateOwnerRequest>();
  const [editForm] = Form.useForm<PatchOwnerRequest>();

  // URL state via nuqs
  const [query, setQuery] = useQueryStates({
    page: parseAsInteger.withDefault(1),
    pageSize: parseAsInteger.withDefault(20),
    sortBy: parseAsStringEnum<OwnerSortBy>(['name', 'createdAt']).withDefault('createdAt'),
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

  const ownersQuery = useQuery({
    queryKey: ['owners', apiQuery],
    queryFn: () => listOwners(apiQuery),
  });

  const sortFields: readonly { value: OwnerSortBy; label: string }[] = [
    { value: 'createdAt', label: t('common.createdAt') },
    { value: 'name', label: t('common.id') },
  ];

  const owners = ownersQuery.data?.items ?? [];
  const total = ownersQuery.data?.total ?? 0;

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
      title: t('common.id'),
      dataIndex: 'id',
      key: 'id',
      width: 140,
      ellipsis: true,
      render: (v: string) => <Text strong>{v}</Text>,
    },
    {
      title: <Tooltip title={t('owners.signUrlHelp')}>{t('owners.signUrl')}</Tooltip>,
      dataIndex: 'sign_url',
      key: 'sign_url',
      width: 320,
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v}>
          <Text>{v}</Text>
        </Tooltip>
      ),
    },
    {
      title: t('owners.allowedTypes'),
      key: 'allowed_types',
      width: 360,
      render: (_: unknown, r: OwnerView) => (
        <Space wrap size={4}>
          {r.allowed_types.map((tp) => (
            <Tooltip key={tp} title={tp}>
              <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                {jobTypeLabel(tp)}
              </Tag>
            </Tooltip>
          ))}
        </Space>
      ),
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
      width: 100,
      fixed: 'right' as const,
      render: (_: unknown, r: OwnerView) => (
        <Tooltip title={t('common.edit')}>
          <Button
            size="small"
            icon={<Pencil size={14} />}
            aria-label={t('common.edit')}
            onClick={() => {
              setEditOwner(r);
              editForm.setFieldsValue({
                sign_url: r.sign_url,
                allowed_types: r.allowed_types,
              });
            }}
          />
        </Tooltip>
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
      <PageHeader
        title={t('owners.title')}
        description={t('owners.description')}
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
              onRefresh={() => void ownersQuery.refetch()}
              refreshing={ownersQuery.isFetching}
            />
            <Button
              type="primary"
              icon={<Plus size={16} />}
              onClick={() => {
                form.resetFields();
                setCreateOpen(true);
              }}
            >
              {t('owners.add')}
            </Button>
          </Space>
        }
      />

      <Table
        rowKey="id"
        dataSource={owners}
        columns={columns}
        loading={ownersQuery.isLoading}
        pagination={pagination}
        sticky={PAGE_TABLE_STICKY}
        tableLayout="fixed"
        scroll={{ x: columnsWidth(columns) }}
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
              { pattern: /^[a-z][a-z0-9-]*$/, message: t('owners.idPattern') },
            ]}
          >
            <Input placeholder={t('owners.idPlaceholder')} />
          </Form.Item>
          <Form.Item name="sign_url" label={t('owners.signUrl')} tooltip={t('owners.signUrlHelp')} rules={[{ required: true, type: 'url', message: t('owners.signUrlInvalid') }]}>
            <Input placeholder="https://api.example.com/farm/sign" />
          </Form.Item>
          <Form.Item name="allowed_types" label={t('owners.allowedTypes')} rules={[{ required: true, type: 'array', min: 1, message: t('common.pickAtLeastOneType') }]}>
            <Select mode="multiple" options={jobTypeOptions()} placeholder={t('common.pickJobTypes')} />
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
          <Form.Item name="sign_url" label={t('owners.signUrl')} tooltip={t('owners.signUrlHelp')} rules={[{ required: true, type: 'url', message: t('owners.signUrlInvalid') }]}>
            <Input />
          </Form.Item>
          <Form.Item name="allowed_types" label={t('owners.allowedTypes')} rules={[{ required: true, type: 'array', min: 1, message: t('common.pickAtLeastOneType') }]}>
            <Select mode="multiple" options={jobTypeOptions()} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Key shown once */}
      {secret !== null && (
        <SecretModal open title={t('owners.keyTitle')} label={t('owners.keyLabel')} secret={secret} onClose={() => setSecret(null)} />
      )}
    </>
  );
}
