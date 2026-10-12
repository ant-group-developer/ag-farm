import { theme } from 'antd';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { niceTicks } from '../stats/period';

/**
 * Line chart for machine readings, drawn like the stats page's TimeSeriesChart (same grid, ticks, tooltip, keyboard
 * hover) but for continuous values: one line per series, gaps where the machine sent nothing.
 */
export interface MetricSeries {
  key: string;
  label: string;
  color: string;
  values: Array<number | null>;
}

interface Props {
  title: string;
  /** ISO start of each bucket. */
  times: string[];
  series: MetricSeries[];
  /** Tick and tooltip text of a value. */
  format: (v: number) => string;
  /** Short time on the x axis, long time in the tooltip. */
  timeLabel: (t: string, long?: boolean) => string;
  /** Fixed top of the y axis (100 for percentages); otherwise from the data. */
  max?: number;
  stale?: boolean;
}

const PLOT_HEIGHT = 120;
const MARGIN = { top: 8, right: 12, bottom: 24, left: 64 };

export function MetricChart({ title, times, series, format, timeLabel, max, stale }: Props) {
  const { token } = theme.useToken();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = times.length;
  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const band = n > 0 ? innerW / n : 0;
  const cx = (i: number) => MARGIN.left + band * i + band / 2;

  const ticks = useMemo(() => {
    const top = max ?? series.reduce((m, s) => s.values.reduce<number>((mm, v) => (v != null && v > mm ? v : mm), m), 0);
    return niceTicks(top, 4);
  }, [series, max]);
  const yMax = ticks[ticks.length - 1]!;
  const y = (v: number) => MARGIN.top + PLOT_HEIGHT - (Math.min(v, yMax) / yMax) * PLOT_HEIGHT;

  /** Path with a new segment after every gap. */
  const pathOf = (values: Array<number | null>) => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${cx(i)},${y(v)}`;
      pen = true;
    });
    return d;
  };
  /** Points with no neighbour on either side: a path cannot show them, draw a dot. */
  const lonely = (values: Array<number | null>) =>
    values.flatMap((v, i) => (v != null && values[i - 1] == null && values[i + 1] == null ? [i] : []));

  const labelEvery = Math.max(1, Math.ceil(64 / Math.max(band, 1)));
  const hasData = series.some((s) => s.values.some((v) => v != null));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (n === 0) return;
    if (e.key === 'ArrowRight') setHover((h) => (h == null ? 0 : Math.min(n - 1, h + 1)));
    else if (e.key === 'ArrowLeft') setHover((h) => (h == null ? n - 1 : Math.max(0, h - 1)));
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };

  const tooltipLeft = hover != null ? cx(hover) : 0;
  const tooltipOnLeft = tooltipLeft > width * 0.6;

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px', marginBottom: 4 }}>
        <span style={{ color: token.colorText, fontWeight: 500, fontSize: 13 }}>{title}</span>
        {series.length > 1 &&
          series.map((s) => (
            <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 14, height: 2, borderRadius: 1, background: s.color }} />
              <span style={{ color: token.colorTextSecondary, fontSize: 12 }}>{s.label}</span>
            </span>
          ))}
      </div>
      <div
        ref={wrapRef}
        tabIndex={0}
        role="img"
        aria-label={title}
        onKeyDown={onKeyDown}
        onBlur={() => setHover(null)}
        style={{ position: 'relative', opacity: stale ? 0.5 : 1, transition: 'opacity 150ms', outline: 'none' }}
      >
        {width > 0 && (
          <svg
            width={width}
            height={MARGIN.top + PLOT_HEIGHT + MARGIN.bottom}
            style={{ display: 'block' }}
            onMouseLeave={() => setHover(null)}
          >
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
                  {format(v)}
                </text>
              </g>
            ))}

            {hover != null && (
              <line
                x1={cx(hover)}
                x2={cx(hover)}
                y1={MARGIN.top}
                y2={MARGIN.top + PLOT_HEIGHT}
                stroke={token.colorBorder}
                strokeWidth={1}
              />
            )}

            {series.map((s) => (
              <g key={s.key}>
                <path d={pathOf(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {lonely(s.values).map((i) => (
                  <circle key={i} cx={cx(i)} cy={y(s.values[i]!)} r={2.5} fill={s.color} />
                ))}
                {hover != null && s.values[hover] != null && (
                  <circle
                    cx={cx(hover)}
                    cy={y(s.values[hover]!)}
                    r={4}
                    fill={s.color}
                    stroke={token.colorBgContainer}
                    strokeWidth={2}
                  />
                )}
              </g>
            ))}

            {times.map((t, i) =>
              i % labelEvery === 0 ? (
                <text
                  key={t}
                  x={cx(i)}
                  y={MARGIN.top + PLOT_HEIGHT + 16}
                  textAnchor="middle"
                  fontSize={11}
                  fill={token.colorTextTertiary}
                >
                  {timeLabel(t)}
                </text>
              ) : null,
            )}

            {times.map((t, i) => (
              <rect
                key={t}
                x={MARGIN.left + band * i}
                y={MARGIN.top}
                width={band}
                height={PLOT_HEIGHT}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            ))}

            {!hasData && (
              <text
                x={MARGIN.left + innerW / 2}
                y={MARGIN.top + PLOT_HEIGHT / 2}
                textAnchor="middle"
                fontSize={12}
                fill={token.colorTextTertiary}
              >
                —
              </text>
            )}
          </svg>
        )}

        {hover != null && times[hover] && (
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
              padding: '6px 10px',
              fontSize: 12,
              minWidth: 140,
              zIndex: 1,
            }}
          >
            <div style={{ color: token.colorTextSecondary, marginBottom: 2 }}>{timeLabel(times[hover]!, true)}</div>
            {series.map((s) => (
              <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 8, lineHeight: '20px' }}>
                <span style={{ width: 12, height: 2, borderRadius: 1, background: s.color }} />
                <span style={{ color: token.colorTextSecondary, flex: 1 }}>{s.label}</span>
                <strong style={{ color: token.colorText, fontVariantNumeric: 'tabular-nums' }}>
                  {s.values[hover] != null ? format(s.values[hover]!) : '-'}
                </strong>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
