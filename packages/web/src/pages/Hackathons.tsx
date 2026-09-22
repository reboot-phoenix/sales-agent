import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { hackathons as hackathonsApi } from '@/lib/api';
import { Hackathon } from '@/lib/types';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoader } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Pagination } from '@/components/ui/pagination';
import { formatDate } from '@/lib/format';
import { SavedViews } from '@/components/SavedViews';
import { BulkActionBar, HeaderCheckbox, RowCheckbox, useBulkSelection } from '@/components/BulkActionBar';
import { Trophy, Download, RefreshCw, Search, Eye, Sparkles, MapPin, Users, UserCheck } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { admin } from '@/lib/api';

export function statusBadgeClass(status: string): string {
  switch (status) {
    case 'REGISTRATION_OPEN': return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
    case 'UPCOMING': return 'bg-sky-500/15 text-sky-400 border-sky-500/30';
    case 'CONFIRMED': return 'bg-emerald-600/15 text-emerald-300 border-emerald-600/30';
    case 'ANNOUNCED': return 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30';
    case 'HISTORICAL': return 'bg-slate-500/15 text-slate-300 border-slate-500/30';
    // Predicted labels are deliberately visually distinct from confirmed ones.
    case 'PREDICTED': return 'bg-amber-500/15 text-amber-300 border-amber-500/40 border-dashed';
    case 'LOW_CONFIDENCE_PREDICTION': return 'bg-amber-900/20 text-amber-500 border-amber-700/40 border-dashed';
    case 'RECURRING_PATTERN': return 'bg-amber-500/10 text-amber-400 border-amber-500/30 border-dashed';
    default: return 'bg-muted text-muted-foreground border-border';
  }
}

const STATUS_OPTIONS = [
  '', 'REGISTRATION_OPEN', 'UPCOMING', 'CONFIRMED', 'ANNOUNCED', 'HISTORICAL',
  'PREDICTED', 'LOW_CONFIDENCE_PREDICTION', 'RECURRING_PATTERN',
];

const Hackathons: React.FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [state, setState] = useState('');
  const [mode, setMode] = useState('');
  const [registration, setRegistration] = useState('');
  const [predictedOnly, setPredictedOnly] = useState(false);
  const [contact, setContact] = useState('');
  const limit = 25;

  const params = useMemo(() => ({
    page, limit,
    q: search || undefined,
    status: status || undefined,
    state: state || undefined,
    mode: mode || undefined,
    registration: registration || undefined,
    predicted: predictedOnly ? true : undefined,
    contact: contact || undefined,
  }), [page, search, status, state, mode, registration, predictedOnly, contact]);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
  queryKey: ['hackathons', params],
  queryFn: () => hackathonsApi.list(params),
  staleTime: 15000, placeholderData: keepPreviousData,
});

  const rows: Hackathon[] = (data as any)?.data || [];
  const pagination = (data as any)?.pagination;
  const selection = useBulkSelection(rows);
  // Selector form (not getState()) so the row re-renders when the role changes.
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  // Team members for the admin assign dialog (same source as the Leads page).
  const { data: membersData } = useQuery({
  queryKey: ['team-members'],
  queryFn: () => admin.teamMembers(),
  retry: false, staleTime: 60000,
});
  const members: Array<{ id: string; email: string; role: string }> = (membersData as any)?.members || [];
  const [assignRow, setAssignRow] = useState<Hackathon | null>(null);
  const [memberSearch, setMemberSearch] = useState('');

  const assignMutation = useMutation({
  mutationFn: ({ id, userId }: { id: string; userId: string | null }) => hackathonsApi.assign(id, userId),
  onSuccess: () => {
  toast({ title: 'Hackathon assigned', variant: 'success' });
  setAssignRow(null);
  queryClient.invalidateQueries({
  queryKey: ['hackathons'],
});
  },
  onError: (e: Error) => toast({ title: 'Assign failed', description: (e as Error).message, variant: 'error' }),
});

  const bulkStatus = useMutation({
  mutationFn: ({ ids, value }: { ids: string[]; value: string }) => hackathonsApi.bulkStatus(ids, 'outreach_status', value),
  onSuccess: () => queryClient.invalidateQueries({
  queryKey: ['hackathons'],
}),
  onError: (e: Error) => toast({ title: 'Bulk status failed', description: e.message, variant: 'error' }),
});

  const claimMutation = useMutation({
  mutationFn: (id: string) => hackathonsApi.claim(id),
  onSuccess: () => {
  toast({ title: 'Hackathon claimed', variant: 'success' });
  queryClient.invalidateQueries({
  queryKey: ['hackathons'],
});
  queryClient.invalidateQueries({
  queryKey: ['my-leads-hackathons'],
});
  },
  onError: (e: Error) => toast({ title: 'Claim failed', description: e.message, variant: 'error' }),
});

  const exportCsv = async () => {
    try {
      const blob = await hackathonsApi.exportCsv(params);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'hackathons.csv';
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: 'Export ready', variant: 'success' });
    } catch (e) {
      toast({ title: 'Export failed', description: (e as Error).message, variant: 'error' });
    }
  };

  if (isLoading) return <PageLoader label="Loading hackathon intelligence..." />;
  if (isError) return <ErrorState title="Error loading hackathons" message={(error as Error).message} onRetry={() => refetch()} />;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Intelligence"
        title="Hackathon Leads"
        description={`Discovered hackathons, recurring series and evidence-backed predictions · ${pagination?.total ?? 0} records`}
        actions={
          <>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search name, organizer, technology…" className="input pl-9" />
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} loading={isFetching}><RefreshCw className="h-4 w-4" /></Button>
            <Button variant="outline" size="sm" onClick={exportCsv}><Download className="h-4 w-4" />CSV</Button>
          </>
        }
      />

      <div className="card flex flex-wrap items-center gap-2 p-3">
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="input w-48" aria-label="Status">
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s ? s.replace(/_/g, ' ') : 'All statuses'}</option>)}
        </select>
        <input value={state} onChange={(e) => { setState(e.target.value); setPage(1); }} placeholder="State" className="input w-36" />
        <select value={mode} onChange={(e) => { setMode(e.target.value); setPage(1); }} className="input w-36" aria-label="Mode">
          <option value="">Any mode</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="hybrid">Hybrid</option>
        </select>
        <select value={registration} onChange={(e) => { setRegistration(e.target.value); setPage(1); }} className="input w-44" aria-label="Registration">
          <option value="">Any registration</option>
          <option value="open">Registration open</option>
          <option value="closing_soon">Closing in 14 days</option>
          <option value="closed">Registration closed</option>
          <option value="upcoming">Upcoming event</option>
        </select>
        <select value={contact} onChange={(e) => { setContact(e.target.value); setPage(1); }} className="input w-44" aria-label="Contact">
          <option value="">Any contact</option>
          <option value="none">No contact</option>
          <option value="enriched">Has contact</option>
          <option value="verified">Verified contact</option>
        </select>
        <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <input type="checkbox" checked={predictedOnly} onChange={(e) => { setPredictedOnly(e.target.checked); setPage(1); }} />
          Predictions only
        </label>
      </div>

      <SavedViews
        domain="hackathons"
        currentFilters={{
          q: search, status, state, mode, registration, contact,
          predicted: predictedOnly ? 'true' : '',
        }}
        onApply={(saved) => {
          // A saved view replays the exact filters it stored; anything it does not
          // mention is reset rather than left over from the previous session.
          const pick = (key: string) => (saved[key] === undefined || saved[key] === null ? '' : String(saved[key]));
          setSearch(pick('q'));
          setStatus(pick('status'));
          setState(pick('state'));
          setMode(pick('mode'));
          setRegistration(pick('registration'));
          setContact(pick('contact'));
          setPredictedOnly(pick('predicted') === 'true');
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
                <th className="table-th">Hackathon</th>
                <th className="table-th">Organizer</th>
                <th className="table-th">When</th>
                <th className="table-th">Location</th>
                <th className="table-th">Prize</th>
                <th className="table-th">Status</th>
                <th className="table-th">Contact</th>
                <th className="table-th">Owner</th>
                <th className="table-th"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={10} className="p-4">
                  <EmptyState
                    icon={Trophy}
                    title="No hackathons match these filters."
                    description="Run the Hackathon Army from the Armies page, or widen the filters."
                  />
                </td></tr>
              ) : rows.map((h) => (
                <tr key={h.id} className="border-b border-border last:border-0 hover:bg-accent/50">
                  <td className="table-td">
                    <RowCheckbox
                      checked={selection.idSet.has(h.id)}
                      onChange={() => selection.toggle(h.id)}
                      label={h.name}
                    />
                  </td>
                  <td className="table-td max-w-[280px]">
                    <p className="truncate font-medium">{h.name}</p>
                    {h.technology && <p className="truncate text-xs text-muted-foreground">{h.technology}</p>}
                    {h.occurrence_type === 'recurring' && (
                      <span className="text-[11px] text-amber-400">recurring series</span>
                    )}
                  </td>
                  <td className="table-td">{h.organizer_name || <span className="text-muted-foreground">—</span>}</td>
                  <td className="table-td text-[13px] text-muted-foreground">
                    {h.registration_deadline && <p>Reg: {formatDate(h.registration_deadline)}</p>}
                    {h.event_start && <p>Event: {formatDate(h.event_start)}</p>}
                  </td>
                  <td className="table-td text-[13px] text-muted-foreground">
                    {h.city || h.state ? <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{[h.city, h.state].filter(Boolean).join(', ')}</span> : h.mode || '—'}
                  </td>
                  <td className="table-td text-[13px]">{h.prize_pool ? `₹${Number(h.prize_pool).toLocaleString('en-IN')}` : '—'}</td>
                  <td className="table-td">
                    <Badge className={statusBadgeClass(h.status)}>{h.status.replace(/_/g, ' ')}</Badge>
                    {h.prediction_confidence != null && h.status.startsWith('PREDICTED') && (
                      <p className="mt-1 text-[11px] text-amber-400">{h.prediction_confidence}% confidence</p>
                    )}
                    {h.status === 'LOW_CONFIDENCE_PREDICTION' && h.prediction_confidence != null && (
                      <p className="mt-1 text-[11px] text-amber-500">{h.prediction_confidence}% confidence</p>
                    )}
                  </td>
                  <td className="table-td">
                    {h.contact_email || h.contact_phone || h.contact_linkedin ? (
                      <div className="text-[12px]">
                        <p className="truncate font-medium">{h.contact_name || 'Contact on file'}</p>
                        {h.contact_email && <p className="truncate text-muted-foreground">{h.contact_email}</p>}
                      </div>
                    ) : (
                      <span className="text-[12px] text-warning">needs enrichment</span>
                    )}
                  </td>
                  <td className="table-td">
                    {(() => {
                      const claimed = (h as any).claimed_by_email || h.claimed_by;
                      const assigned = (h as any).assigned_to_email || h.assigned_to;
                      if (claimed && assigned && claimed !== assigned)
                        return <span className="block max-w-[190px] truncate text-[12px] text-muted-foreground" title={`Claimed by ${claimed}, assigned to ${assigned}`}>Claimed by {String(claimed).split('@')[0]} · → {String(assigned).split('@')[0]}</span>;
                      if (assigned)
                        return <span className="block max-w-[170px] truncate text-[12px] text-muted-foreground" title={String(assigned)}>Assigned to {String(assigned).split('@')[0]}</span>;
                      if (claimed)
                        return <span className="block max-w-[170px] truncate text-[12px] text-muted-foreground" title={String(claimed)}>Claimed by {String(claimed).split('@')[0]}</span>;
                      return <span className="text-[12px] text-muted-foreground/60">Unclaimed</span>;
                    })()}
                  </td>
                  <td className="table-td">
                    <div className="flex items-center justify-end gap-1.5">
                      <button type="button" title="Open" onClick={() => navigate(`/hackathons/${h.id}`)} className="grid h-7 w-7 place-items-center rounded-full border border-border text-muted-foreground hover:text-foreground"><Eye className="h-3.5 w-3.5" /></button>
                      {!h.claimed_by && !h.assigned_to && (
                        <Button variant="secondary" size="sm" disabled={claimMutation.isPending} onClick={() => claimMutation.mutate(h.id)}>
                          <Sparkles className="h-3.5 w-3.5" />Claim
                        </Button>
                      )}
                      {isAdmin && (
                        <button
                          type="button"
                          title="Assign this hackathon to a team member"
                          aria-label={`Assign ${h.name}`}
                          onClick={() => setAssignRow(h)}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 py-[7px] text-[12px] font-semibold text-foreground shadow-sm transition-all hover:border-primary/50 hover:bg-primary-soft hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <UserCheck className="h-3.5 w-3.5" />
                          Assign
                        </button>
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
              claim: (ids) => hackathonsApi.bulkClaim(ids),
              assign: (ids, email) => hackathonsApi.bulkAssign(ids, email),
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

      <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Users className="h-3.5 w-3.5" />
        Predicted rows are labelled and visually distinct from confirmed events; a prediction always carries its evidence on the record page.
      </p>

      {assignRow && (
        <div className="fixed inset-0 z-overlay grid place-items-center bg-black/50 p-4" onClick={() => setAssignRow(null)}>
          <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-4 shadow-float" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Assign hackathon">
            <p className="mb-1 text-sm font-semibold">Assign to</p>
            <p className="mb-3 truncate text-xs text-muted-foreground">{assignRow.name || 'hackathon'}</p>
            <input value={memberSearch} onChange={(e) => setMemberSearch(e.target.value)} placeholder="Search member…" className="input mb-2" aria-label="Search member" />
            <div className="max-h-64 space-y-1 overflow-auto">
              {members.filter((m) => m.email.toLowerCase().includes(memberSearch.toLowerCase())).map((m) => (
                <button key={m.id} onClick={() => assignMutation.mutate({ id: assignRow.id, userId: m.id })} className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-accent">
                  <span className="min-w-0 flex-1 truncate">{m.email}</span>
                  <span className="text-xs capitalize text-muted-foreground">{m.role}</span>
                </button>
              ))}
              {members.length === 0 && <p className="text-xs text-muted-foreground">No members found.</p>}
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setAssignRow(null)}>Cancel</Button>
              <Button size="sm" loading={assignMutation.isPending} onClick={() => assignMutation.mutate({ id: assignRow.id, userId: null })}>Unassign</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Hackathons;
