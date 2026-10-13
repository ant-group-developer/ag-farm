import { Flex, Switch, Tooltip, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { jobTypeLabel } from '../../shared/lib/job-labels';
import type { JobType } from '../../types/api';
import { kindRows, withKind } from './node-kinds';

const { Text } = Typography;

/** `KindSwitches` làm ô form (`Form.Item` truyền `value` = `blocked_kinds`, `onChange`). */
export function BlockedKindsField({
  reported,
  value,
  onChange,
}: {
  reported: readonly JobType[];
  value?: JobType[];
  onChange?: (blocked: JobType[]) => void;
}) {
  return <KindSwitches reported={reported} blocked={value ?? []} onChange={(blocked) => onChange?.(blocked)} />;
}

/**
 * Mỗi loại job worker báo một công tắc: bật = máy nhận loại đó, tắt = admin chặn (`blocked_kinds`). Loại mới worker báo
 * lên tự bật. Loại đã chặn mà worker không còn báo vẫn hiện (mờ) để bật lại.
 */
export function KindSwitches({
  reported,
  blocked,
  loading,
  disabled,
  onChange,
}: {
  reported: readonly JobType[];
  blocked: readonly JobType[];
  loading?: boolean;
  disabled?: boolean;
  onChange: (blocked: JobType[]) => void;
}) {
  const { t } = useTranslation();
  const rows = kindRows(reported, blocked);
  if (rows.length === 0) return <Text type="secondary">-</Text>;
  return (
    <Flex vertical gap={4}>
      {rows.map((row) => {
        const label = jobTypeLabel(row.kind);
        return (
          <Tooltip
            key={row.kind}
            title={row.reported ? undefined : t('nodes.kindNotReported')}
            placement="left"
          >
            <Flex gap={6} align="center" style={{ minWidth: 0, opacity: row.reported ? 1 : 0.6 }}>
              <Switch
                size="small"
                checked={!row.blocked}
                loading={loading}
                disabled={disabled}
                aria-label={label}
                onChange={(on) => onChange(withKind(blocked, row.kind, on))}
              />
              <Text delete={row.blocked} type={row.blocked ? 'secondary' : undefined} ellipsis={{ tooltip: label }}>
                {label}
              </Text>
            </Flex>
          </Tooltip>
        );
      })}
    </Flex>
  );
}
