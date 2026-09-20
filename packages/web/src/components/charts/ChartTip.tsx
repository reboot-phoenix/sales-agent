import React from 'react';

/** One glass tooltip for every chart: title + color-dotted rows, tabular numbers. */
export function ChartTip(props: any) {
  const { active, payload, label } = props;
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-strong min-w-[140px] rounded-xl border border-border px-3 py-2 text-xs shadow-card">
      {label != null && (
        <p className="mb-1.5 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-foreground">{String(label)}</p>
      )}
      <div className="space-y-1">
        {payload.map((p: any, i: number) => (
          <p key={i} className="flex items-center justify-between gap-4 tabular-nums text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: p.color || p.fill || p.payload?.fill }}
              />
              {p.name}
            </span>
            <span className="font-mono font-semibold text-foreground">
              {typeof p.value === 'number' ? p.value.toLocaleString() : p.value}
            </span>
          </p>
        ))}
      </div>
    </div>
  );
}
