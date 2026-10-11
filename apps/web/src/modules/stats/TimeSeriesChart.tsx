import { theme } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { StatsBucket, StatsPeriodPoint } from '../../types/api';
import { bucketLabel, niceTicks } from './period';

/**
 * Màu theo vai trò, đã chạy validator (CVD all-pairs ΔE ≥ 13): hoàn tất xanh dương, thất bại đỏ, tạo mới tím;
 * job huỷ là xám trung tính vì "không có kết quả". Chữ luôn dùng màu chữ của theme, không dùng màu series.
 */
export const SERIES_COLORS = {
  completed: '#2a78d6',
  failed: '#d03b3b',
  cancelled: '#898781',
  created: '#4a3aa7',
} as const;

/** Thứ tự xếp chồng từ đáy lên. */
const STACK = ['completed', 'failed', 'cancelled'] as const;

const PLOT_HEIGHT = 240;
const MARGIN = { top: 12, right: 12, bottom: 28, left: 44 };
const GAP = 2;
const MAX_BAR = 24;
const RADIUS = 4;

interface Props {
  points: StatsPeriodPoint[];
  bucket: StatsBucket;
  /** Đang tải lại: giữ hình cũ, làm mờ đi thay vì nháy khung trống. */
  stale?: boolean;
  /** Ô bắt đầu sau thời điểm này là tương lai: trục vẫn đủ kỳ, nhưng không vẽ và không trỏ được. */
  now?: Dayjs;
}

/** Hình chữ nhật bo 4px ở đầu dữ liệu, vuông ở chân. */
function topRoundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function TimeSeriesChart({ points, bucket, stale, now }: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const n = points.length;
  const futureAt = now ? points.findIndex((p) => dayjs(p.t).isAfter(now)) : -1;
  /** Số ô đã diễn ra (vẽ được) */
  const past = futureAt === -1 ? n : futureAt;
  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const band = n > 0 ? innerW / n : 0;
  const barW = Math.max(2, Math.min(MAX_BAR, band * 0.64));

  const ticks = useMemo(() => {
    const max = points.reduce(
      (m, p) => Math.max(m, p.completed + p.failed + p.cancelled, p.created),
      0,
    );
    return niceTicks(max);
  }, [points]);
  const yMax = ticks[ticks.length - 1]!;
  const y = (v: number) => MARGIN.top + PLOT_HEIGHT - (v / yMax) * PLOT_HEIGHT;
  const cx = (i: number) => MARGIN.left + band * i + band / 2;

  // Nhãn trục x cách nhau tối thiểu ~56px
  const labelEvery = Math.max(1, Math.ceil(56 / Math.max(band, 1)));

  const seriesName = (key: keyof typeof SERIES_COLORS) => t(`stats.series.${key}`);
  const linePath = points.slice(0, past).map((p, i) => `${i === 0 ? 'M' : 'L'}${cx(i)},${y(p.created)}`).join('');

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (past === 0) return;
    if (e.key === 'ArrowRight') setHover((h) => (h == null ? 0 : Math.min(past - 1, h + 1)));
    else if (e.key === 'ArrowLeft') setHover((h) => (h == null ? past - 1 : Math.max(0, h - 1)));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };

  const hovered = hover != null ? points[hover] : undefined;
  const tooltipLeft = hover != null ? cx(hover) : 0;
  const tooltipOnLeft = tooltipLeft > width * 0.6;

  return (
    <div>
      <Legend />
      <div
        ref={wrapRef}
        tabIndex={0}
        role="img"
        aria-label={t('stats.chartAria')}
        onKeyDown={onKeyDown}
        onBlur={() => setHover(null)}
        style={{
          position: 'relative',
          opacity: stale ? 0.5 : 1,
          transition: 'opacity 150ms',
          outline: 'none',
        }}
      >
        {width > 0 && (
          <svg
            width={width}
            height={MARGIN.top + PLOT_HEIGHT + MARGIN.bottom}
            style={{ display: 'block' }}
            onMouseLeave={() => setHover(null)}
          >
            {/* Lưới và trục y */}
            {ticks.map((v) => (
              <g key={v}>
                <line
                  x1={MARGIN.left}
                  x2={width - MARGIN.right}
                  y1={y(v)}
                  y2={y(v)}
                  stroke={v === 0 ? token.colorBorder : token.colorBorderSecondary}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text
                  x={MARGIN.left - 8}
                  y={y(v)}
                  dy="0.32em"
                  textAnchor="end"
                  fontSize={11}
                  fill={token.colorTextTertiary}
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {v.toLocaleString()}
                </text>
              </g>
            ))}

            {/* Ô đang trỏ: nền nhạt */}
            {hover != null && (
              <rect
                x={MARGIN.left + band * hover}
                y={MARGIN.top}
                width={band}
                height={PLOT_HEIGHT}
                fill={token.colorFillQuaternary}
              />
            )}

            {/* Cột xếp chồng: job kết thúc trong ô */}
            {points.map((p, i) => {
              const segs = STACK.filter((k) => p[k] > 0);
              const x = cx(i) - barW / 2;
              let base = y(0);
              return (
                <g key={p.t}>
                  {segs.map((k, si) => {
                    const h = (p[k] / yMax) * PLOT_HEIGHT;
                    const segTop = base - h;
                    base = segTop;
                    const isTop = si === segs.length - 1;
                    // Khe 2px màu nền giữa các đoạn: đoạn dưới nhường phần trên cùng của nó
                    const yTop = isTop ? segTop : segTop + GAP;
                    const drawH = Math.max(1, isTop ? h : h - GAP);
                    return isTop ? (
                      <path key={k} d={topRoundedRect(x, yTop, barW, drawH, RADIUS)} fill={SERIES_COLORS[k]} />
                    ) : (
                      <rect key={k} x={x} y={yTop} width={barW} height={drawH} fill={SERIES_COLORS[k]} />
                    );
                  })}
                </g>
              );
            })}

            {/* Đường: job tạo mới trong ô */}
            {past > 1 && (
              <path
                d={linePath}
                fill="none"
                stroke={SERIES_COLORS.created}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            {((past === 1 && hover == null) || hover != null) && past > 0 && (
              <circle
                cx={cx(hover ?? 0)}
                cy={y(points[hover ?? 0]!.created)}
                r={4}
                fill={SERIES_COLORS.created}
                stroke={token.colorBgContainer}
                strokeWidth={2}
              />
            )}

            {/* Trục x */}
            {points.map((p, i) =>
              i % labelEvery === 0 ? (
                <text
                  key={p.t}
                  x={cx(i)}
                  y={MARGIN.top + PLOT_HEIGHT + 18}
                  textAnchor="middle"
                  fontSize={11}
                  fill={token.colorTextTertiary}
                >
                  {bucketLabel(p.t, bucket)}
                </text>
              ) : null,
            )}

            {/* Vùng trỏ chuột: cả dải của ô, lớn hơn cột */}
            {points.slice(0, past).map((p, i) => (
              <rect
                key={p.t}
                x={MARGIN.left + band * i}
                y={MARGIN.top}
                width={band}
                height={PLOT_HEIGHT}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            ))}
          </svg>
        )}

        {hovered && (
          <div
            role="status"
            style={{
              position: 'absolute',
              top: MARGIN.top,
              left: tooltipOnLeft ? undefined : tooltipLeft + 12,
              right: tooltipOnLeft ? width - tooltipLeft + 12 : undefined,
              pointerEvents: 'none',
              background: token.colorBgElevated,
              boxShadow: token.boxShadowSecondary,
              borderRadius: token.borderRadius,
              padding: '8px 12px',
              fontSize: 12,
              minWidth: 160,
              zIndex: 1,
            }}
          >
            <div style={{ color: token.colorTextSecondary, marginBottom: 4 }}>
              {bucketLabel(hovered.t, bucket, true)}
            </div>
            {(['created', ...STACK] as const).map((k) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, lineHeight: '20px' }}>
                <span style={{ width: 12, height: 2, borderRadius: 1, background: SERIES_COLORS[k] }} />
                <span style={{ color: token.colorTextSecondary, flex: 1 }}>{seriesName(k)}</span>
                <strong style={{ color: token.colorText, fontVariantNumeric: 'tabular-nums' }}>
                  {hovered[k].toLocaleString()}
                </strong>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Chú thích: ô vuông cho cột, gạch cho đường, khớp với hình vẽ. */
function Legend() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const item = (key: keyof typeof SERIES_COLORS, shape: 'rect' | 'line') => (
    <span key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          width: shape === 'rect' ? 10 : 14,
          height: shape === 'rect' ? 10 : 2,
          borderRadius: shape === 'rect' ? 2 : 1,
          background: SERIES_COLORS[key],
        }}
      />
      <span style={{ color: token.colorTextSecondary, fontSize: 12 }}>{t(`stats.series.${key}`)}</span>
    </span>
  );
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginBottom: 8 }}>
      {item('created', 'line')}
      {STACK.map((k) => item(k, 'rect'))}
    </div>
  );
}
