import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { leads as leadsApi, myLeadsDomains } from '@/lib/api';
import { Lead, Hackathon, College } from '@/lib/types';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoader } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Pagination } from '@/components/ui/pagination';
import { stageMeta, formatDate } from '@/lib/format';
import { score10 } from '@/lib/freshness';
import { statusBadgeClass } from './Hackathons';
import { readinessClass } from './Colleges';
import { Eye, Users, RefreshCw, Search, Zap, Trophy, GraduationCap } from 'lucide-react';

type Tab = 'jobs' | 'hackathons' | 'colleges';

const TABS: { key: Tab; label: string; icon: typeof Users }[] = [
  { key: 'jobs', label: 'Jobs', icon: Users },
  { key: 'hackathons', label: 'Hackathons', icon: Trophy },
  { key: 'colleges', label: 'Colleges', icon: GraduationCap },
];

function ownerLabel(row: any): string {
  const claimed = row.claimed_by_email || row.claimed_by;
  const assigned = row.assigned_to_email || row.assigned_to;
  const short = (v: unknown) => String(v).split('@')[0];
  if (claimed && assigned && claimed !== assigned) return `Claimed by ${short(claimed)} · Assigned to ${short(assigned)}`;
  if (assigned) return `Assigned to ${short(assigned)}`;
  if (claimed) return `Claimed by ${short(claimed)}`;
  return 'Unclaimed';
}

const MyLeads: React.FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('jobs');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const limit = 25;

  const summary = useQuery({
  queryKey: ['my-leads-summary'],
  queryFn: () => myLeadsDomains.summary(),
  staleTime: 30000,
});

  const jobsQuery = useQuery({
  queryKey: ['my-leads-jobs', page, search],
  queryFn: () => leadsApi.mine({ page, limit, filter: search || undefined }),
  enabled: tab === 'jobs', staleTime: 15000, placeholderData: keepPreviousData,
});
  const hackathonsQuery = useQuery({
  queryKey: ['my-leads-hackathons', page, search],
  queryFn: () => myLeadsDomains.hackathons({ page, limit, q: search || undefined }),
  enabled: tab === 'hackathons', staleTime: 15000, placeholderData: keepPreviousData,
});
  const collegesQuery = useQuery({
  queryKey: ['my-leads-colleges', page, search],
  queryFn: () => myLeadsDomains.colleges({ page, limit, q: search || undefined }),
  enabled: tab === 'colleges', staleTime: 15000, placeholderData: keepPreviousData,
});

  const enrichJob = useMutation({
  mutationFn: (id: string) => leadsApi.enrich(id, 'auto'),
  onSuccess: () => { toast({ title: 'Enrichment started', variant: 'success' }); queryClient.invalidateQueries({
  queryKey: ['my-leads-jobs'],
}); },
  onError: (e: Error) => toast({ title: 'Action failed', description: e.message, variant: 'error' }),
});

  const active = tab === 'jobs' ? jobsQuery : tab === 'hackathons' ? hackathonsQuery : collegesQuery;
  const rows: any[] = active.data?.data || [];
  const pagination = active.data?.pagination;

  const switchTab = (next: Tab) => { setTab(next); setPage(1); setSearch(''); };

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Workspace"
        title="My Leads"
        description="Everything you have claimed or been assigned — each domain keeps its own schema and workflow."
        actions={
          <>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search my leads…" className="input pl-9" />
            </div>
            <Button variant="outline" size="sm" onClick={() => active.refetch()} loading={active.isFetching}><RefreshCw className="h-4 w-4" /></Button>
          </>
        }
      />

      <div className="flex flex-wrap gap-2">
        {TABS.map(({ key, label, icon: Icon }) => {
          const counts = summary.data?.[key];
          return (
            <button
              key={key}
              type="button"
              onClick={() => switchTab(key)}
              className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px] font-medium transition-colors ${
                tab === key ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
              {counts?.total != null && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px]">{counts.total}</span>}
            </button>
          );
        })}
      </div>

      {active.isLoading ? (
        <PageLoader label="Loading my leads..." />
      ) : active.isError ? (
        <ErrorState title="Error loading my leads" message={(active.error as Error).message} onRetry={() => active.refetch()} />
      ) : (
        <div className="card overflow-hidden">
          <div className="max-h-[calc(100vh-280px)] overflow-auto">
            {tab === 'jobs' && (
              <table className="w-full border-separate border-spacing-0">
                <thead className="sticky top-0 z-20"><tr>
                  <th className="table-th">Score</th><th className="table-th">Company</th><th className="table-th">HR Contact</th>
                  <th className="table-th">Owner</th><th className="table-th">Stage</th><th className="table-th">Discovered</th><th className="table-th"><span className="sr-only">Actions</span></th>
                </tr></thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={7} className="p-4"><EmptyState icon={Users} title="No job leads yet." description="Claim unclaimed leads from the Leads page." action={<Button variant="outline" size="sm" onClick={() => navigate('/leads')}>Browse Jobs</Button>} /></td></tr>
                  ) : rows.map((l: Lead) => (
                    <tr key={l.id} className="border-b border-border last:border-0 hover:bg-accent/50">
                      <td className="table-td"><span className="inline-flex h-8 w-8 items-center justify-center rounded-full border bg-muted text-[13px] font-bold tabular-nums">{score10(l.lead_score)}<span className="text-[10px] font-medium text-muted-foreground">/10</span></span></td>
                      <td className="table-td"><p className="truncate font-medium">{l.company_name || '—'}</p><p className="truncate text-xs text-muted-foreground">{l.job_title || ''}</p></td>
                      <td className="table-td">{l.hr_name ? <div className="flex items-center gap-2"><Avatar name={l.hr_name} size="sm" /><div className="min-w-0"><p className="truncate text-[13px] font-medium">{l.hr_name}</p>{l.hr_email && <p className="truncate text-xs text-muted-foreground">{l.hr_email}</p>}</div></div> : <span className="text-[12px] text-warning">needs enrichment</span>}</td>
                      <td className="table-td"><span className="text-[12px] text-muted-foreground">{ownerLabel(l)}</span></td>
                      <td className="table-td">{(() => { const m = stageMeta(l.pipeline_stage); return <Badge className={m.className}>{m.label}</Badge>; })()}</td>
                      <td className="table-td text-[13px] text-muted-foreground">{formatDate(l.created_at)}</td>
                      <td className="table-td">
                        <div className="flex items-center justify-end gap-1.5">
                          <button type="button" title="Open" onClick={() => navigate(`/leads/${l.id}`)} className="grid h-7 w-7 place-items-center rounded-full border border-border text-muted-foreground hover:text-foreground"><Eye className="h-3.5 w-3.5" /></button>
                          <Button variant="secondary" size="sm" disabled={enrichJob.isPending} onClick={() => enrichJob.mutate(l.id)}><Zap className="h-3.5 w-3.5" />Enrich</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {tab === 'hackathons' && (
              <table className="w-full border-separate border-spacing-0">
                <thead className="sticky top-0 z-20"><tr>
                  <th className="table-th">Hackathon</th><th className="table-th">Organizer</th><th className="table-th">Event</th>
                  <th className="table-th">Owner</th><th className="table-th">Status</th><th className="table-th">Contact</th><th className="table-th"><span className="sr-only">Actions</span></th>
                </tr></thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={7} className="p-4"><EmptyState icon={Trophy} title="No hackathons claimed." description="Claim hackathons from the Hackathons page." action={<Button variant="outline" size="sm" onClick={() => navigate('/hackathons')}>Browse Hackathons</Button>} /></td></tr>
                  ) : rows.map((h: Hackathon) => (
                    <tr key={h.id} className="border-b border-border last:border-0 hover:bg-accent/50">
                      <td className="table-td"><p className="truncate font-medium">{h.name}</p>{h.technology && <p className="truncate text-xs text-muted-foreground">{h.technology}</p>}</td>
                      <td className="table-td text-[13px]">{h.organizer_name || '—'}</td>
                      <td className="table-td text-[12px] text-muted-foreground">
                        {h.event_start && <p>Event: {formatDate(h.event_start)}</p>}
                        {h.registration_deadline && <p>Reg: {formatDate(h.registration_deadline)}</p>}
                      </td>
                      <td className="table-td text-[12px] text-muted-foreground">{ownerLabel(h)}</td>
                      <td className="table-td"><Badge className={statusBadgeClass(h.status)}>{h.status.replace(/_/g, ' ')}</Badge></td>
                      <td className="table-td text-[12px]">{h.contact_email || h.contact_name || <span className="text-warning">needs enrichment</span>}</td>
                      <td className="table-td text-right">
                        <button type="button" title="Open" onClick={() => navigate(`/hackathons/${h.id}`)} className="grid h-7 w-7 place-items-center rounded-full border border-border text-muted-foreground hover:text-foreground"><Eye className="h-3.5 w-3.5" /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {tab === 'colleges' && (
              <table className="w-full border-separate border-spacing-0">
                <thead className="sticky top-0 z-20"><tr>
                  <th className="table-th">College</th><th className="table-th">Location</th><th className="table-th">TPO</th>
                  <th className="table-th">Owner</th><th className="table-th">Readiness</th><th className="table-th">Contacts</th><th className="table-th"><span className="sr-only">Actions</span></th>
                </tr></thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={7} className="p-4"><EmptyState icon={GraduationCap} title="No colleges claimed." description="Claim colleges from the Colleges page." action={<Button variant="outline" size="sm" onClick={() => navigate('/colleges')}>Browse Colleges</Button>} /></td></tr>
                  ) : rows.map((c: College) => (
                    <tr key={c.id} className="border-b border-border last:border-0 hover:bg-accent/50">
                      <td className="table-td"><p className="truncate font-medium">{c.name}</p></td>
                      <td className="table-td text-[12px] text-muted-foreground">{[c.city, c.state].filter(Boolean).join(', ') || '—'}</td>
                      <td className="table-td text-[12px]">{c.tpo_name || c.tpo_email || <span className="text-warning">not found</span>}</td>
                      <td className="table-td text-[12px] text-muted-foreground">{ownerLabel(c)}</td>
                      <td className="table-td"><Badge className={readinessClass(c.outreach_readiness)}>{c.outreach_readiness.replace(/_/g, ' ')}</Badge></td>
                      <td className="table-td text-[12px]">{c.contacts_count ?? 0}</td>
                      <td className="table-td text-right">
                        <button type="button" title="Open" onClick={() => navigate(`/colleges/${c.id}`)} className="grid h-7 w-7 place-items-center rounded-full border border-border text-muted-foreground hover:text-foreground"><Eye className="h-3.5 w-3.5" /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {pagination && <div className="border-t border-border"><Pagination pagination={pagination} onPageChange={(p: number) => setPage(p)} /></div>}
        </div>
      )}
    </div>
  );
};

export default MyLeads;
