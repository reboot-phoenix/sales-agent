import React from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';
import { ChartTip } from './ChartTip';
import { TRACK } from './theme';

export interface DonutSlice {
  name: string;
  value: number;
  color: string;
}

interface DonutProps {
  data: DonutSlice[];
  /** Big center readout, e.g. total or "77%". */
  centerTop: React.ReactNode;
  /** Small caption under the center readout. */
  centerBottom?: React.ReactNode;
  size?: number;
  thickness?: number;
  /** 'row' (donut + legend side by side) or 'column' (legend below, for narrow cards). */
  layout?: 'row' | 'column';
}

/** Donut with a center readout + a clean value legend. One style everywhere. */
export function Donut({ data, centerTop, centerBottom, size = 128, thickness = 46, layout = 'row' }: DonutProps) {
  const outer = size / 2;
  const inner = outer - thickness / 2 - 4;
  const total = data.reduce((a, d) => a + d.value, 0);
  return (
    <div className={`flex ${layout === 'column' ? 'flex-col items-center gap-3' : 'items-center gap-4'}`}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={inner}
              outerRadius={outer}
              paddingAngle={Math.max(2, 90 / Math.max(total, 1))}
              stroke="none"
              cornerRadius={5}
              animationDuration={800}
            >
              {data.map((d) => (
                <Cell key={d.name} fill={d.value > 0 ? d.color : TRACK} />
              ))}
            </Pie>
            <Tooltip content={<ChartTip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-ink-strong text-xl font-bold tabular-nums">{centerTop}</span>
          {centerBottom && (
            <span className="max-w-[90px] truncate text-center text-[10px] leading-tight text-muted-foreground">
              {centerBottom}
            </span>
          )}
        </div>
      </div>
      <div className={`min-w-0 flex-1 space-y-1.5 text-sm ${layout === 'column' ? 'w-full' : ''}`}>
        {data.map((d) => (
          <div key={d.name} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: d.color }} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{d.name}</span>
            <span className="font-semibold tabular-nums">{d.value.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
