import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { outreach as outreachApi, hackathons as hackathonsApi, colleges as collegesApi } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoader } from '@/components/ui/spinner';
import { ErrorState } from '@/components/ui/error-state';
import { EmptyState } from '@/components/ui/empty-state';
import { SavedViews } from '@/components/SavedViews';
import { BulkActionBar, HeaderCheckbox, RowCheckbox, useBulkSelection } from '@/components/BulkActionBar';
import { Send, RefreshCw, Mail, Phone, Link2, ShieldCheck, AlertTriangle } from 'lucide-react';

const DOMAIN_LABEL: Record<string, string> = {
  jobs: 'Job',
  hackathons: 'Hackathon',
  colleges: 'College',
};

const READINESS_LABEL: Record<string, string> = {
  OUTREACH_READY: 'Outreach ready',
  PARTIALLY_ENRICHED: 'Partially enriched',
  NEEDS_ENRICHMENT: 'Needs enrichment',
  INSUFFICIENT_DATA: 'Insufficient data',
};

export function readinessClass(readiness: string): string {
  switch (readiness) {
    case 'OUTREACH_READY': return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
    case 'PARTIALLY_ENRICHED': return 'bg-sky-500/15 text-sky-300 border-sky-500/30';
    case 'NEEDS_ENRICHMENT': return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    default: return 'bg-muted text-muted-foreground border-border';
  }
}

export function priorityClass(priority: string): string {
  switch (priority) {
    case 'P0': return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
    case 'P1': return 'bg-orange-500/15 text-orange-300 border-orange-500/30';
    case 'P2': return 'bg-sky-500/15 text-sky-300 border-sky-500/30';
    default: return 'bg-muted text-muted-foreground border-border';
  }
}

const DEFAULTS = {
  domain: '',
  readiness: 'OUTREACH_READY',
  priority: '',
  state: '',
  q: '',
  unclaimed_only: 'true',
  min_score: '',
};

const Outreach: React.FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [filters, setFilters] = useState<Record<string, string>>({ ...DEFAULTS });

  const params = useMemo(() => {
    const clean: Record<string, string | number> = { limit: 100 };
    for (const [key, value] of Object.entries(filters)) {
      if (value !== '') clean[key] = key === 'min_score' ? Number(value) : value;
    }
    return clean;
  }, [filters]);

  const queue = useQuery({
  queryKey: ['outreach-queue', params],
  queryFn: () => outreachApi.queue(params),
  staleTime: 15000,
  placeholderData: keepPreviousData,
});
  const summary = useQuery({
  queryKey: ['outreach-summary'],
  queryFn: () => outreachApi.summary(),
  staleTime: 60000,
});

  const rows: any[] = (queue.data as any)?.data || [];
  const counts = (queue.data as any)?.counts || { assessed: 0, ready: 0, returned: 0 };
  const selection = useBulkSelection(rows);

  const reassess = useMutation({
  mutationFn: ({ domain, id }: { domain: string; id: string }) => outreachApi.reassess(domain, id),
  onSuccess: () => {
  toast({ title: 'Lead re-checked', description: 'Deliverability and score were recomputed.', variant: 'success' });
  queryClient.invalidateQueries({
  queryKey: ['outreach-queue'],
});
  },
  onError: (e: Error) => toast({
  title: 'Re-check unavailable',
  description: `${e.message} — the previous verdict is unchanged.`,
  variant: 'warning',
  }),
});

  const bulkHandlers = {
    claim: async (ids: string[]) => {
      // Claims are per-domain; group the selection so each domain keeps its own
      // atomic rule rather than inventing a cross-domain claim path.
      const grouped: Record<string, string[]> = {};
      for (const id of ids) {
        const row = rows.find((r) => r.entity_id === id);
        if (!row) continue;
        grouped[row.domain] = [...(grouped[row.domain] || []), id];
      }
      const results = await Promise.all(
        Object.entries(grouped).map(([domain, domainIds]) =>
          domain === 'hackathons'
            ? hackathonsApi.bulkClaim(domainIds)
            : collegesApi.bulkClaim(domainIds),
        ),
      );
      return {
        requested: ids.length,
        succeeded: results.reduce((sum, r) => sum + (r?.succeeded ?? 0), 0),
        skipped: results.flatMap((r) => r?.skipped ?? []),
      };
    },
  };

  if (queue.isLoading) return <PageLoader label="Scoring outreach queue…" />;
  if (queue.isError) {
    return <ErrorState title="Could not load the outreach queue" message={(queue.error as Error).message} onRetry={() => queue.refetch()} />;
  }

  const readinessTotals = (summary.data as any)?.readiness || {};
  const locatorTotals = (summary.data as any)?.leads_with_a_locator || {};

  return (
    <div className="space-y-4">
      <PageHeader
        title="Outreach"
        description="Every lead ranked by whether a rep can actually reach it — and how urgently."
        actions={
          <Button variant="secondary" size="sm" onClick={() => { queue.refetch(); summary.refetch(); }} disabled={queue.isFetching}>
            <RefreshCw className={`h-3.5 w-3.5 ${queue.isFetching ? 'animate-spin' : ''}`} />Refresh
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(['jobs', 'hackathons', 'colleges'] as const).map((domain) => {
          const total = Object.values(readinessTotals[domain] || {}).reduce((a: number, b: any) => a + Number(b), 0);
          const ready = Number((readinessTotals[domain] || {}).OUTREACH_READY || 0);
          return (
            <div key={domain} className="card p-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {DOMAIN_LABEL[domain]}
              </p>
              <p className="mt-1 text-2xl font-semibold">{ready}</p>
              <p className="text-[12px] text-muted-foreground">
                ready of {total} · {locatorTotals[domain] ?? 0} with a locator
              </p>
            </div>
          );
        })}
        <div className="card p-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">In this queue</p>
          <p className="mt-1 text-2xl font-semibold">{counts.returned}</p>
          <p className="text-[12px] text-muted-foreground">{counts.ready} ready of {counts.assessed} assessed</p>
        </div>
      </div>

      <div className="card space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={filters.q}
            onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
            placeholder="Search name, organizer, city…"
            className="h-8 min-w-[220px] flex-1 rounded-md border border-border bg-surface px-2.5 text-[13px]"
          />
          <select aria-label="Domain" className="h-8 rounded-md border border-border bg-surface px-2 text-[13px]"
            value={filters.domain} onChange={(e) => setFilters((f) => ({ ...f, domain: e.target.value }))}>
            <option value="">All domains</option>
            <option value="jobs">Jobs</option>
            <option value="hackathons">Hackathons</option>
            <option value="colleges">Colleges</option>
          </select>
          <select aria-label="Readiness" className="h-8 rounded-md border border-border bg-surface px-2 text-[13px]"
            value={filters.readiness} onChange={(e) => setFilters((f) => ({ ...f, readiness: e.target.value }))}>
            <option value="">Any readiness</option>
            {Object.keys(READINESS_LABEL).map((key) => (
              <option key={key} value={key}>{READINESS_LABEL[key]}</option>
            ))}
          </select>
          <select aria-label="Priority" className="h-8 rounded-md border border-border bg-surface px-2 text-[13px]"
            value={filters.priority} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}>
            <option value="">Any priority</option>
            {['P0', 'P1', 'P2', 'P3', 'P4'].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <input aria-label="State" value={filters.state} placeholder="State"
            onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value }))}
            className="h-8 w-32 rounded-md border border-border bg-surface px-2 text-[13px]" />
          <input aria-label="Minimum score" type="number" min={0} max={100} placeholder="Min score"
            value={filters.min_score}
            onChange={(e) => setFilters((f) => ({ ...f, min_score: e.target.value }))}
            className="h-8 w-24 rounded-md border border-border bg-surface px-2 text-[13px]" />
          <label className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <input type="checkbox" checked={filters.unclaimed_only === 'true'}
              onChange={(e) => setFilters((f) => ({ ...f, unclaimed_only: e.target.checked ? 'true' : 'false' }))} />
            Unclaimed only
          </label>
        </div>
        <SavedViews
          domain={(filters.domain || 'colleges') as 'jobs' | 'hackathons' | 'colleges'}
          currentFilters={filters}
          onApply={(saved) => setFilters({ ...DEFAULTS, ...saved } as Record<string, string>)}
        />
      </div>

      <div className="card overflow-hidden">
        <div className="max-h-[calc(100vh-420px)] overflow-auto">
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
                <th className="table-th">Lead</th>
                <th className="table-th">Domain</th>
                <th className="table-th">Reachability</th>
                <th className="table-th">Score</th>
                <th className="table-th">Why now</th>
                <th className="table-th"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={7} className="p-4">
                  <EmptyState
                    icon={Send}
                    title="Nothing sendable matches these filters."
                    description="Widen the filters, or send the armies to enrich more leads into outreach-ready state."
                  />
                </td></tr>
              ) : rows.map((row) => {
                const assessment = row;
                const lead = row.lead || {};
                const best = assessment.best_contact || {};
                return (
                  <tr key={`${assessment.domain}-${assessment.entity_id}`} className="border-b border-border last:border-0 hover:bg-accent/50">
                    <td className="table-td">
                      <RowCheckbox
                        checked={selection.idSet.has(assessment.entity_id)}
                        onChange={() => selection.toggle(assessment.entity_id)}
                        label={assessment.name}
                      />
                    </td>
                    <td className="table-td max-w-[280px]">
                      <button
                        type="button"
                        className="truncate text-left font-medium hover:underline"
                        onClick={() => {
                          const path = assessment.domain === 'hackathons' ? 'hackathons'
                            : assessment.domain === 'colleges' ? 'colleges' : 'leads';
                          navigate(`/${path}/${assessment.entity_id}`);
                        }}
                      >
                        {assessment.name || lead.title || 'Untitled'}
                      </button>
                      <p className="truncate text-[12px] text-muted-foreground">
                        {[lead.company_name, lead.organizer_name, lead.city, lead.state].filter(Boolean).join(' · ') || '—'}
                      </p>
                    </td>
                    <td className="table-td">
                      <Badge variant="outline">{DOMAIN_LABEL[assessment.domain]}</Badge>
                    </td>
                    <td className="table-td">
                      <Badge className={readinessClass(assessment.readiness)}>
                        {READINESS_LABEL[assessment.readiness] || assessment.readiness}
                      </Badge>
                      <div className="mt-1 space-y-0.5 text-[12px]">
                        {best.email && (
                          <p className="flex items-center gap-1 truncate text-muted-foreground">
                            <Mail className="h-3 w-3" />{best.email}
                            {String(best.verification_status || '').includes('verified') && (
                              <ShieldCheck className="h-3 w-3 text-emerald-400" />
                            )}
                          </p>
                        )}
                        {best.phone && (
                          <p className="flex items-center gap-1 truncate text-muted-foreground">
                            <Phone className="h-3 w-3" />{best.phone}
                          </p>
                        )}
                        {best.linkedin_url && (
                          <p className="flex items-center gap-1 truncate text-muted-foreground">
                            <Link2 className="h-3 w-3" />profile
                          </p>
                        )}
                        {!best.email && !best.phone && !best.linkedin_url && (
                          <p className="text-muted-foreground">no locator yet</p>
                        )}
                      </div>
                    </td>
                    <td className="table-td">
                      <Badge className={priorityClass(assessment.priority)}>{assessment.priority}</Badge>
                      <p className="mt-1 text-[12px] text-muted-foreground">{assessment.score}/100</p>
                    </td>
                    <td className="table-td max-w-[260px] text-[12px] text-muted-foreground">
                      {(assessment.reasons || []).slice(0, 2).map((reason: string, i: number) => (
                        <p key={i} className="truncate">{reason}</p>
                      ))}
                      {(assessment.blockers || []).slice(0, 1).map((blocker: string, i: number) => (
                        <p key={`b${i}`} className="flex items-center gap-1 truncate text-warning">
                          <AlertTriangle className="h-3 w-3" />{blocker}
                        </p>
                      ))}
                    </td>
                    <td className="table-td">
                      <div className="flex justify-end gap-1.5">
                        {assessment.domain !== 'jobs' && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={reassess.isPending}
                            onClick={() => reassess.mutate({ domain: assessment.domain, id: assessment.entity_id })}
                          >
                            Re-check
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {selection.count > 0 && (
          <BulkActionBar ids={selection.selected} handlers={bulkHandlers} onDone={selection.clear} />
        )}
      </div>

      <p className="text-[12px] text-muted-foreground">
        Readiness requires a real locator: an email, phone or profile we found — and only a deliverability-checked
        one makes a lead “Outreach ready”. A URL alone never does.
      </p>
    </div>
  );
};

export default Outreach;
