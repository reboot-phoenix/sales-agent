import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { dashboard, admin, CreditUsageResponse, RunLog } from '@/lib/api';
import { useSSE, isLeadLifecycleEvent } from '@/hooks/useSSE';
import { useAuthStore } from '@/stores/auth';
import {
  Users, Flame, Sun, Snowflake, ShieldAlert, Zap, Activity, BarChart3,
  CheckCircle2, Clock, AlertTriangle, Sparkles, MailCheck, Radar, Radio,
  Pause, Play, Square,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { StatCard, StatCardGrid } from '@/components/ui/stat-card';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageLoader } from '@/components/ui/spinner';
import { ErrorState } from '@/components/ui/error-state';
import { EmptyState } from '@/components/ui/empty-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';

const STAGE_LABELS: Record<string, string> = {
  discovered: 'Discovered', enriching: 'Enriching', enriched: 'Enriched',
  verifying: 'Verifying', verified: 'Verified', ready_for_outreach: 'Ready',
  message_generated: 'Messaged', drafted: 'Drafted', send_pending: 'Sending',
  contacted: 'Contacted', sent: 'Sent', delivered: 'Delivered', replied: 'Replied',
  converted: 'Converted', bounced: 'Bounced', contact_unavailable: 'No contact',
  suppressed: 'Suppressed', send_failed: 'Send failed', provider_error: 'Provider error',
  retry_pending: 'Retrying', enrichment_failed: 'Enrich failed', verification_failed: 'Verify failed',
};
// Premium paper palette: pine progress, amber attention, red failure,
// blue delivery, slate neutral. Solids only for categorical data — soft
// gradients live only inside area fills (see charts/TrendArea).
const STAGE_COLORS: Record<string, string> = {
  discovered: '#64748B', enriching: '#8FA3A0', enriched: '#2F7D6B',
  verifying: '#0E9594', verified: '#1F8A4C', ready_for_outreach: '#4D7C0F',
  message_generated: '#65A30D', drafted: '#B45309', send_pending: '#C2410C',
  contacted: '#9D174D', sent: '#BE185D', delivered: '#0284C7', replied: '#1D4ED8',
  converted: '#15803D', bounced: '#DC2626', contact_unavailable: '#94A3B8',
  suppressed: '#64748B', send_failed: '#B91C1C', provider_error: '#EA580C',
  retry_pending: '#CA8A04', enrichment_failed: '#DC2626', verification_failed: '#DC2626',
};

// One glass tooltip reused by every chart (shared kit).
import { Donut } from '@/components/charts/Donut';
import { TrendArea } from '@/components/charts/TrendArea';
import { HBars } from '@/components/charts/HBars';
import { PINE, CATEGORICAL, TRACK, resultColor } from '@/components/charts/theme';

type FeedItem = { key: number; type: string; lead_id?: string; at: number };

const EVENT_LABELS: Record<string, string> = {
  enrichment_queued: 'Enrichment queued', enrichment_complete: 'Enrichment finished',
  verification_queued: 'Verification queued', verification_complete: 'Verification finished',
  draft_queued: 'Draft queued', draft_generated: 'Draft generated',
  send_queued: 'Send queued', send_complete: 'Message sent', send_blocked: 'Send blocked',
  verify_send_queued: 'Verify+send queued', verify_and_send_queued: 'Verify+send queued',
  verify_send_complete: 'Verify+send finished', lead_updated: 'Lead updated',
  lead_claimed: 'Lead claimed', lead_assigned: 'Lead assigned',
  leads_claimed: 'Leads claimed', leads_assigned: 'Leads assigned',
  leads_imported: 'Leads imported',
};

const Dashboard: React.FC = () => {
  const [live, setLive] = React.useState(true);
  const [feed, setFeed] = React.useState<FeedItem[]>([]);
  const feedKey = React.useRef(0);
  const { data, isLoading, error, refetch } = useQuery({
  queryKey: ['dashboard-stats'],
  queryFn: () => dashboard.stats(),
  refetchInterval: live ? 15000 : false,
});
  const { data: creditData } = useQuery({
  queryKey: ['dashboard-credits'],
  queryFn: () => dashboard.credits(),
  refetchInterval: live ? 15000 : false,
});
  const { data: armyStatus } = useQuery({
  queryKey: ['army-status'],
  queryFn: () => admin.armyStatus(),
  refetchInterval: live ? 4000 : false,
});
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: runsData } = useQuery({
  queryKey: ['dashboard-runs'],
  queryFn: () => admin.getRuns(8),
  refetchInterval: live ? 15000 : false, enabled: isAdmin,
});

  const armyMutation = useMutation({
  mutationFn: () => admin.runArmy(),
  onSuccess: (d: any) => {
  queryClient.invalidateQueries({
  queryKey: ['army-status'],
});
  queryClient.invalidateQueries({
  queryKey: ['dashboard-stats'],
});
  queryClient.invalidateQueries({
  queryKey: ['dashboard-runs'],
});
  setArmyConfirmOpen(false);
  toast({ title: 'Army deployed', description: 'Watch the Army Queues and live feed below for real-time progress.', variant: 'success' });
  },
  onError: (e) => toast({ title: 'Could not start army', description: (e as Error).message, variant: 'error' }),
});
  const [armyConfirmOpen, setArmyConfirmOpen] = React.useState(false);
  const [armyStopConfirmOpen, setArmyStopConfirmOpen] = React.useState(false);
  const stopMutation = useMutation({
  mutationFn: () => admin.stopArmy(),
  onSuccess: (d: any) => {
  queryClient.invalidateQueries({
  queryKey: ['army-status'],
});
  queryClient.invalidateQueries({
  queryKey: ['dashboard-stats'],
});
  queryClient.invalidateQueries({
  queryKey: ['dashboard-runs'],
});
  setArmyStopConfirmOpen(false);
  toast({
  title: d?.stopped === false ? 'Nothing to stop' : 'Army stopping',
  description: d?.stopped === false
  ? (d?.reason || 'No scrape activity is running.')
  : `In-flight sources cancelling now;${d?.cleared_queued_jobs ? ` ${d.cleared_queued_jobs} queued jobs discarded;` : ''} discovered leads keep flowing through enrich → verify → draft.`,
  variant: d?.stopped === false ? 'warning' : 'success',
  });
  },
  onError: (e) => toast({ title: 'Could not stop army', description: (e as Error).message, variant: 'error' }),
});
  // Command palette "Run Full Army" routes here for confirmation instead of
  // firing blind — the palette has no dialog of its own.
  React.useEffect(() => {
    const open = () => setArmyConfirmOpen(true);
    window.addEventListener('hiregen:confirm-army', open);
    return () => window.removeEventListener('hiregen:confirm-army', open);
  }, []);

  useSSE('/sse/token', (event) => {
    if (!live) return;
    if (isLeadLifecycleEvent(event.type) || EVENT_LABELS[event.type]) {
      refetch();
      queryClient.invalidateQueries({
  queryKey: ['dashboard-credits'],
});
      queryClient.invalidateQueries({
  queryKey: ['army-status'],
});
      feedKey.current += 1;
      const item = { key: feedKey.current, type: event.type, lead_id: event.lead_id as string | undefined, at: Date.now() };
      setFeed((f) => [item, ...f].slice(0, 20));
    }
  });

  if (isLoading) return <PageLoader label="Loading dashboard…" />;
  if (error) return <ErrorState title="Error loading dashboard" message={(error as Error).message} onRetry={() => refetch()} />;

  const totals = data?.totals || { total_leads: 0, hot: 0, warm: 0, cold: 0, do_not_contact: 0 };
  const credits: CreditUsageResponse | undefined = creditData as CreditUsageResponse | undefined;
  const runs: RunLog[] = (runsData as any)?.runs || (runsData as any) || [];
  const creditPercent = credits ? Math.min((credits.used / credits.limit) * 100, 100) : 0;
  const creditTone = creditPercent > 80 ? 'bg-destructive' : creditPercent > 50 ? 'bg-warning' : 'bg-success';

  const funnel = (data?.funnel || {}) as Record<string, number>;
  const funnelData = Object.entries(funnel).map(([stage, count]) => ({ stage: STAGE_LABELS[stage] || stage, full: stage, count: count as number }));
  const maxCount = Math.max(...funnelData.map((d) => d.count), 1);
  const totalLeads = Object.values(funnel).reduce((a, b) => a + (b as number), 0);

  const bandData = [
    { name: 'Hot', value: totals.hot, color: STAGE_COLORS.contacted },
    { name: 'Warm', value: totals.warm, color: STAGE_COLORS.drafted },
    { name: 'Cold', value: totals.cold, color: STAGE_COLORS.enriched },
  ].filter((d) => d.value > 0);

  // Live enrichment coverage = verified+drafted / total (how complete contacts are).
  const enrichedCount = (funnel.enriched || 0) + (funnel.verified || 0) + (funnel.drafted || 0) + (funnel.contacted || 0);
  // Leads the army processed and found NO usable contact are a real outcome, not an
  // untried row. Counting only successes made coverage read 0% while 416 of 418 leads
  // had in fact been enriched and correctly came back empty -- which pushed reps to
  // re-run enrichment on records that will never yield a contact.
  const noContactCount = funnel.contact_unavailable || 0;
  const attemptedCount = enrichedCount + noContactCount;
  const coverage = totalLeads ? Math.round((attemptedCount / totalLeads) * 100) : 0;

  const q = armyStatus || { raw: 0, enrichment: 0, verification: 0, draft: 0 };
  const queued = (q.raw || 0) + (q.enrichment || 0) + (q.verification || 0) + (q.draft || 0);
  const armyLive = queued > 0;

  const new24h = totals.new_24h || 0;
  const trend = ((data as any)?.trend_14d || []) as Array<{ day: string; discovered: string }>;
  const trendData = trend.map((d) => ({
    day: d.day.slice(5).replace('-', '/'),
    discovered: Number(d.discovered),
  }));
  const verif7d = ((data as any)?.verification_7d || []) as Array<{ channel: string; result: string; count: string }>;
  const verifData = verif7d.map((d) => ({
    name: `${d.channel} · ${d.result}`,
    value: Number(d.count),
  }));
  const outreach7d = ((data as any)?.outreach_7d || []) as Array<{ channel: string; delivery_status: string; count: string }>;
  const outreachData = outreach7d.map((d) => ({
    name: `${d.channel} · ${d.delivery_status}`,
    value: Number(d.count),
  }));

  return (
    <div className="space-y-phi4">
      {/* ---- hero ---- */}
      <div className="card relative overflow-hidden p-6 sm:p-7">
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="eyebrow mb-2">Live intelligence</p>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Lead Intelligence Command
            </h1>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Autonomous India fresher discovery · HR contact enrichment · outreach drafts.
            </p>
          </div>
          <div className="flex flex-col items-stretch gap-3 sm:items-end">
            <div className="flex gap-2">
              <Button
                variant="outline" size="lg" onClick={() => setLive((v) => !v)}
                title={live ? 'Pause live updates' : 'Resume live updates'}
              >
                {live ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
                {live ? 'Live' : 'Paused'}
              </Button>
              {isAdmin && (
                armyLive ? (
                  <Button size="lg" variant="destructive" onClick={() => setArmyStopConfirmOpen(true)} loading={stopMutation.isPending} disabled={stopMutation.isPending}>
                    <Square className="h-5 w-5" />
                    {stopMutation.isPending ? 'Stopping…' : `Stop Army · ${queued}`}
                  </Button>
                ) : (
                  <Button size="lg" onClick={() => setArmyConfirmOpen(true)} loading={armyMutation.isPending} disabled={armyMutation.isPending}>
                    <Zap className="h-5 w-5" />
                    {armyMutation.isPending ? 'Deploying…' : 'Run Full Army'}
                  </Button>
                )
              )}
            </div>
            <ConfirmDialog
              open={armyStopConfirmOpen}
              onClose={() => setArmyStopConfirmOpen(false)}
              onConfirm={() => stopMutation.mutate()}
              title="Stop the running army?"
              description={`In-flight source scrapes cancel within seconds — already-scraped leads are kept, never discarded. Queued scrape jobs are discarded. ${queued} lead${queued === 1 ? '' : 's'} already in enrich → verify → draft keep processing to completion.`}
              confirmLabel="Stop Army"
              confirmVariant="destructive"
              loading={stopMutation.isPending}
            />
            <ConfirmDialog
              open={armyConfirmOpen}
              onClose={() => setArmyConfirmOpen(false)}
              onConfirm={() => armyMutation.mutate()}
              title="Run Data Collection Army?"
              description={`Runs all configured sources, then re-enriches leads missing contacts. ${queued} lead${queued === 1 ? '' : 's'} currently in flight. Paid providers consume credits where keys exist. Track the live run in Army Queues below.`}
              confirmLabel="Run Army"
              confirmVariant="default"
              loading={armyMutation.isPending}
            />
            <div className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium backdrop-blur transition-colors ${armyLive ? 'border-success/40 bg-success-soft text-success' : 'border-border bg-surface/50 text-muted-foreground'}`}>
              <Radio className={`h-3.5 w-3.5 ${armyLive ? 'animate-pulse' : ''}`} />
              {armyLive ? `Army running · ${queued} leads in flight` : 'Idle — ready to deploy'}
            </div>
          </div>
        </div>
      </div>

      {/* ---- live activity ---- */}
      <div className="card flex items-center gap-3 overflow-hidden px-4 py-3">
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${live ? 'border-success/40 bg-success-soft text-success' : 'border-border text-muted-foreground'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${live ? 'animate-pulse bg-success' : 'bg-muted-foreground'}`} />
          {live ? 'Live' : 'Paused'}
        </span>
        {feed.length === 0 ? (
          <p className="truncate text-[13px] text-muted-foreground">
            {live ? 'Listening for pipeline events — enrich, verify or draft a lead and watch it land here.' : 'Live updates paused — resume to stream pipeline events.'}
          </p>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
            {feed.slice(0, 6).map((item) => (
              <motion.span
                key={item.key}
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-[12px] text-foreground"
                title={item.lead_id ? `Lead ${item.lead_id}` : item.type}
              >
                <Zap className="h-3 w-3 text-primary" />
                {EVENT_LABELS[item.type] || item.type}
              </motion.span>
            ))}
          </div>
        )}
      </div>

      {/* ---- stats ---- */}
      <StatCardGrid>
        <StatCard icon={Users} label="Total Leads" value={totals.total_leads} tone="primary" suffix={new24h > 0 ? `+${new24h} today` : undefined} />
        <StatCard icon={Flame} label="Hot Leads" value={totals.hot} tone="danger" />
        <StatCard icon={Sun} label="Warm Leads" value={totals.warm} tone="warning" />
        <StatCard icon={Snowflake} label="Cold Leads" value={totals.cold} tone="info" />
        <StatCard icon={ShieldAlert} label="Do Not Contact" value={totals.do_not_contact || 0} tone="muted" />
      </StatCardGrid>

      {/* ---- discovery trend ---- */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Activity className="h-5 w-5 text-primary" />Discovery Trend · 14 days</CardTitle></CardHeader>
        <CardContent>
          {trendData.length === 0 ? (
            <EmptyState icon={BarChart3} title="No discovery data yet" description="New leads per day will chart here once the army runs." />
          ) : (
            <TrendArea data={trendData} xKey="day" yKey="discovered" yName="Discovered" id="discovery" />
          )}
        </CardContent>
      </Card>

      {/* ---- live pipeline ---- */}
      <div className="grid grid-cols-1 gap-phi3 xl:grid-cols-3">
        <Card className="flex h-full flex-col xl:col-span-2">
          <CardHeader><CardTitle className="flex items-center gap-2"><Activity className="h-5 w-5 text-primary" />Pipeline Funnel <span className="ml-auto text-xs font-normal text-muted-foreground">Click a bar to open those leads</span></CardTitle></CardHeader>
          <CardContent className="flex flex-1 flex-col space-y-2">
            {funnelData.length === 0 ? (
              <EmptyState icon={BarChart3} title="No pipeline data yet" description="Deploy the army to start discovering India fresher leads." />
            ) : (
              <>
                <HBars
                  data={funnelData.map((d) => ({ key: d.full, label: d.stage, value: d.count, color: STAGE_COLORS[d.full] || PINE }))}
                  grow
                  onSelect={(row) => navigate(`/leads?pipeline_stage=${encodeURIComponent(row.key)}`)}
                />
                <p className="text-[11px] text-muted-foreground">Click a bar to open those leads · max {maxCount.toLocaleString()}</p>
              </>
            )}
          </CardContent>
        </Card>

        {/* coverage + bands + live queue */}
        <div className="flex flex-col gap-phi3">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><MailCheck className="h-5 w-5 text-success" />Army Processing Rate</CardTitle></CardHeader>
            <CardContent>
              <Donut
                data={[
                  { name: 'Attempted', value: attemptedCount, color: PINE },
                  { name: 'Unattempted', value: Math.max(totalLeads - attemptedCount, 0), color: TRACK },
                ]}
                centerTop={`${coverage}%`}
                centerBottom="coverage"
                size={112}
                layout="column"
              />
              <div className="mt-3 text-[13px] text-muted-foreground">
                <p className="font-medium text-foreground">{attemptedCount} of {totalLeads} attempted</p>
                <p>{enrichedCount} with a usable contact · {noContactCount} reached no contact</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Radar className={`h-5 w-5 ${armyLive ? 'animate-pulse text-success' : 'text-primary'}`} />Army Queues</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              {[
                { k: 'Scrape→Normalize', v: q.raw, icon: Sparkles },
                { k: 'Enrichment', v: q.enrichment, icon: Zap },
                { k: 'Verification', v: q.verification, icon: Activity },
                { k: 'Drafting', v: q.draft, icon: MailCheck },
              ].map((row) => (
                <div key={row.k} className={`rounded-xl border p-3 transition-colors ${row.v > 0 ? 'border-primary/40 bg-primary/10' : 'border-border bg-muted/40'}`}>
                  <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground"><row.icon className="h-3.5 w-3.5" />{row.k}</div>
                  <p className={`text-xl font-semibold tabular-nums ${row.v > 0 ? 'text-ink-strong' : 'text-foreground'}`}>{row.v < 0 ? '—' : row.v}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ---- bands + source health + credits ---- */}
      <div className="grid grid-cols-1 gap-phi3 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Flame className="h-5 w-5 text-hot" />Lead Quality</CardTitle></CardHeader>          <CardContent>
            {bandData.length === 0 ? <EmptyState icon={BarChart3} title="No leads scored yet" description="Scores appear once leads are enriched." /> : (
              <Donut
                data={bandData}
                centerTop={totalLeads.toLocaleString()}
                centerBottom="leads scored"
                size={128}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Activity className="h-5 w-5 text-info" />Source Health</CardTitle></CardHeader>
          <CardContent>
            {data?.source_health && data.source_health.length > 0 ? (
              <div className="max-h-40 space-y-2 overflow-y-auto">
                {data.source_health.map((s: any) => (
                  <div key={s.source_name} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
                    <span className="truncate text-sm font-medium capitalize">{s.source_name}</span>
                    <Badge variant={s.is_open ? 'danger' : 'success'}>{s.is_open ? `${s.consecutive_failures} fails` : 'Healthy'}</Badge>
                  </div>
                ))}
              </div>
            ) : <EmptyState icon={Activity} title="No source data" description="Health appears once scrapers run." />}
          </CardContent>
        </Card>

        {credits && (
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Zap className="h-5 w-5 text-warning" />Credit Usage</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-baseline justify-between"><span className="text-sm text-muted-foreground"><span className="font-semibold text-foreground">{credits.used.toLocaleString()}</span> / {credits.limit.toLocaleString()}</span><span className="text-sm font-medium tabular-nums">{creditPercent.toFixed(1)}%</span></div>
              <div className="h-3 overflow-hidden rounded-full bg-muted"><motion.div className={`h-3 rounded-full ${creditTone}`} initial={{ width: 0 }} animate={{ width: `${creditPercent}%` }} transition={{ duration: 0.8 }} /></div>
              <p className="text-xs text-muted-foreground">{credits.remaining.toLocaleString()} credits remaining</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* ---- verification + outreach outcomes (7d, live) ---- */}
      <div className="grid grid-cols-1 gap-phi3 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-success" />Verification Outcomes · 7d</CardTitle></CardHeader>
          <CardContent>
            {verifData.length === 0 ? (
              <EmptyState icon={CheckCircle2} title="No verifications yet" description="Email/WhatsApp results will break down here." />
            ) : (
              <Donut
                data={verifData.map((d, i) => ({ ...d, color: resultColor(d.name, CATEGORICAL[i % CATEGORICAL.length]) }))}
                centerTop={verifData.reduce((a, d) => a + d.value, 0).toLocaleString()}
                centerBottom="checks · 7d"
                size={128}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><MailCheck className="h-5 w-5 text-info" />Outreach Outcomes · 7d</CardTitle></CardHeader>
          <CardContent>
            {outreachData.length === 0 ? (
              <EmptyState icon={MailCheck} title="No outreach yet" description="Send states will break down here once messages go out." />
            ) : (
              <Donut
                data={outreachData.map((d, i) => ({ ...d, color: resultColor(d.name, CATEGORICAL[i % CATEGORICAL.length]) }))}
                centerTop={outreachData.reduce((a, d) => a + d.value, 0).toLocaleString()}
                centerBottom="sends · 7d"
                size={128}
              />
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---- recent runs ---- */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><BarChart3 className="h-5 w-5 text-muted-foreground" />Recent Runs</CardTitle></CardHeader>
        <CardContent className="p-0">
          {runs.length === 0 ? <div className="p-6"><EmptyState icon={BarChart3} title="No run history" description="Trigger the army to see runs appear here." /></div> : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead><tr className="border-b border-border">
                  <th className="table-th">Status</th><th className="table-th">Leads Found</th><th className="table-th">Attempted</th><th className="table-th">Succeeded</th><th className="table-th">Started</th><th className="table-th">Circuit Broken</th>
                </tr></thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} className="border-b border-border transition-colors last:border-0 hover:bg-accent/40">
                      <td className="table-td">{run.finished_at ? <CheckCircle2 className="h-4 w-4 text-success" /> : run.started_at ? <Clock className="h-4 w-4 animate-pulse text-info" /> : <AlertTriangle className="h-4 w-4 text-muted-foreground" />}</td>
                      <td className="table-td font-semibold tabular-nums">{run.leads_found}</td>
                      <td className="table-td tabular-nums text-muted-foreground">{run.sources_attempted}</td>
                      <td className="table-td tabular-nums text-muted-foreground">{run.sources_succeeded}</td>
                      <td className="table-td text-xs text-muted-foreground">{formatDateTime(run.started_at)}</td>
                      <td className="table-td max-w-[160px] truncate text-xs text-destructive">{run.sources_circuit_broken?.join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default Dashboard;
