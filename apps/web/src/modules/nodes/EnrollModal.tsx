import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Form, Input, Modal, Space, Typography } from 'antd';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createEnrollment } from '../../api/admin';
import { API_BASE_URL } from '../../shared/lib/api-client';
import { formatDateTime } from '../../i18n/language';
import type { CreateEnrollmentResponse, WorkerRole } from '../../types/api';

interface EnrollModalProps {
  open: boolean;
  onClose: () => void;
}

interface EnrollForm {
  machine: string;
  roles: WorkerRole[];
}

/** Lệnh PowerShell một dòng cài máy worker (xem ag-farm/tools/worker-installer/install.ps1). */
export function installCommand(hub: string, code: string): string {
  const base = hub.replace(/\/+$/, '');
  return `iwr ${base}/dist/install.ps1 -UseBasicParsing | iex; Install-AgWorker -Hub ${base} -Code ${code}`;
}

/**
 * Tạo mã cài đặt cho một máy rồi hiện lệnh cài: người cài chỉ việc dán vào PowerShell (Run as
 * Administrator) trên máy worker. Mã dùng một lần, hết hạn sau 24 giờ.
 */
export function EnrollModal({ open, onClose }: EnrollModalProps) {
  const { t } = useTranslation();
  const [form] = Form.useForm<EnrollForm>();
  const [created, setCreated] = useState<CreateEnrollmentResponse | null>(null);
  const [hub, setHub] = useState('');
  const [copied, setCopied] = useState(false);

  const createMut = useMutation({
    mutationFn: createEnrollment,
    onSuccess: (data) => {
      setCreated(data);
      setHub(data.public_url ?? API_BASE_URL);
    },
  });

  const close = () => {
    setCreated(null);
    setCopied(false);
    createMut.reset();
    form.resetFields();
    onClose();
  };

  const command = created ? installCommand(hub, created.code) : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // http (không phải https) chặn clipboard: người dùng tự chọn và sao chép trong ô lệnh
    }
  };

  return (
    <Modal
      open={open}
      title={t('enroll.title')}
      onCancel={close}
      maskClosable={!created}
      width={720}
      footer={
        created ? (
          <Button type="primary" onClick={close}>
            {t('secret.close')}
          </Button>
        ) : (
          <Space>
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button type="primary" loading={createMut.isPending} onClick={() => form.submit()}>
              {t('enroll.create')}
            </Button>
          </Space>
        )
      }
    >
      {!created ? (
        <Form
          form={form}
          layout="vertical"
          initialValues={{ roles: ['scan', 'render'] }}
          onFinish={(values) => createMut.mutate(values)}
        >
          <Form.Item
            name="machine"
            label={t('enroll.machine')}
            extra={t('enroll.machineHelp')}
            rules={[
              { required: true, message: t('enroll.machineRequired') },
              { pattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/, message: t('enroll.machinePattern') },
              { max: 60 },
            ]}
          >
            <Input placeholder="lan-4060ti" autoFocus />
          </Form.Item>
          <Form.Item
            name="roles"
            label={t('enroll.roles')}
            rules={[{ required: true, type: 'array', min: 1, message: t('enroll.rolesRequired') }]}
          >
            <Checkbox.Group
              options={[
                { value: 'scan', label: t('enroll.roleScan') },
                { value: 'render', label: t('enroll.roleRender') },
              ]}
            />
          </Form.Item>
          {createMut.isError && <Alert type="error" showIcon message={String(createMut.error)} />}
        </Form>
      ) : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message={t('enroll.howTo')}
            description={t('enroll.expires', { time: formatDateTime(created.expires_at) })}
          />
          <div>
            <Typography.Text strong>{t('enroll.hub')}</Typography.Text>
            <Input value={hub} onChange={(e) => setHub(e.target.value)} />
            <Typography.Text type="secondary">{t('enroll.hubHelp')}</Typography.Text>
          </div>
          <div>
            <Typography.Text strong>{t('enroll.command')}</Typography.Text>
            <Space.Compact style={{ width: '100%' }}>
              <Input.TextArea value={command} readOnly autoSize={{ minRows: 2, maxRows: 4 }} style={{ fontFamily: 'monospace' }} />
              <Button
                aria-label={t('secret.copy')}
                icon={copied ? <Check size={16} /> : <Copy size={16} />}
                onClick={() => void copy()}
              />
            </Space.Compact>
          </div>
          <Typography.Text type="secondary">{t('enroll.updateHint')}</Typography.Text>
        </Space>
      )}
    </Modal>
  );
}
