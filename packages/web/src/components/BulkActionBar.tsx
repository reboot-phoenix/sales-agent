import React, { useCallback, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { Loader2, X } from 'lucide-react';

export interface BulkResult {
  requested: number;
  succeeded: number;
  skipped: { id: string; reason: string }[];
}

export interface BulkHandlers {
  claim?: (ids: string[]) => Promise<BulkResult>;
  assign?: (ids: string[], assignedTo: string | null) => Promise<BulkResult>;
  status?: (ids: string[], value: string) => Promise<BulkResult>;
}

/**
 * Selection state for a table plus the actions that operate on it.
 *
 * Selection is kept as an id list, not row objects, so it survives a refetch and
 * so a bulk action can only ever send ids the API will re-authorise itself.
 */
export function useBulkSelection<T extends { id: string }>(rows: T[]) {
  const [selected, setSelected] = useState<string[]>([]);
  const idSet = useMemo(() => new Set(selected), [selected]);
  const visibleIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => idSet.has(id));

  const toggle = useCallback((id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const everyVisible = visibleIds.length > 0 && visibleIds.every((id) => prev.includes(id));
      if (everyVisible) return prev.filter((id) => !visibleIds.includes(id));
      return [...new Set([...prev, ...visibleIds])];
    });
  }, [visibleIds]);

  const clear = useCallback(() => setSelected([]), []);

  return { selected, idSet, toggle, toggleAll, clear, allSelected, count: selected.length };
}

/** Header checkbox: selects (or clears) every row on the current page. */
export function HeaderCheckbox({ checked, indeterminate, onChange }: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
}) {
  return (
    <input
      type="checkbox"
      aria-label="Select all rows on this page"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = Boolean(indeterminate) && !checked;
      }}
      onChange={onChange}
    />
  );
}

/** Row checkbox, labelled with the row's own name for screen readers. */
export function RowCheckbox({ checked, onChange, label }: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      aria-label={`Select ${label}`}
      checked={checked}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

/**
 * The toolbar for a current selection.
 *
 * Bulk actions are partial-success by contract: whatever the API refused is
 * reported with its reason instead of being hidden behind a generic "done".
 */
export function BulkActionBar({
  ids,
  handlers,
  statusOptions,
  onDone,
}: {
  ids: string[];
  handlers: BulkHandlers;
  statusOptions?: { value: string; label: string }[];
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const run = async (label: string, action: () => Promise<BulkResult>) => {
    setBusy(true);
    try {
      const result = await action();
      const skipped = result?.skipped ?? [];
      toast({
        title: skipped.length === 0
          ? `${label}: ${result?.succeeded ?? 0} lead(s)`
          : `${label}: ${result?.succeeded ?? 0} of ${result?.requested ?? ids.length}`,
        description: skipped.length === 0
          ? undefined
          : `${skipped.length} skipped — ${skipped.slice(0, 3).map((s) => s.reason).join('; ')}${skipped.length > 3 ? '…' : ''}`,
        variant: skipped.length === 0 ? 'success' : 'warning',
      });
      onDone();
    } catch (e) {
      toast({ title: `${label} failed`, description: (e as Error).message, variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="sticky bottom-3 z-30 mx-auto flex w-fit items-center gap-2 rounded-full border border-border bg-surface/95 px-3 py-1.5 shadow-float backdrop-blur"
      data-testid="bulk-action-bar"
      role="region"
      aria-label="Bulk actions"
    >
      <span className="text-[12.5px] font-medium">{ids.length} selected</span>
      {handlers.claim && (
        <Button size="sm" variant="secondary" disabled={busy}
          onClick={() => run('Claimed', () => handlers.claim!(ids))}>
          {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Claim
        </Button>
      )}
      {handlers.assign && (
        <label className="flex items-center gap-1 text-[12px] text-muted-foreground">
          Assign to
          <input
            type="email"
            placeholder="member email"
            aria-label="Assign selected leads to member email"
            className="h-7 w-40 rounded-md border border-border bg-surface px-2 text-[12px]"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const value = (e.target as HTMLInputElement).value.trim();
              if (value) void run('Assigned', () => handlers.assign!(ids, value));
            }}
          />
        </label>
      )}
      {handlers.status && statusOptions && (
        <select
          aria-label="Set status for selected leads"
          className="h-7 rounded-md border border-border bg-surface px-2 text-[12px]"
          value=""
          onChange={(e) => {
            if (!e.target.value) return;
            void run('Status updated', () => handlers.status!(ids, e.target.value));
          }}
        >
          <option value="">Set status…</option>
          {statusOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      )}
      <button
        type="button"
        aria-label="Clear selection"
        onClick={onDone}
        className="grid h-6 w-6 place-items-center rounded-full text-muted-foreground hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export default BulkActionBar;
