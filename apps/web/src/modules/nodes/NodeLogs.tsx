import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, DatePicker, Flex, Table, Tag, Tooltip, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { Download, FileText } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { downloadNodeLog, listNodeLogs, requestNodeLogs } from '../../api/admin';
import { formatDateTime } from '../../i18n/language';
import type { NodeLogView, NodeView } from '../../types/api';
import { formatLogSize, logRangeBody, logsWaiting } from './node-logs';

const { Text } = Typography;

const STATUS_COLOR: Record<NodeLogView['status'], string> = { requested: 'processing', uploaded: 'success', failed: 'error' };

/**
 * "Lấy log" of one worker: optionally a time range, then the worker sends its logs (worker, setup, updater) at its next
 * check with the hub (within a minute); the last requests are listed with their state and a download.
 */
export function NodeLogs({ node }: { node: NodeView }) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const list = useQuery({
    queryKey: ['node-logs', node.id],
    queryFn: () => listNodeLogs(node.id),
    refetchInterval: (q) => (logsWaiting(q.state.data?.items) ? 5_000 : false),
  });
  const ask = useMutation({
    mutationFn: () => requestNodeLogs(node.id, logRangeBody(range)),
    onSuccess: () => {
      void message.success(t('nodes.logs.sent'));
      void qc.invalidateQueries({ queryKey: ['node-logs', node.id] });
    },
    onError: (e) => void message.error(String(e)),
  });
  const download = useMutation({
    mutationFn: (logId: string) => downloadNodeLog(node.id, logId),
    onError: (e) => void message.error(String(e)),
  });

  return (
    <Flex vertical gap={8} style={{ marginBottom: 16 }}>
      <Flex wrap gap={8} align="center">
        <Text strong>{node.name}</Text>
        <DatePicker.RangePicker
          size="small"
          showTime={{ format: 'HH:mm' }}
          format="DD/MM/YYYY HH:mm"
          allowEmpty={[true, true]}
          placeholder={[t('nodes.logs.since'), t('nodes.logs.until')]}
          value={range}
          onChange={(v) => setRange(v ? [v[0] ?? null, v[1] ?? null] : null)}
          aria-label={t('nodes.logs.range', { name: node.name })}
        />
        <Tooltip title={t('nodes.logs.help')}>
          <Button size="small" icon={<FileText size={14} />} loading={ask.isPending} onClick={() => ask.mutate()}>
            {t('nodes.logs.request')}
          </Button>
        </Tooltip>
      </Flex>
      <Table<NodeLogView>
        size="small"
        rowKey="id"
        pagination={false}
        loading={list.isLoading}
        dataSource={list.data?.items ?? []}
        locale={{ emptyText: t('nodes.logs.none') }}
        columns={[
          {
            title: t('nodes.logs.requestedAt'),
            dataIndex: 'requested_at',
            render: (v: string) => formatDateTime(v),
          },
          {
            title: t('nodes.logs.rangeCol'),
            key: 'range',
            render: (_: unknown, l: NodeLogView) =>
              l.since || l.until
                ? `${l.since ? formatDateTime(l.since) : '…'} → ${l.until ? formatDateTime(l.until) : '…'}`
                : t('nodes.logs.tail'),
          },
          {
            title: t('nodes.logs.status'),
            dataIndex: 'status',
            render: (s: NodeLogView['status'], l: NodeLogView) => (
              <Tooltip title={l.error ?? undefined}>
                <Tag color={STATUS_COLOR[s]}>{t(`nodes.logs.state.${s}`)}</Tag>
              </Tooltip>
            ),
          },
          { title: t('nodes.logs.size'), dataIndex: 'size_bytes', render: (v: number | null) => formatLogSize(v) },
          {
            key: 'download',
            render: (_: unknown, l: NodeLogView) =>
              l.status === 'uploaded' ? (
                <Button
                  size="small"
                  icon={<Download size={14} />}
                  aria-label={t('nodes.logs.download')}
                  loading={download.isPending && download.variables === l.id}
                  onClick={() => download.mutate(l.id)}
                />
              ) : null,
          },
        ]}
      />
    </Flex>
  );
}
