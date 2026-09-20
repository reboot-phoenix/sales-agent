// Freshness + 1–10 product score. Mirrors backend scoring.ts freshnessCategory
// and toScore10 so list rows render identically with or without server columns.
//
// Tags are TEXT ONLY (no emojis, no color-only meaning): each badge carries a
// short tag (<24H / <7D / OLDER / UNKNOWN) plus a relative age ("3h ago").

export type FreshnessCategory = 'fresh' | 'recent' | 'older' | 'unknown';

export const FRESHNESS_META: Record<
  FreshnessCategory,
  { tag: string; label: string; className: string }
> = {
  fresh: { tag: '<24H', label: '<24 hrs', className: 'bg-destructive-soft text-destructive border-destructive/20' },
  recent: { tag: '<7D', label: '<7 days', className: 'bg-success-soft text-success border-success/20' },
  older: { tag: 'OLDER', label: 'Older', className: 'bg-warning-soft text-warning border-warning/20' },
  unknown: { tag: 'UNKNOWN', label: 'Unknown', className: 'bg-muted text-muted-foreground border-border' },
};

export function freshnessCategory(
  postedAt?: string | null,
  discoveredAt?: string | null,
): FreshnessCategory {
  const ref = postedAt || discoveredAt;
  if (!ref) return 'unknown';
  const t = new Date(ref).getTime();
  if (Number.isNaN(t)) return 'unknown';
  const ageMs = Date.now() - t;
  if (ageMs < 0) return 'fresh';
  if (ageMs < 24 * 3600 * 1000) return 'fresh';
  if (ageMs < 7 * 24 * 3600 * 1000) return 'recent';
  return 'older';
}

function relativeAge(ref: string): string {
  const ageMs = Date.now() - new Date(ref).getTime();
  if (Number.isNaN(ageMs) || ageMs < 0) return 'now';
  const mins = Math.floor(ageMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** "3h ago" / "4d ago" / "12d ago" / "Unknown" — plain text, never color-only. */
export function freshnessLabel(
  postedAt?: string | null,
  discoveredAt?: string | null,
  fallbackCategory?: string | null,
): string {
  const ref = postedAt || discoveredAt;
  if (!ref) return 'Unknown';
  const cat = freshnessCategory(postedAt, discoveredAt);
  if (cat === 'unknown') {
    return (fallbackCategory as FreshnessCategory | undefined) === 'older'
      ? relativeAge(ref)
      : 'Unknown';
  }
  return relativeAge(ref);
}

/** 0–100 engine score → 1–10 product scale. 0 maps to 1 (scale has no zero). */
export function score10(score100: number | null | undefined): number {
  const s = Math.max(0, Math.min(100, Math.round(Number(score100) || 0)));
  if (s <= 0) return 1;
  return Math.max(1, Math.min(10, Math.round(s / 10)));
}
