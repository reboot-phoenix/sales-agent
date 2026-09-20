import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { useNavigate } from 'react-router-dom';
import { leads as leadsApi } from '@/lib/api';
import { Lead } from '@/lib/types';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoader } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Pagination } from '@/components/ui/pagination';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { stageMeta, formatDate } from '@/lib/format';
import { score10 } from '@/lib/freshness';
import { Eye, Users, RefreshCw, Search, Zap, Loader2 } from 'lucide-react';

function ownerLabel(l: Lead): string {
  const claimed = (l as any).claimed_by_email || (l as any).claimed_by;
  const assigned = (l as any).assigned_to_email || (l as any).assigned_to;
  if (claimed && assigned && claimed !== assigned) return `Claimed by ${short(claimed)} · Assigned to ${short(assigned)}`;
  if (assigned) return `Assigned to ${short(assigned)}`;
  if (claimed) return `Claimed by ${short(claimed)}`;
  return 'Unclaimed';
}
function short(v: unknown): string {
  return String(v).split('@')[0];
}

const MyLeads: React.FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [confirmEnrich, setConfirmEnrich] = useState<{ id: string; label: string } | null>(null);
  const limit = 25;

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery(
    ['my-leads', page, search, stage],
    () => leadsApi.mine({ page, limit, filter: search || undefined, pipeline_stage: stage || undefined }),
    { staleTime: 15000 },
  );

  const rows: Lead[] = (data as any)?.data || [];
  const pagination = (data as any)?.pagination;

  const counts = React.useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.pipeline_stage] = (c[r.pipeline_stage] || 0) + 1;
    return c;
  }, [rows]);

  const act = (leadId: string, kind: string, fn: Promise<unknown>, msg: string) => {
    setBusy((b) => ({ ...b, [leadId]: kind }));
    fn.then(() => {
      toast({ title: msg, variant: 'success' });
      queryClient.invalidateQueries('my-leads');
      queryClient.invalidateQueries('leads');
    })
      .catch((e: Error) => toast({ title: 'Action failed', description: e.message, variant: 'error' }))
      .finally(() => setBusy((b) => { const n = { ...b }; delete n[leadId]; return n; }));
  };

  if (isLoading) return <PageLoader label="Loading my leads..." />;
  if (isError) return <ErrorState title="Error loading my leads" message={(error as Error).message} onRetry={() => refetch()} />;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Workspace"
        title="My Leads"
        description={`Your claimed + assigned work queue · ${pagination?.total ?? 0} leads`}
        actions={
          <>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search my leads…" className="input pl-9" />
            </div>
            <select value={stage} onChange={(e) => { setStage(e.target.value); setPage(1); }} className="input w-40" aria-label="Stage">
              <option value="">All stages</option>
              <option value="discovered">New</option>
              <option value="enriched">Enriched</option>
              <option value="contacted">Contacted</option>
              <option value="replied">Replied</option>
              <option value="converted">Converted</option>
            </select>
            <Button variant="outline" size="sm" onClick={() => refetch()} loading={isFetching}><RefreshCw className="h-4 w-4" /></Button>
          </>
        }
      />

      {Object.keys(counts).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(counts).map(([s, n]) => {
            const meta = stageMeta(s);
            return <Badge key={s} className={meta.className}>{meta.label} · {n}</Badge>;
          })}
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="max-h-[calc(100vh-280px)] overflow-auto">
          <table className="w-full border-separate border-spacing-0">
            <thead className="sticky top-0 z-20">
              <tr>
                <th className="table-th">Score</th>
                <th className="table-th">Company</th>
                <th className="table-th">HR Contact</th>
                <th className="table-th">Owner</th>
                <th className="table-th">Stage</th>
                <th className="table-th">Discovered</th>
                <th className="table-th"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={7} className="p-4"><EmptyState icon={Users} title="No leads yet." description="Claim unclaimed leads from the Leads page — they land here and survive refresh." action={<Button variant="outline" size="sm" onClick={() => navigate('/leads')}>Browse Leads</Button>} /></td></tr>
              ) : rows.map((l: any) => (
                <tr key={l.id} className="border-b border-border last:border-0 hover:bg-accent/50">
                  <td className="table-td"><span className="inline-flex h-8 w-8 items-center justify-center rounded-full border bg-muted text-[13px] font-bold tabular-nums" title={`${l.lead_score}/100`}>{l.score_10 ?? score10(l.lead_score)}<span className="text-[10px] font-medium text-muted-foreground">/10</span></span></td>
                  <td className="table-td"><p className="truncate font-medium">{l.company_name || '—'}</p><p className="truncate text-xs text-muted-foreground">{l.job_title || ''}</p></td>
                  <td className="table-td">{l.hr_name ? <div className="flex items-center gap-2"><Avatar name={l.hr_name} size="sm" /><div className="min-w-0"><p className="truncate text-[13px] font-medium">{l.hr_name}</p>{l.hr_email && <p className="truncate text-xs text-muted-foreground">{l.hr_email}</p>}</div></div> : <span className="text-[12px] text-warning">needs enrichment</span>}</td>
                  <td className="table-td"><span className="text-[12px] text-muted-foreground">{ownerLabel(l)}</span></td>
                  <td className="table-td">{(() => { const m = stageMeta(l.pipeline_stage); return <Badge className={m.className}>{m.label}</Badge>; })()}</td>
                  <td className="table-td text-[13px] text-muted-foreground">{formatDate(l.created_at)}</td>
                  <td className="table-td">
                    <div className="flex items-center justify-end gap-1.5">
                      <button type="button" title="Open" onClick={() => navigate(`/leads/${l.id}`)} className="grid h-7 w-7 place-items-center rounded-full border border-border text-muted-foreground hover:text-foreground"><Eye className="h-3.5 w-3.5" /></button>
                      <Button variant="secondary" size="sm" disabled={!!busy[l.id]} onClick={() => setConfirmEnrich({ id: l.id, label: `${l.company_name || 'This lead'}${l.job_title ? ` · ${l.job_title}` : ''}` })}>
                        {busy[l.id] === 'enrich' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}Enrich
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pagination && <div className="border-t border-border"><Pagination pagination={pagination} onPageChange={(p: number) => setPage(p)} /></div>}
      </div>
      {confirmEnrich && (
        <ConfirmDialog
          open
          onClose={() => setConfirmEnrich(null)}
          onConfirm={() => { const c = confirmEnrich; setConfirmEnrich(null); act(c.id, 'enrich', leadsApi.enrich(c.id, 'auto'), 'Enrichment started'); }}
          title="Enrich this lead?"
          description={`${confirmEnrich.label}. Runs the free OSINT cascade first, then paid providers where keys exist — paid lookups may consume credits.`}
          confirmLabel="Enrich"
        />
      )}
    </div>
  );
};

export default MyLeads;
