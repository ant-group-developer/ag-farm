import { CopyOutlined } from '@ant-design/icons';
import { Alert, Button, Modal, Space, Typography } from 'antd';
import { useState } from 'react';

interface SecretModalProps {
  open: boolean;
  title: string;
  label: string;
  secret: string;
  onClose: () => void;
}

/**
 * Modal hiển thị token/key một lần duy nhất với nút sao chép.
 * Khi đóng không thể xem lại.
 */
export function SecretModal({ open, title, label, secret, onClose }: SecretModalProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal
      open={open}
      title={title}
      onCancel={onClose}
      footer={
        <Button type="primary" onClick={onClose} data-testid="secret-modal-close">
          Tôi đã sao chép, đóng
        </Button>
      }
      closable={false}
      maskClosable={false}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Alert
          type="warning"
          showIcon
          message="Luu y: Sau khi dong modal nay, ban khong the xem lai gia tri nay."
        />
        <Typography.Text strong>{label}:</Typography.Text>
        <Space.Compact style={{ width: '100%' }}>
          <Typography.Text
            code
            copyable={false}
            style={{
              flex: 1,
              padding: '4px 8px',
              background: '#f5f5f5',
              borderRadius: '4px 0 0 4px',
              border: '1px solid #d9d9d9',
              wordBreak: 'break-all',
              fontFamily: 'monospace',
              fontSize: 12,
            }}
          >
            {secret}
          </Typography.Text>
          <Button
            icon={<CopyOutlined />}
            onClick={() => void handleCopy()}
            style={{ borderRadius: '0 4px 4px 0' }}
          >
            {copied ? 'Sao chep!' : 'Sao chep'}
          </Button>
        </Space.Compact>
      </Space>
    </Modal>
  );
}
