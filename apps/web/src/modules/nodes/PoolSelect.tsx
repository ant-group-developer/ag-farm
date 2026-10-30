import { useQuery } from '@tanstack/react-query';
import { Select } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listPools } from '../../api/admin';

/** Tên pool hợp lệ (như `PoolNameSchema` của protocol). */
export const POOL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * Chọn pool cho worker: các pool đang có (kèm worker trong đó), hoặc tạo pool mới bằng tên đang gõ. Trống = máy chung.
 * Tên gõ được đưa về chữ thường, khoảng trắng thành `-`, để khỏi phải nhớ luật đặt tên.
 */
export function PoolSelect({ id, value, onChange }: { id?: string; value?: string | null; onChange?: (v: string | null) => void }) {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: ['pools'], queryFn: () => listPools(), staleTime: 30_000 });
  const [search, setSearch] = useState('');
  const pools = data?.items ?? [];
  const typed = search.trim().toLowerCase().replace(/\s+/g, '-');
  const isNew = typed && POOL_NAME_RE.test(typed) && !pools.some((p) => p.pool === typed);
  const options = [
    ...pools.map((p) => ({
      value: p.pool,
      label: `${p.pool} · ${t('nodes.poolWorkers', { count: p.nodes.length, names: p.nodes.map((n) => n.name).join(', ') })}`,
    })),
    // pool đang lưu trên worker này mà không còn worker nào trong đó vẫn hiện ra
    ...(value && !pools.some((p) => p.pool === value) ? [{ value, label: value }] : []),
    ...(isNew ? [{ value: typed, label: t('nodes.poolCreate', { name: typed }) }] : []),
  ];
  return (
    <Select
      id={id}
      showSearch
      allowClear
      value={value || undefined}
      placeholder={t('nodes.poolPlaceholder')}
      options={options}
      searchValue={search}
      onSearch={setSearch}
      filterOption={(input, o) => String(o?.value ?? '').includes(input.trim().toLowerCase().replace(/\s+/g, '-'))}
      notFoundContent={search ? t('nodes.poolInvalid') : t('nodes.poolNone')}
      onChange={(v: string | undefined) => { setSearch(''); onChange?.(v ?? null); }}
    />
  );
}
