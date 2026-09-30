import type { ButtonProps } from 'antd';
import { Button, Tooltip } from 'antd';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type TableRefreshButtonProps = {
  /** Refetches the table data. */
  onRefresh: () => void;
  /** Shows a spinning animation while a refetch is in flight. */
  refreshing?: boolean;
  size?: ButtonProps['size'];
};

/** Icon-only "reload" button placed in a table toolbar. */
export function TableRefreshButton({ onRefresh, refreshing, size }: TableRefreshButtonProps) {
  const { t } = useTranslation();
  const iconSize = size === 'small' ? 14 : 16;
  return (
    <Tooltip title={t('common.refresh')}>
      <Button
        aria-label={t('common.refresh')}
        icon={
          <RefreshCw
            size={iconSize}
            style={refreshing ? { animation: 'spin 1s linear infinite' } : undefined}
          />
        }
        size={size}
        onClick={onRefresh}
      />
    </Tooltip>
  );
}
