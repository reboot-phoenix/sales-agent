import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { armies as armiesApi } from '@/lib/api';
import { ArmyRun, ArmySource } from '@/lib/types';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoader } from '@/components/ui/spinner';
import { ErrorState } from '@/components/ui/error-state';
import { formatDate } from '@/lib/format';
import { Briefcase, Trophy, GraduationCap, Play, RefreshCw } from 'lucide-react';

const DOMAIN_LABEL: Record<string, string> = {
  jobs: 'Job Army',
  hackathons: 'Hackathon Army',
  colleges: 'College Army',
};

function runStatusClass(status: string): string {
  switch (status) {
    case 'completed': return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
    case 'running': return 'bg-sky-500/15 text-sky-300 border-sky-500/30';
    case 'partial': return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    case 'failed': return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
    default: return 'bg-muted text-muted-foreground border-border';
  }
}

function healthClass(health: string): string {
  switch (health) {
    case 'healthy': return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
    case 'SOURCE_TEMPORARILY_UNAVAILABLE': return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
    case 'degraded': return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    default: return 'bg-muted text-muted-foreground border-border';
  }
}

const Armies: React.FC = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selected, setSelected] = useState<string | null>(null);

  const runs = useQuery('army-runs', () => armiesApi.runs({ limit: 40 }), {
    // Poll while anything is running so progress is live without freezing the page.
    refetchInterval: (data: any) =>
      (data?.runs || []).some((r: ArmyRun) => r.status === 'running' || r.status === 'queued') ? 5000 : 30000,
    staleTime: 3000,
  });
  const sources = useQuery('army-sources', () => armiesApi.sources(), { staleTime: 60000 });
  const detail = useQuery(['army-run', selected], () => armiesApi.runDetail(selected as string), {
    enabled: !!selected,
    refetchInterval: 5000,
  });

  const start = useMutation((domain: 'jobs' | 'hackathons' | 'colleges') => armiesApi.run(domain), {
    onSuccess: (data) => {
      toast({ title: `${DOMAIN_LABEL[data.domain] || data.domain} queued`, description: `Run ${data.run_id}`, variant: 'success' });
      queryClient.invalidateQueries('army-runs');
    },
    onError: (e: Error) => toast({ title: 'Could not start army', description: e.message, variant: 'error' }),
  });

  const runAll = useMutation(() => armiesApi.runAll(), {
    onSuccess: () => {
      toast({ title: 'All three armies queued', description: 'They run concurrently as independent workers.', variant: 'success' });
      queryClient.invalidateQueries('army-runs');
    },
    onError: (e: Error) => toast({ title: 'Could not start armies', description: e.message, variant: 'error' }),
  });

  if (runs.isLoading) return <PageLoader label="Loading army operations..." />;
  if (runs.isError) return <ErrorState title="Error loading runs" message={(runs.error as Error).message} onRetry={() => runs.refetch()} />;

  const runRows: ArmyRun[] = runs.data?.runs || [];
  const sourceRows: ArmySource[] = sources.data?.sources || [];

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Operations"
        title="Scraper Armies"
        description="Three independent armies — jobs, hackathons, colleges. Each run returns immediately and streams progress; one failing source never stops a run."
        actions={<Button variant="outline" size="sm" onClick={() => runs.refetch()} loading={runs.isFetching}><RefreshCw className="h-4 w-4" /></Button>}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card p-4">
          <div className="mb-2 flex items-center gap-2"><Briefcase className="h-4 w-4" /><h2 className="text-sm font-semibold">Job Army</h2></div>
          <p className="mb-3 text-[12px] text-muted-foreground">Existing India-fresher job fleet + enrichment cascade.</p>
          <Button size="sm" onClick={() => start.mutate('jobs')} loading={start.isLoading}><Play className="h-3.5 w-3.5" />Run Job Army</Button>
        </div>
        <div className="card p-4">
          <div className="mb-2 flex items-center gap-2"><Trophy className="h-4 w-4" /><h2 className="text-sm font-semibold">Hackathon Army</h2></div>
          <p className="mb-3 text-[12px] text-muted-foreground">Discover events, store history, enrich organizers, predict recurrence.</p>
          <Button size="sm" onClick={() => start.mutate('hackathons')} loading={start.isLoading}><Play className="h-3.5 w-3.5" />Run Hackathon Army</Button>
        </div>
        <div className="card p-4">
          <div className="mb-2 flex items-center gap-2"><GraduationCap className="h-4 w-4" /><h2 className="text-sm font-semibold">College Army</h2></div>
          <p className="mb-3 text-[12px] text-muted-foreground">State-wise discovery + TPO / principal contact enrichment.</p>
          <Button size="sm" onClick={() => start.mutate('colleges')} loading={start.isLoading}><Play className="h-3.5 w-3.5" />Run College Army</Button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={() => runAll.mutate()} loading={runAll.isLoading}><Play className="h-4 w-4" />Run all three concurrently</Button>
        <span className="text-[12px] text-muted-foreground">Also runs automatically each day at 02:00 local time.</span>
      </div>

      <div className="card overflow-hidden">
        <div className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold">Recent runs</h2></div>
        <div className="max-h-[45vh] overflow-auto">
          <table className="w-full border-separate border-spacing-0">
            <thead className="sticky top-0 z-20">
              <tr>
                <th className="table-th">Army</th><th className="table-th">Status</th><th className="table-th">Started</th>
                <th className="table-th">Sources</th><th className="table-th">Discovered</th><th className="table-th">Inserted</th>
                <th className="table-th">Contacts</th><th className="table-th">Predictions</th><th className="table-th">Errors</th>
              </tr>
            </thead>
            <tbody>
              {runRows.map((r) => (
                <tr key={r.id} onClick={() => setSelected(r.id)} className="cursor-pointer border-b border-border last:border-0 hover:bg-accent/50">
                  <td className="table-td">{DOMAIN_LABEL[r.domain] || r.domain}</td>
                  <td className="table-td"><Badge className={runStatusClass(r.status)}>{r.status}</Badge></td>
                  <td className="table-td text-[12px] text-muted-foreground">{formatDate(r.started_at)}</td>
                  <td className="table-td text-[12px]">{r.sources_succeeded}/{r.sources_attempted}</td>
                  <td className="table-td text-[12px]">{r.records_discovered}</td>
                  <td className="table-td text-[12px]">{r.records_inserted}/{r.records_updated}</td>
                  <td className="table-td text-[12px]">{r.contacts_discovered}</td>
                  <td className="table-td text-[12px]">{r.predictions_generated}</td>
                  <td className="table-td text-[12px]">{r.errors_count}</td>
                </tr>
              ))}
              {runRows.length === 0 && (
                <tr><td colSpan={9} className="p-4 text-[13px] text-muted-foreground">No army runs yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && detail.data && (
        <div className="card p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Run {selected.slice(0, 8)} · {detail.data.run.domain}</h2>
            <Button variant="outline" size="sm" onClick={() => setSelected(null)}>Close</Button>
          </div>
          <p className="mb-2 text-[12px] text-muted-foreground">
            pending raw records: {detail.data.pending_raw} · status {detail.data.run.status}
          </p>
          {detail.data.run.worker_status?.length > 0 && (
            <div className="mb-3">
              <p className="mb-1 text-[12px] font-medium">Per-source workers</p>
              <ul className="space-y-1">
                {detail.data.run.worker_status.map((w: any, i: number) => (
                  <li key={i} className="text-[12px] text-muted-foreground">
                    {w.source}: discovered {w.discovered}, new raw {w.stored}
                    {w.unavailable ? ' · SOURCE_TEMPORARILY_UNAVAILABLE' : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {detail.data.errors?.length > 0 && (
            <div>
              <p className="mb-1 text-[12px] font-medium">Errors</p>
              <ul className="space-y-1">
                {detail.data.errors.map((e, i) => (
                  <li key={i} className="text-[12px] text-rose-300">{e.source}: {e.error}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold">Source health</h2></div>
        <div className="max-h-[45vh] overflow-auto">
          <table className="w-full border-separate border-spacing-0">
            <thead className="sticky top-0 z-20">
              <tr><th className="table-th">Domain</th><th className="table-th">Source</th><th className="table-th">Tier</th>
                <th className="table-th">Health</th><th className="table-th">Last success</th><th className="table-th">Failures</th><th className="table-th">Last error</th></tr>
            </thead>
            <tbody>
              {sourceRows.map((s) => (
                <tr key={s.id} className="border-b border-border last:border-0">
                  <td className="table-td text-[12px]">{s.domain}</td>
                  <td className="table-td text-[12px] font-medium">{s.name}</td>
                  <td className="table-td text-[12px]">T{s.tier}</td>
                  <td className="table-td"><Badge className={healthClass(s.health_status)}>{s.health_status.replace(/_/g, ' ')}</Badge></td>
                  <td className="table-td text-[12px] text-muted-foreground">{s.last_success_at ? formatDate(s.last_success_at) : 'never'}</td>
                  <td className="table-td text-[12px]">{s.consecutive_failures}</td>
                  <td className="table-td max-w-[280px] truncate text-[12px] text-muted-foreground">{s.last_error || '—'}</td>
                </tr>
              ))}
              {sourceRows.length === 0 && (
                <tr><td colSpan={7} className="p-4 text-[13px] text-muted-foreground">
                  No sources registered yet — run an army to register its adapters.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default Armies;
