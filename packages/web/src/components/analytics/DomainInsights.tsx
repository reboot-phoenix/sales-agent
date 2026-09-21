import React, { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { analyticsDomains } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { StatCard, StatCardGrid } from '@/components/ui/stat-card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { PageLoader } from '@/components/ui/spinner';
import { Briefcase, Trophy, GraduationCap, ServerCog, AlertTriangle } from 'lucide-react';

/**
 * Domain analytics: jobs, hackathons, colleges and the scraper fleet.
 *
 * Every figure comes from the corresponding API aggregate, which counts rows
 * that exist and returns `measured: true` with zeros for an empty domain. The
 * panel therefore never rounds up, extrapolates, or shows a fabricated
 * distribution — an empty domain renders "no data yet" and nothing else.
 */

type Domain = 'jobs' | 'hackathons' | 'colleges' | 'scraper';

const TABS: { key: Domain; label: string; icon: typeof Briefcase }[] = [
  { key: 'jobs', label: 'Jobs', icon: Briefcase },
  { key: 'hackathons', label: 'Hackathons', icon: Trophy },
  { key: 'colleges', label: 'Colleges', icon: GraduationCap },
  { key: 'scraper', label: 'Scraper fleet', icon: ServerCog },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatCount(value: unknown): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('en-IN') : '0';
}

/** Ranked distribution with a proportional bar; zero-valued rows are kept. */
export const DistributionList: React.FC<{ title: string; items: Array<{ label: string; value: number }>; emptyLabel: string }> = ({ title, items, emptyLabel }) => {
  const max = items.reduce((m, i) => Math.max(m, i.value), 0);
  return (
    <div>
      <p className="mb-2 text-[12px] font-medium text-muted-foreground">{title}</p>
      {items.length === 0 ? (
        <p className="text-[12px] text-muted-foreground/70">{emptyLabel}</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.label}>
              <div className="flex items-center justify-between text-[12px]">
                <span className="truncate">{item.label}</span>
                <span className="tabular-nums text-muted-foreground">{formatCount(item.value)}</span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-1.5 rounded-full bg-primary"
                  style={{ width: max > 0 ? `${Math.max((item.value / max) * 100, item.value > 0 ? 2 : 0)}%` : '0%' }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

function pairs(rows: any[] | undefined, key = 'value', labelKey?: string): Array<{ label: string; value: number }> {
  return (rows || []).map((r) => ({ label: String(r[labelKey || key] ?? 'unknown'), value: Number(r.count ?? 0) }));
}

const JobsPanel: React.FC<{ data: any }> = ({ data }) => (
  <>
    <StatCardGrid>
      <StatCard icon={Briefcase} label="Leads" value={formatCount(data.total_leads)} tone="primary" />
      <StatCard icon={Briefcase} label="Companies" value={formatCount(data.companies)} tone="info" />
      <StatCard icon={Briefcase} label="With contact" value={formatCount(data.with_contact)} tone="success" />
      <StatCard icon={Briefcase} label="Fresh" value={formatCount(data.fresh)} tone="warning" />
      <StatCard icon={Briefcase} label="Average score" value={data.average_score ?? '—'} tone="info" />
      <StatCard icon={Briefcase} label="Contacted" value={formatCount(data.contacted)} tone="primary" hint={`${formatCount(data.replied)} replied · ${formatCount(data.converted)} converted`} />
    </StatCardGrid>
    <div className="grid gap-5 md:grid-cols-3">
      <DistributionList title="Pipeline stage" items={pairs(data.by_stage)} emptyLabel="No job leads yet." />
      <DistributionList title="Score band" items={pairs(data.by_score_band)} emptyLabel="No scored leads yet." />
      <DistributionList title="Source" items={pairs(data.by_source)} emptyLabel="No postings yet." />
      <DistributionList title="Location" items={pairs(data.by_location)} emptyLabel="No locations recorded." />
      <DistributionList title="Experience" items={pairs(data.by_experience)} emptyLabel="No experience data." />
      <DistributionList title="Employment type" items={pairs(data.by_employment_type)} emptyLabel="No employment data." />
    </div>
  </>
);

const HackathonsPanel: React.FC<{ data: any }> = ({ data }) => (
  <>
    <StatCardGrid>
      <StatCard icon={Trophy} label="Hackathons" value={formatCount(data.total)} tone="primary" />
      <StatCard icon={Trophy} label="Upcoming / open" value={formatCount(data.registration_open)} tone="success" />
      <StatCard icon={Trophy} label="Recurring series" value={formatCount(data.recurring)} tone="info" />
      <StatCard icon={Trophy} label="Predicted" value={formatCount(data.predicted)} tone="warning" hint="modelled, not confirmed" />
      <StatCard icon={Trophy} label="Organizers" value={formatCount(data.organizers)} tone="primary" />
      <StatCard icon={Trophy} label="Avg prize" value={data.average_prize_pool ? `₹${formatCount(data.average_prize_pool)}` : '—'} tone="info" />
    </StatCardGrid>
    <div className="grid gap-5 md:grid-cols-3">
      <DistributionList title="By state" items={pairs(data.by_state, 'value')} emptyLabel="No state data yet." />
      <DistributionList
        title="By month"
        items={(data.by_month || []).map((r: any) => ({ label: MONTHS[Number(r.month) - 1] || String(r.month), value: Number(r.count) }))}
        emptyLabel="No dated events yet."
      />
      <DistributionList title="By technology" items={pairs(data.by_technology, 'value')} emptyLabel="No technology tags yet." />
      <DistributionList title="Recurring organizers" items={pairs(data.recurring_organizers, 'value')} emptyLabel="No organizer has run twice yet." />
      <DistributionList title="Prize buckets" items={pairs(data.prize_buckets, 'bucket')} emptyLabel="No prize data yet." />
      <DistributionList title="Historical editions" items={[{ label: 'historical', value: Number(data.historical ?? 0) }]} emptyLabel="No history yet." />
    </div>
    {data.pending_raw > 0 && (
      <p className="flex items-center gap-2 text-[12px] text-warning">
        <AlertTriangle className="h-3.5 w-3.5" />
        {formatCount(data.pending_raw)} raw discovery record(s) still awaiting processing — none have been dropped.
      </p>
    )}
  </>
);

const CollegesPanel: React.FC<{ data: any }> = ({ data }) => (
  <>
    <StatCardGrid>
      <StatCard icon={GraduationCap} label="Colleges" value={formatCount(data.total)} tone="primary" />
      <StatCard icon={GraduationCap} label="States covered" value={formatCount(data.states_covered)} tone="info" hint={`${formatCount(data.districts_covered)} districts`} />
      <StatCard icon={GraduationCap} label="With website" value={formatCount(data.with_website)} tone="info" />
      <StatCard icon={GraduationCap} label="Enriched" value={formatCount(data.enriched)} tone="success" />
      <StatCard icon={GraduationCap} label="Contacts" value={formatCount(data.contacts_total)} tone="primary" hint={`${formatCount(data.contact_emails)} emails · ${formatCount(data.contact_phones)} phones`} />
      <StatCard icon={GraduationCap} label="TPO contacts" value={formatCount(data.tpo_roles)} tone="warning" hint={`${formatCount(data.principals)} principals`} />
    </StatCardGrid>
    <div className="grid gap-5 md:grid-cols-3">
      <DistributionList title="By state" items={pairs(data.by_state, 'value')} emptyLabel="No state data yet." />
      <DistributionList title="Ownership" items={pairs(data.by_ownership, 'value')} emptyLabel="No ownership data yet." />
      <DistributionList title="Outreach readiness" items={pairs(data.by_outreach_readiness, 'value')} emptyLabel="No readiness data yet." />
      <DistributionList title="Enrichment status" items={pairs(data.by_enrichment_status, 'value')} emptyLabel="No enrichment data yet." />
      <DistributionList title="Source coverage" items={pairs(data.by_source, 'value')} emptyLabel="No sources recorded yet." />
    </div>
    {data.pending_raw > 0 && (
      <p className="flex items-center gap-2 text-[12px] text-warning">
        <AlertTriangle className="h-3.5 w-3.5" />
        {formatCount(data.pending_raw)} raw discovery record(s) still awaiting processing — none have been dropped.
      </p>
    )}
  </>
);

const ScraperPanel: React.FC<{ data: any }> = ({ data }) => (
  <>
    <StatCardGrid>
      <StatCard icon={ServerCog} label="Runs" value={formatCount(data.total_runs)} tone="primary" hint={`${formatCount(data.running_runs)} running`} />
      <StatCard icon={ServerCog} label="Completed" value={formatCount(data.successful_runs)} tone="success" />
      <StatCard icon={ServerCog} label="Failed / partial" value={formatCount(data.failed_runs)} tone="danger" />
      <StatCard icon={ServerCog} label="Records discovered" value={formatCount(data.records_discovered)} tone="info" hint={`${formatCount(data.duplicates_removed)} duplicates removed`} />
      <StatCard icon={ServerCog} label="Contacts discovered" value={formatCount(data.contacts_discovered)} tone="success" />
      <StatCard icon={ServerCog} label="Predictions" value={formatCount(data.predictions_generated)} tone="warning" hint={`${formatCount(data.enrichments_done)} enrichments`} />
    </StatCardGrid>
    <div className="grid gap-5 md:grid-cols-3">
      <DistributionList title="Runs by domain" items={pairs(data.by_domain, 'value')} emptyLabel="No army runs yet." />
      <DistributionList title="Pending raw by domain" items={pairs(data.raw_pending, 'value')} emptyLabel="Nothing pending — the staging queue is empty." />
      <DistributionList
        title="Source health"
        items={(data.source_health || []).map((s: any) => ({ label: `${s.domain}/${s.name} · ${s.health_status}`, value: Number(s.consecutive_failures ?? 0) }))}
        emptyLabel="No sources registered yet."
      />
    </div>
    <div>
      <p className="mb-2 text-[12px] font-medium text-muted-foreground">Recent errors ({formatCount(data.errors)} total, {formatCount(data.retries)} retries)</p>
      {(data.recent_errors || []).length === 0 ? (
        <p className="text-[12px] text-muted-foreground/70">No source errors recorded.</p>
      ) : (
        <ul className="space-y-1">
          {data.recent_errors.slice(0, 8).map((e: any, i: number) => (
            <li key={i} className="flex items-start gap-2 text-[12px]">
              <Badge className="border-border">{e.domain}/{e.source}</Badge>
              <span className="truncate text-muted-foreground" title={e.error}>{e.error}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  </>
);

const DomainInsights: React.FC = () => {
  const [tab, setTab] = useState<Domain>('hackathons');
  const { data, isLoading, isError, error, refetch } = useQuery({
  queryKey: ['domain-analytics', tab],
  queryFn: () => analyticsDomains[tab](),
  staleTime: 60000, placeholderData: keepPreviousData,
});

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ServerCog className="h-5 w-5 text-primary" />
          Intelligence domains
          <span className="text-[12px] font-normal text-muted-foreground">measured from stored rows only</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors ${
                tab === key ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        {isLoading && !data ? (
          <PageLoader label="Loading domain analytics..." />
        ) : isError ? (
          <ErrorState title="Could not load domain analytics" message={(error as Error).message} onRetry={() => refetch()} />
        ) : !data ? (
          <EmptyState icon={ServerCog} title="No analytics yet." description="Run an army to populate this section." />
        ) : (
          <div className="space-y-5">
            {tab === 'jobs' && <JobsPanel data={data} />}
            {tab === 'hackathons' && <HackathonsPanel data={data} />}
            {tab === 'colleges' && <CollegesPanel data={data} />}
            {tab === 'scraper' && <ScraperPanel data={data} />}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default DomainInsights;
