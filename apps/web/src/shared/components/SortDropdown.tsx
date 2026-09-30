import type { ButtonProps } from 'antd';
import { Button, Dropdown } from 'antd';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Check } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SortDirection } from '../lib/compare-sort-values';

export type SortState<F extends string> = { sortBy: F; sortOrder: SortDirection };

type SortDropdownProps<F extends string> = {
  /** Sortable fields in menu order. */
  fields: readonly { value: F; label: string }[];
  sortBy: F;
  sortOrder: SortDirection;
  /** Called with only the part that changed (field or direction). */
  onChange: (change: Partial<SortState<F>>) => void;
  size?: ButtonProps['size'];
};

const SORT_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

/**
 * Sort button showing the active field and direction; its menu lists the fields, then
 * ascending / descending. The menu stays open while picking so field and direction can both
 * be changed in one go.
 */
export function SortDropdown<F extends string>({
  fields,
  sortBy,
  sortOrder,
  onChange,
  size,
}: SortDropdownProps<F>) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const iconSize = size === 'small' ? 14 : 16;
  const activeLabel = fields.find((field) => field.value === sortBy)?.label ?? sortBy;

  return (
    <Dropdown
      trigger={['click']}
      open={open}
      onOpenChange={(nextOpen, info) => {
        if (info.source === 'trigger') {
          setOpen(nextOpen);
        }
      }}
      menu={{
        items: [
          {
            type: 'group',
            label: t('common.sort'),
            children: fields.map((field) => ({
              key: `sortBy:${field.value}`,
              label: field.label,
              extra: sortBy === field.value ? <Check size={14} /> : null,
              onClick: () => onChange({ sortBy: field.value }),
            })),
          },
          { type: 'divider' },
          ...SORT_DIRECTIONS.map((direction) => ({
            key: `sortOrder:${direction}`,
            icon:
              direction === 'asc' ? (
                <ArrowUpNarrowWide size={14} />
              ) : (
                <ArrowDownWideNarrow size={14} />
              ),
            label: t(direction === 'asc' ? 'common.sortAsc' : 'common.sortDesc'),
            extra: sortOrder === direction ? <Check size={14} /> : null,
            onClick: () => onChange({ sortOrder: direction }),
          })),
        ],
      }}
    >
      <Button
        size={size}
        icon={
          sortOrder === 'asc' ? (
            <ArrowUpNarrowWide size={iconSize} />
          ) : (
            <ArrowDownWideNarrow size={iconSize} />
          )
        }
      >
        {activeLabel}
      </Button>
    </Dropdown>
  );
}
