import { useQuery } from '@tanstack/react-query';
import { Select } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listPools } from '../../api/admin';

/** Tên pool hợp lệ (như `PoolNameSchema` của protocol). */
export const POOL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Tên gõ đưa về dạng pool: chữ thường, khoảng trắng thành `-`, để khỏi phải nhớ luật đặt tên. */
const asPoolName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-');

/**
 * Chọn các pool cho worker (một worker thuộc được nhiều pool: nhiều nhóm dùng chung nó): các pool đang có, kèm worker
 * trong đó, hoặc tạo pool mới bằng tên đang gõ. Không chọn pool nào = máy chung.
 */
export function PoolSelect({ id, value, onChange }: { id?: string; value?: string[]; onChange?: (v: string[]) => void }) {
  const { t } = useTranslation();
  const { data } = useQuery({ queryKey: ['pools'], queryFn: () => listPools(), staleTime: 30_000 });
  const [search, setSearch] = useState('');
  const pools = data?.items ?? [];
  const chosen = value ?? [];
  const typed = asPoolName(search);
  const isNew = typed && POOL_NAME_RE.test(typed) && !pools.some((p) => p.pool === typed) && !chosen.includes(typed);
  const options = [
    ...pools.map((p) => ({
      value: p.pool,
      label: `${p.pool} · ${t('nodes.poolWorkers', { count: p.nodes.length, names: p.nodes.map((n) => n.name).join(', ') })}`,
    })),
    // pool đang chọn mà không còn worker nào trong đó vẫn hiện ra
    ...chosen.filter((c) => !pools.some((p) => p.pool === c)).map((c) => ({ value: c, label: c })),
    ...(isNew ? [{ value: typed, label: t('nodes.poolCreate', { name: typed }) }] : []),
  ];
  return (
    <Select
      id={id}
      mode="multiple"
      allowClear
      value={chosen}
      placeholder={t('nodes.poolPlaceholder')}
      options={options}
      searchValue={search}
      onSearch={setSearch}
      // chip chỉ hiện tên pool, không hiện cả nhãn dài
      labelRender={(o) => String(o.value)}
      filterOption={(input, o) => String(o?.value ?? '').includes(asPoolName(input))}
      notFoundContent={search ? t('nodes.poolInvalid') : t('nodes.poolNone')}
      onChange={(v: string[]) => { setSearch(''); onChange?.(v); }}
    />
  );
}
