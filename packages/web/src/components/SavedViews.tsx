import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from 'react-query';
import { savedFilters as savedFiltersApi, SavedFilter } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Bookmark, BookmarkPlus, Trash2, Users } from 'lucide-react';

/**
 * Saved views for one domain.
 *
 * A view is only as useful as the filter it replays, so applying one hands the
 * stored filter object straight to the page's own state — this component never
 * invents or reinterprets filter keys. Shared views are visible to everyone, but
 * only the owner can rename, share or delete (the API enforces that too).
 */
export function SavedViews({
  domain,
  currentFilters,
  onApply,
}: {
  domain: 'jobs' | 'hackathons' | 'colleges';
  currentFilters: Record<string, unknown>;
  onApply: (filters: Record<string, unknown>) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [share, setShare] = useState(false);

  const views = useQuery(['saved-filters', domain], () => savedFiltersApi.list({ domain }), {
    staleTime: 30000,
  });
  const rows: SavedFilter[] = (views.data as any)?.data || [];

  const save = useMutation(
    (payload: { name: string; is_shared: boolean }) =>
      savedFiltersApi.save({ domain, name: payload.name, filters: currentFilters, is_shared: payload.is_shared }),
    {
      onSuccess: (data) => {
        toast({ title: `Saved view “${data.filter.name}”`, variant: 'success' });
        setNaming(false);
        setName('');
        setShare(false);
        queryClient.invalidateQueries(['saved-filters', domain]);
      },
      onError: (e: Error) => toast({ title: 'Could not save view', description: e.message, variant: 'error' }),
    },
  );

  const apply = async (view: SavedFilter) => {
    onApply(view.filters || {});
    // Usage is recorded so frequently used views can be surfaced first.
    try {
      await savedFiltersApi.use(view.id);
      queryClient.invalidateQueries(['saved-filters', domain]);
    } catch {
      /* a usage counter is not worth blocking the view on */
    }
  };

  const remove = useMutation((id: string) => savedFiltersApi.remove(id), {
    onSuccess: () => {
      toast({ title: 'View deleted', variant: 'success' });
      queryClient.invalidateQueries(['saved-filters', domain]);
    },
    onError: (e: Error) => toast({ title: 'Could not delete view', description: e.message, variant: 'error' }),
  });

  const hasFilters = Object.keys(currentFilters || {}).length > 0;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="saved-views">
      <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
        <Bookmark className="h-3.5 w-3.5" /> Saved views
      </span>

      {rows.length === 0 && !naming && (
        <span className="text-[12px] text-muted-foreground">none yet</span>
      )}

      {rows.map((view) => (
        <span key={view.id} className="inline-flex items-center overflow-hidden rounded-full border border-border">
          <button
            type="button"
            onClick={() => apply(view)}
            title={Object.keys(view.filters || {}).length ? JSON.stringify(view.filters) : 'no filters'}
            className="px-2.5 py-0.5 text-[12px] text-foreground hover:bg-accent"
          >
            {view.name}
            {view.is_shared && <Users className="ml-1 inline h-3 w-3 text-muted-foreground" />}
          </button>
          {view.is_mine && (
            <button
              type="button"
              aria-label={`Delete view ${view.name}`}
              onClick={() => remove.mutate(view.id)}
              className="border-l border-border px-1.5 py-0.5 text-muted-foreground hover:bg-destructive-soft hover:text-destructive"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}

      {naming ? (
        <span className="inline-flex items-center gap-1.5">
          <input
            autoFocus
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="View name"
            aria-label="View name"
            className="h-7 rounded-md border border-border bg-surface px-2 text-[12px]"
          />
          <label className="flex items-center gap-1 text-[12px] text-muted-foreground">
            <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
            share with team
          </label>
          <Button
            size="sm"
            disabled={!name.trim() || save.isLoading}
            onClick={() => save.mutate({ name: name.trim(), is_shared: share })}
          >
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>Cancel</Button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setNaming(true)}
          disabled={!hasFilters}
          title={hasFilters ? 'Save the current filters as a view' : 'Set a filter first'}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-0.5 text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <BookmarkPlus className="h-3 w-3" /> Save current
        </button>
      )}
    </div>
  );
}

export default SavedViews;
