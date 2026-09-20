// Shared chart theme: one sophisticated palette for every chart in the app.
// Solids for categorical data (matches the stage-color system); soft vertical
// gradients only for area fills. No neon, no rainbow categorical sets.

export const PINE = '#26473E';
export const INK = 'hsl(var(--foreground))';
export const MUTED_TEXT = 'hsl(var(--muted-foreground))';
export const GRID = 'hsl(var(--border))';
export const TRACK = 'hsl(var(--muted))';

export const ACCENT = {
  success: '#1F8A4C',
  info: '#0284C7',
  warning: '#B45309',
  danger: '#DC2626',
  violet: '#6D28D9',
  teal: '#0E9594',
  slate: '#64748B',
} as const;

export const tickStyle = {
  fill: 'hsl(var(--muted-foreground))',
  fontSize: 11,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  letterSpacing: '0.04em',
} as const;

export const gridProps = {
  strokeDasharray: '2 4',
  stroke: 'hsl(var(--border))',
  vertical: false,
} as const;

/** Ordered categorical palette for multi-slice charts (success-first story). */
export const CATEGORICAL = [
  ACCENT.success,
  PINE,
  ACCENT.info,
  ACCENT.teal,
  ACCENT.warning,
  ACCENT.violet,
  ACCENT.slate,
  ACCENT.danger,
];

/** Semantic colors for verification / delivery outcomes. Keyword-matched in
 * this order — 'invalid' must precede 'valid' ('invalid' contains 'valid'). */
export function resultColor(name: string, fallback: string): string {
  const n = (name || '').toLowerCase();
  if (n.includes('invalid') || n.includes('bounced') || n.includes('failed') || n.includes('no such')) return ACCENT.danger;
  if (n.includes('valid') || n.includes('registered') || n.includes('delivered') || n.includes('sent') || n.includes('replied')) return ACCENT.success;
  if (n.includes('catch_all') || n.includes('catch-all') || n.includes('disposable') || n.includes('expired') || n.includes('retry')) return ACCENT.warning;
  if (n.includes('unknown') || n.includes('unverified') || n.includes('pending')) return ACCENT.slate;
  return fallback;
}
