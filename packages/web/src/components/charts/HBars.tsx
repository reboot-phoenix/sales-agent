import React from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, LabelList,
} from 'recharts';
import { ChartTip } from './ChartTip';
import { tickStyle, gridProps } from './theme';

export interface HBarRow {
  key: string;
  label: string;
  value: number;
  color: string;
  hint?: string;
}

interface HBarsProps {
  data: HBarRow[];
  height?: number;
  /** Fill the parent height instead of a fixed pixel height (parent must size itself). */
  grow?: boolean;
  onSelect?: (row: HBarRow) => void;
}

/** Horizontal bars with rounded ends, inline value labels, optional click. */
export function HBars({ data, height = 220, grow = false, onSelect }: HBarsProps) {
  const barSize = data.length <= 2 ? 36 : data.length <= 4 ? 30 : 22;
  return (
    <div
      className={`w-full ${grow ? 'min-h-[200px] flex-1' : ''}`}
      style={grow ? undefined : { height }}
      role={onSelect ? 'button' : undefined}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}
          layout="vertical" margin={{ left: 8, right: 64, top: 0, bottom: 0 }} barCategoryGap="26%">
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
          <XAxis type="number" hide domain={[0, 'dataMax']} />
          <YAxis
            type="category"
            dataKey="label"
            width={110}
            tick={{ ...tickStyle, fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip content={<ChartTip />} cursor={{ fill: 'hsl(var(--accent) / 0.35)' }} />
          <Bar
            dataKey="value"
            name="Leads"
            radius={[0, 8, 8, 0]}
            animationDuration={700}
            maxBarSize={barSize}
            onClick={(_: any, index: number) => {
              const row = data[index];
              if (row && onSelect) onSelect(row);
            }}
            style={onSelect ? { cursor: 'pointer' } : undefined}
          >
            {data.map((d, i) => (
              <Cell key={d.key} fill={d.color} />
            ))}
            <LabelList
              dataKey="value"
              position="right"
              formatter={(v: any) => (typeof v === 'number' ? v.toLocaleString() : v)}
              style={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12, fontWeight: 600, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
