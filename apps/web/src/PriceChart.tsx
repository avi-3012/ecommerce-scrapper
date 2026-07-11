/**
 * Themed price charts (resolves UI-UX-GAPS §4.1): brand-colored area with a
 * gradient fill, a custom tooltip card, shaded out-of-stock bands, distinct
 * failure markers, reference lines for target/low — and a single shared
 * theme so the history and comparison charts match. Colors come from CSS
 * tokens so charts follow light/dark.
 */
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { inr } from './api.js';
import type { ChartData } from './api.js';

interface TooltipRenderProps {
  active?: boolean;
  payload?: Array<{ payload: { time: number; price: number | null; mrp: number | null } }>;
}

function cssVar(name: string): string {
  if (typeof window === 'undefined') return '#1a9b9b';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#1a9b9b';
}

const fmtDay = (t: number): string =>
  new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

function ChartTooltip({ active, payload }: TooltipRenderProps): JSX.Element | null {
  if (!active || !payload?.length) return null;
  const point = payload[0]!.payload;
  return (
    <div className="rounded-lg border border-line bg-card px-3 py-2 text-xs shadow-pop">
      <p className="text-fg-subtle">{new Date(point.time).toLocaleString('en-IN')}</p>
      <p className="nums mt-0.5 font-semibold text-fg">{inr(point.price)}</p>
      {point.mrp !== null && point.mrp > (point.price ?? 0) && (
        <p className="nums text-fg-subtle">
          MRP <s>{inr(point.mrp)}</s>
        </p>
      )}
    </div>
  );
}

/** Contiguous out-of-stock spans → shaded reference bands. */
function outOfStockBands(
  points: Array<{ time: number; outOfStock: boolean }>,
): Array<[number, number]> {
  const bands: Array<[number, number]> = [];
  let start: number | null = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (p.outOfStock && start === null) start = p.time;
    if (!p.outOfStock && start !== null) {
      bands.push([start, points[i - 1]!.time]);
      start = null;
    }
  }
  if (start !== null) bands.push([start, points[points.length - 1]!.time]);
  return bands;
}

export function PriceHistoryChart({
  chart,
  targetPrice,
}: {
  chart: ChartData;
  targetPrice: number | null;
}): JSX.Element {
  const points = chart.points.map((p) => ({ ...p, time: new Date(p.t).getTime() }));
  const brand = cssVar('--brand');
  const line = cssVar('--line');
  const danger = cssVar('--danger');
  const success = cssVar('--success');
  const bands = outOfStockBands(points);
  const failureTimes = chart.failures.map((f) => new Date(f.t).getTime());
  const priceAtOrNearFailure = points[0]?.price ?? 0;

  return (
    <div className="h-72">
      <ResponsiveContainer>
        <ComposedChart data={points} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={brand} stopOpacity={0.28} />
              <stop offset="100%" stopColor={brand} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={line} vertical={false} />
          <XAxis
            dataKey="time"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={fmtDay}
            fontSize={11}
            stroke={cssVar('--fg-subtle')}
            tickLine={false}
          />
          <YAxis
            tickFormatter={(v: number) => `₹${Math.round(v / 1000)}k`}
            fontSize={11}
            width={46}
            stroke={cssVar('--fg-subtle')}
            tickLine={false}
            axisLine={false}
            domain={['auto', 'auto']}
          />
          <Tooltip content={<ChartTooltip />} />
          {bands.map(([from, to], i) => (
            <ReferenceArea
              key={i}
              x1={from}
              x2={to}
              fill={danger}
              fillOpacity={0.06}
              ifOverflow="extendDomain"
            />
          ))}
          {targetPrice && (
            <ReferenceLine
              y={targetPrice}
              stroke={brand}
              strokeDasharray="5 4"
              label={{
                value: `target ${inr(targetPrice)}`,
                fontSize: 10,
                fill: brand,
                position: 'insideTopRight',
              }}
            />
          )}
          {chart.stats.allTimeLow !== null && (
            <ReferenceLine
              y={chart.stats.allTimeLow}
              stroke={success}
              strokeDasharray="2 4"
              label={{
                value: `low ${inr(chart.stats.allTimeLow)}`,
                fontSize: 10,
                fill: success,
                position: 'insideBottomRight',
              }}
            />
          )}
          <Area
            dataKey="price"
            stroke={brand}
            strokeWidth={2}
            fill="url(#priceFill)"
            dot={points.length < 50}
            activeDot={{ r: 4 }}
            connectNulls
            isAnimationActive={false}
          />
          {failureTimes.map((t, i) => (
            <ReferenceDot
              key={i}
              x={t}
              y={priceAtOrNearFailure}
              r={3}
              fill={danger}
              stroke="none"
              ifOverflow="extendDomain"
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ComparisonChart({
  seriesA,
  seriesB,
  labelA,
  labelB,
}: {
  seriesA: Array<{ t: string; price: number | null }>;
  seriesB: Array<{ t: string; price: number | null }>;
  labelA: string;
  labelB: string;
}): JSX.Element {
  // Merge on timestamp so both series share one X axis
  const map = new Map<number, { time: number; a: number | null; b: number | null }>();
  for (const p of seriesA) {
    const t = new Date(p.t).getTime();
    map.set(t, { time: t, a: p.price, b: null });
  }
  for (const p of seriesB) {
    const t = new Date(p.t).getTime();
    const existing = map.get(t) ?? { time: t, a: null, b: null };
    existing.b = p.price;
    map.set(t, existing);
  }
  const data = [...map.values()].sort((x, y) => x.time - y.time);
  const amber = cssVar('--warning');
  const info = cssVar('--info');

  return (
    <div>
      <div className="mb-2 flex gap-4 text-xs">
        <span className="flex items-center gap-1.5 text-fg-muted">
          <span className="inline-block h-0.5 w-4" style={{ background: amber }} /> {labelA}
        </span>
        <span className="flex items-center gap-1.5 text-fg-muted">
          <span className="inline-block h-0.5 w-4" style={{ background: info }} /> {labelB}
        </span>
      </div>
      <div className="h-64">
        <ResponsiveContainer>
          <ComposedChart data={data} margin={{ left: 4, right: 12, top: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={cssVar('--line')} vertical={false} />
            <XAxis
              dataKey="time"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={fmtDay}
              fontSize={11}
              stroke={cssVar('--fg-subtle')}
              tickLine={false}
            />
            <YAxis
              tickFormatter={(v: number) => `₹${Math.round(v / 1000)}k`}
              fontSize={11}
              width={46}
              stroke={cssVar('--fg-subtle')}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              labelFormatter={(t) => new Date(t as number).toLocaleString('en-IN')}
              formatter={(value, name) => [inr(value as number), name === 'a' ? labelA : labelB]}
              contentStyle={{
                background: cssVar('--card'),
                border: `1px solid ${cssVar('--line')}`,
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            <Line
              dataKey="a"
              stroke={amber}
              strokeWidth={2}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
            <Line
              dataKey="b"
              stroke={info}
              strokeWidth={2}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
