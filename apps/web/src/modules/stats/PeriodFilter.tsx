import { Button, DatePicker, Segmented, Space } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DATE_FORMAT, shiftDate, type PeriodMode, type PeriodSelection, type ResolvedPeriod } from './period';

const PICKER_FORMAT = { day: 'DD/MM/YYYY', month: 'MM/YYYY', year: 'YYYY' } as const;
const PICKER_TYPE = { day: 'date', month: 'month', year: 'year' } as const;

interface Props {
  selection: PeriodSelection;
  period: ResolvedPeriod;
  onChange: (patch: Partial<PeriodSelection>) => void;
}

/** Bộ lọc kỳ: theo ngày / tháng / năm (kèm nút lùi, tiến) hoặc khoảng ngày tuỳ chọn. */
export function PeriodFilter({ selection, period, onChange }: Props) {
  const { t } = useTranslation();
  const today = dayjs().startOf('day');
  const disabledDate = (d: Dayjs) => d.isAfter(today, 'day');

  const modeOptions = (['day', 'month', 'year', 'custom'] as const).map((m) => ({
    value: m,
    label: t(`stats.filter.${m}`),
  }));

  const onMode = (mode: PeriodMode) => {
    if (mode === 'custom') {
      // Mở kỳ tuỳ chọn từ đúng kỳ đang xem, để người dùng chỉ việc chỉnh thêm
      onChange({
        mode,
        start: period.from.format(DATE_FORMAT),
        end: period.to.subtract(1, 'day').format(DATE_FORMAT),
      });
    } else {
      onChange({ mode, date: selection.mode === 'custom' ? '' : selection.date });
    }
  };

  return (
    <Space wrap>
      <Segmented options={modeOptions} value={selection.mode} onChange={(v) => onMode(v as PeriodMode)} />
      {selection.mode === 'custom' ? (
        <DatePicker.RangePicker
          allowClear={false}
          format="DD/MM/YYYY"
          disabledDate={disabledDate}
          value={[period.from, period.to.subtract(1, 'day')]}
          presets={[
            { label: t('stats.filter.last7'), value: [today.subtract(6, 'day'), today] },
            { label: t('stats.filter.last30'), value: [today.subtract(29, 'day'), today] },
            { label: t('stats.filter.last90'), value: [today.subtract(89, 'day'), today] },
            { label: t('stats.filter.thisMonth'), value: [today.startOf('month'), today] },
            { label: t('stats.filter.thisYear'), value: [today.startOf('year'), today] },
          ]}
          onChange={(range) => {
            if (range?.[0] && range[1]) {
              onChange({ start: range[0].format(DATE_FORMAT), end: range[1].format(DATE_FORMAT) });
            }
          }}
        />
      ) : (
        <PeriodStepper mode={selection.mode} period={period} onChange={onChange} />
      )}
    </Space>
  );
}

function PeriodStepper({
  mode,
  period,
  onChange,
}: {
  mode: Exclude<PeriodMode, 'custom'>;
  period: ResolvedPeriod;
  onChange: Props['onChange'];
}) {
  const { t } = useTranslation();
  const anchor = period.from.format(DATE_FORMAT);
  const isCurrent = !dayjs().isBefore(period.from) && dayjs().isBefore(period.to);
  const currentLabel = { day: 'today', month: 'thisMonth', year: 'thisYear' }[mode];

  return (
    <Space wrap>
      <Space.Compact>
        <Button
          aria-label={t('stats.filter.prev')}
          title={t('stats.filter.prev')}
          icon={<ChevronLeft size={16} />}
          onClick={() => onChange({ date: shiftDate(anchor, mode, -1) })}
        />
        <DatePicker
          picker={PICKER_TYPE[mode]}
          format={PICKER_FORMAT[mode]}
          allowClear={false}
          disabledDate={(d) => d.isAfter(dayjs(), mode)}
          value={period.from}
          onChange={(d) => d && onChange({ date: d.format(DATE_FORMAT) })}
          style={{ width: mode === 'day' ? 140 : 120 }}
        />
        <Button
          aria-label={t('stats.filter.next')}
          title={t('stats.filter.next')}
          icon={<ChevronRight size={16} />}
          disabled={period.to.isAfter(dayjs())}
          onClick={() => onChange({ date: shiftDate(anchor, mode, 1) })}
        />
      </Space.Compact>
      <Button disabled={isCurrent} onClick={() => onChange({ date: '' })}>
        {t(`stats.filter.${currentLabel}`)}
      </Button>
    </Space>
  );
}
