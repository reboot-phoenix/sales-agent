import React from 'react';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { ChartTip } from './ChartTip';
import { PINE, tickStyle, gridProps } from './theme';

interface TrendAreaProps {
  data: Array<Record<string, string | number>>;
  xKey: string;
  yKey: string;
  yName: string;
  height?: number;
  color?: string;
  id: string;
}

/** Smooth area trend with a soft gradient fill and styled axes. */
export function TrendArea({ data, xKey, yKey, yName, height = 190, color = PINE, id }: TrendAreaProps) {
  const gid = `trend-${id}`;
  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ left: -12, right: 12, top: 8, bottom: 0 }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid {...gridProps} />
          <XAxis
            dataKey={xKey}
            tick={{ ...tickStyle, dy: 8 }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={24}
          />
          <YAxis
            tick={tickStyle}
            axisLine={false}
            tickLine={false}
            allowDecimals={false}
            width={44}
            domain={[0, 'dataMax']}
            tickCount={5}
          />
          <Tooltip
            content={<ChartTip />}
            cursor={{ stroke: color, strokeOpacity: 0.35, strokeWidth: 1.5 }}
          />
          <Area
            type="monotone"
            dataKey={yKey}
            name={yName}
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gid})`}
            dot={{ r: 2.5, fill: color, strokeWidth: 0 }}
            activeDot={{ r: 5, strokeWidth: 2, stroke: 'hsl(var(--surface))' }}
            animationDuration={800}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
