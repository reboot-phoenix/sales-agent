import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { colleges as collegesApi } from '@/lib/api';
import { College } from '@/lib/types';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoader } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Pagination } from '@/components/ui/pagination';
import { SavedViews } from '@/components/SavedViews';
import { BulkActionBar, HeaderCheckbox, RowCheckbox, useBulkSelection } from '@/components/BulkActionBar';
import { GraduationCap, Download, RefreshCw, Search, Eye, Sparkles } from 'lucide-react';

export function readinessClass(readiness: string): string {
  switch (readiness) {
    case 'OUTREACH_READY': return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
    case 'PARTIALLY_ENRICHED': return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    case 'NEEDS_ENRICHMENT': return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
    default: return 'bg-muted text-muted-foreground border-border';
  }
}

const Colleges: React.FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [state, setState] = useState('');
  const [ownership, setOwnership] = useState('');
  const [hasTpo, setHasTpo] = useState(false);
  const [readiness, setReadiness] = useState('');
  const limit = 25;

  const params = useMemo(() => ({
    page, limit,
    q: search || undefined,
    state: state || undefined,
    ownership: ownership || undefined,
    has_tpo: hasTpo ? true : undefined,
    outreach_readiness: readiness || undefined,
  }), [page, search, state, ownership, hasTpo, readiness]);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
  queryKey: ['colleges', params],
  queryFn: () => collegesApi.list(params),
  staleTime: 15000, placeholderData: keepPreviousData,
});
  const { data: statesData } = useQuery({
  queryKey: ['college-states'],
  queryFn: () => collegesApi.states(),
  staleTime: 300000,
});

  const rows: College[] = (data as any)?.data || [];
  const pagination = (data as any)?.pagination;
  const states: Array<{ state: string; total: number; with_tpo: number }> = statesData?.states || [];
  const selection = useBulkSelection(rows);

  const bulkStatus = useMutation({
  mutationFn: ({ ids, value }: { ids: string[]; value: string }) => collegesApi.bulkStatus(ids, 'outreach_status', value),
  onSuccess: () => queryClient.invalidateQueries({
  queryKey: ['colleges'],
}),
  onError: (e: Error) => toast({ title: 'Bulk status failed', description: e.message, variant: 'error' }),
});

  const claim = useMutation({
  mutationFn: (id: string) => collegesApi.claim(id),
  onSuccess: () => { toast({ title: 'College claimed', variant: 'success' }); queryClient.invalidateQueries({
  queryKey: ['colleges'],
}); },
  onError: (e: Error) => toast({ title: 'Claim failed', description: e.message, variant: 'error' }),
});

  const exportCsv = async () => {
    try {
      const blob = await collegesApi.exportCsv({ ...params, limit: undefined });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'colleges.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast({ title: 'Export failed', description: (e as Error).message, variant: 'error' });
    }
  };

  if (isLoading) return <PageLoader label="Loading college intelligence..." />;
  if (isError) return <ErrorState title="Error loading colleges" message={(error as Error).message} onRetry={() => refetch()} />;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Intelligence"
        title="College Intelligence"
        description={`State-wise institution dataset with outreach contacts · ${pagination?.total ?? 0} colleges`}
        actions={
          <>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search college, city, TPO…" className="input pl-9" />
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} loading={isFetching}><RefreshCw className="h-4 w-4" /></Button>
            <Button variant="outline" size="sm" onClick={exportCsv}><Download className="h-4 w-4" />CSV</Button>
          </>
        }
      />

      <div className="card flex flex-wrap items-center gap-2 p-3">
        <select value={state} onChange={(e) => { setState(e.target.value); setPage(1); }} className="input w-52" aria-label="State">
          <option value="">All states</option>
          {states.map((s) => <option key={s.state} value={s.state}>{s.state} ({s.total})</option>)}
        </select>
        <select value={ownership} onChange={(e) => { setOwnership(e.target.value); setPage(1); }} className="input w-40" aria-label="Ownership">
          <option value="">Any ownership</option>
          <option value="government">Government</option>
          <option value="private">Private</option>
          <option value="aided">Aided</option>
          <option value="autonomous">Autonomous</option>
          <option value="deemed">Deemed</option>
        </select>
        <select value={readiness} onChange={(e) => { setReadiness(e.target.value); setPage(1); }} className="input w-48" aria-label="Outreach readiness">
          <option value="">Any readiness</option>
          <option value="OUTREACH_READY">Outreach ready</option>
          <option value="PARTIALLY_ENRICHED">Partially enriched</option>
          <option value="NEEDS_ENRICHMENT">Needs enrichment</option>
          <option value="INSUFFICIENT_DATA">Insufficient data</option>
        </select>
        <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <input type="checkbox" checked={hasTpo} onChange={(e) => { setHasTpo(e.target.checked); setPage(1); }} />
          Has TPO / placement contact
        </label>
      </div>

      <SavedViews
        domain="colleges"
        currentFilters={{ q: search, state, ownership, readiness, has_tpo: hasTpo ? 'true' : '' }}
        onApply={(saved) => {
          const pick = (key: string) => (saved[key] === undefined || saved[key] === null ? '' : String(saved[key]));
          setSearch(pick('q'));
          setState(pick('state'));
          setOwnership(pick('ownership'));
          setReadiness(pick('readiness'));
          setHasTpo(pick('has_tpo') === 'true');
          setPage(1);
        }}
      />

      <div className="card overflow-hidden">
        <div className="max-h-[calc(100vh-320px)] overflow-auto">
          <table className="w-full border-separate border-spacing-0">
            <thead className="sticky top-0 z-20">
              <tr>
                <th className="table-th w-8">
                  <HeaderCheckbox
                    checked={selection.allSelected}
                    indeterminate={selection.count > 0}
                    onChange={selection.toggleAll}
                  />
                </th>
                <th className="table-th">College</th>
                <th className="table-th">Location</th>
                <th className="table-th">Type</th>
                <th className="table-th">TPO / Placement</th>
                <th className="table-th">Readiness</th>
                <th className="table-th">Enrichment</th>
                <th className="table-th"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={8} className="p-4">
                  <EmptyState icon={GraduationCap} title="No colleges match these filters." description="Run the College Army from the Armies page to populate the dataset." />
                </td></tr>
              ) : rows.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0 hover:bg-accent/50">
                  <td className="table-td">
                    <RowCheckbox
                      checked={selection.idSet.has(c.id)}
                      onChange={() => selection.toggle(c.id)}
                      label={c.name}
                    />
                  </td>
                  <td className="table-td max-w-[300px]">
                    <p className="truncate font-medium">{c.name}</p>
                    {c.university_affiliation && <p className="truncate text-xs text-muted-foreground">{c.university_affiliation}</p>}
                  </td>
                  <td className="table-td text-[13px] text-muted-foreground">{[c.city, c.district, c.state].filter(Boolean).join(', ') || '—'}</td>
                  <td className="table-td text-[13px]">{c.institution_type || '—'}{c.ownership ? ` · ${c.ownership}` : ''}</td>
                  <td className="table-td">
                    {c.tpo_name || c.tpo_email ? (
                      <div className="text-[12px]">
                        {c.tpo_name && <p className="truncate font-medium">{c.tpo_name}</p>}
                        {c.tpo_email && <p className="truncate text-muted-foreground">{c.tpo_email}</p>}
                      </div>
                    ) : c.tpo_contact_count ? (
                      <span className="text-[12px] text-muted-foreground">{c.tpo_contact_count} placement contact(s)</span>
                    ) : (
                      <span className="text-[12px] text-warning">not found</span>
                    )}
                  </td>
                  <td className="table-td"><Badge className={readinessClass(c.outreach_readiness)}>{c.outreach_readiness.replace(/_/g, ' ')}</Badge></td>
                  <td className="table-td text-[12px] text-muted-foreground">{c.enrichment_status}{c.contacts_count ? ` · ${c.contacts_count} contacts` : ''}</td>
                  <td className="table-td">
                    <div className="flex items-center justify-end gap-1.5">
                      <button type="button" title="Open" onClick={() => navigate(`/colleges/${c.id}`)} className="grid h-7 w-7 place-items-center rounded-full border border-border text-muted-foreground hover:text-foreground"><Eye className="h-3.5 w-3.5" /></button>
                      {!c.claimed_by && !c.assigned_to && (
                        <Button variant="secondary" size="sm" disabled={claim.isPending} onClick={() => claim.mutate(c.id)}><Sparkles className="h-3.5 w-3.5" />Claim</Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pagination && <div className="border-t border-border"><Pagination pagination={pagination} onPageChange={(p: number) => setPage(p)} /></div>}
        {selection.count > 0 && (
          <BulkActionBar
            ids={selection.selected}
            handlers={{
              claim: (ids) => collegesApi.bulkClaim(ids),
              assign: (ids, email) => collegesApi.bulkAssign(ids, email),
              status: (ids, value) => bulkStatus.mutateAsync({ ids, value }),
            }}
            statusOptions={[
              { value: 'in_progress', label: 'In progress' },
              { value: 'contacted', label: 'Contacted' },
              { value: 'replied', label: 'Replied' },
              { value: 'closed', label: 'Closed' },
            ]}
            onDone={selection.clear}
          />
        )}
      </div>
    </div>
  );
};

export default Colleges;
