import { Col, Row, Typography } from 'antd';
import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  /** One line under the title saying what the page lists. */
  description?: string;
  /** Toolbar on the right: search, filters, buttons. */
  extra?: ReactNode;
}

/** Page title, description and toolbar shared by every admin page. */
export function PageHeader({ title, description, extra }: PageHeaderProps) {
  return (
    <Row justify="space-between" align="middle" style={{ marginBottom: 16 }} gutter={[16, 8]}>
      <Col>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {description && <Typography.Text type="secondary">{description}</Typography.Text>}
      </Col>
      {extra && <Col>{extra}</Col>}
    </Row>
  );
}
