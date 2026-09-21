import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useLegacyTable as useReactTable, getCoreRowModel, getSortedRowModel, getFilteredRowModel,
  getPaginationRowModel, legacyCreateColumnHelper as createColumnHelper,
} from '@tanstack/react-table/legacy';
import { flexRender, SortingState, ColumnFiltersState, ColumnVisibilityState } from '@tanstack/react-table';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { leads as leadsApi, admin, type ImportResult } from '@/lib/api';
import { Lead } from '@/lib/types';
import {
  Search, RefreshCw, ChevronUp, ChevronDown, ChevronRight, Play, Sparkles, MapPin,
  BadgeCheck, FileText, MessageCircle, Mail, Eye, Users, UserPlus, UserCheck, XCircle,
  Columns3, LayoutGrid, Download, Zap, Loader2, CheckCircle2, ExternalLink, Phone, Copy, Check, Radar, Send, Square,
} from 'lucide-react';
import { useSSE, isLeadLifecycleEvent } from '@/hooks/useSSE';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { Select } from '@/components/ui/select';
import { Menu } from '@/components/ui/menu';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoader } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Pagination } from '@/components/ui/pagination';
import { SCORE_BAND_META, stageMeta, emailStatusMeta, whatsappStatusMeta, formatDate } from '@/lib/format';
import { FRESHNESS_META, freshnessCategory, freshnessLabel, score10 } from '@/lib/freshness';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { LEAD_COLUMNS, leadsToCsv } from '@/lib/leadColumns';
import { ImportLeadsModal } from '@/components/ImportLeadsModal';
import { Upload } from 'lucide-react';

type Density = 'comfortable' | 'compact';

// Providers offered in the manual "Enrich via" menu. `key` is what the API/worker
// route on; hint tells the operator which need a configured key.
const ENRICH_PROVIDERS = [
  { key: 'auto', label: 'Full Army (auto)', hint: 'free OSINT cascade', icon: Radar },
  { key: 'contactout', label: 'ContactOut', hint: 'LinkedIn-based · key', icon: ExternalLink },
  { key: 'snovio', label: 'Snov.io', hint: 'name+domain · key', icon: Mail },
  { key: 'hunter', label: 'Hunter.io', hint: 'key', icon: Mail },
  { key: 'apollo', label: 'Apollo.io', hint: 'key', icon: Sparkles },
] as const;

// Export columns live in @/lib/leadColumns (mirror of the API registry), so the CSV a
// rep downloads here and the server workbook can never disagree.

const ALL_COLUMNS = [
  { id: 'lead_score', label: 'Score' }, { id: 'company_name', label: 'Company' },
  { id: 'job_title', label: 'Job Title' }, { id: 'role', label: 'Role' },
  { id: 'location', label: 'Location' }, { id: 'salary', label: 'Salary' },
  { id: 'hr_name', label: 'HR Contact' },
  { id: 'assigned', label: 'Owner' },
  { id: 'verification', label: 'Verification' }, { id: 'stage', label: 'Stage' },
  { id: 'source_site', label: 'Source' }, { id: 'posted_at', label: 'Posted' },
  { id: 'created_at', label: 'Discovered' }, { id: 'posting_link', label: 'Apply Link' },
];

const Leads: React.FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [sorting, setSorting] = useState<SortingState>([]);
  // Dashboard charts deep-link here (?pipeline_stage=, ?score_band=): seed the
  // filters from the URL once so a click on a funnel bar lands filtered.
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const init: ColumnFiltersState = [];
      const stage = params.get('pipeline_stage');
      const band = params.get('score_band');
      if (stage) init.push({ id: 'pipeline_stage', value: stage });
      if (band) init.push({ id: 'score_band', value: band });
      return init;
    } catch {
      return [];
    }
  });
  const [globalFilter, setGlobalFilter] = useState('');
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [draftChannel, setDraftChannel] = useState<'email' | 'whatsapp' | 'both'>('both');
  const [experienceFilter, setExperienceFilter] = useState<'' | 'fresher' | '0-1yr' | '0-2yr' | 'no-experience'>('');
  // Facets the API now supports; without UI for them the new columns were
  // display-only and a rep could not actually slice a queue by work mode or pay.
  const [workplaceFilter, setWorkplaceFilter] = useState<'' | 'remote' | 'onsite' | 'hybrid'>('');
  const [salaryFilter, setSalaryFilter] = useState<'' | 'any' | '5' | '10' | '20'>('');
  const [visibility, setVisibility] = useState<ColumnVisibilityState>({});
  const [density, setDensity] = useState<Density>('comfortable');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [assignLead, setAssignLead] = useState<Lead | null>(null);
  const [memberSearch, setMemberSearch] = useState('');
  const isAdmin = useAuthStore.getState().user?.role === 'admin';
  const { data: membersData } = useQuery({
  queryKey: ['team-members'],
  queryFn: () => admin.teamMembers(),
  retry: false, staleTime: 60000,
});
  const members: Array<{ id: string; email: string; role: string }> = (membersData as any)?.members || [];
  const assignMutation = useMutation({
  mutationFn: ({ id, userId }: { id: string; userId: string | null }) => leadsApi.assign(id, userId),
  onSuccess: () => {
  toast({ title: 'Lead assigned', variant: 'success' });
  setAssignLead(null);
  queryClient.invalidateQueries({
  queryKey: ['leads'],
});
  },
  onError: (e) => toast({ title: 'Assign failed', description: (e as Error).message, variant: 'error' }),
});
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);
  const bulkClaimMutation = useMutation({
  mutationFn: (ids: string[]) => leadsApi.bulkClaim(ids),
  onSuccess: (r) => {
  const skipped = r.already_claimed?.length || 0;
  toast({
  title: `Claimed ${r.claimed.length} lead${r.claimed.length === 1 ? '' : 's'}`,
  description: skipped ? `${skipped} already owned by someone else` : undefined,
  variant: skipped && r.claimed.length === 0 ? 'warning' : 'success',
  });
  setSelectedIds(new Set());
  queryClient.invalidateQueries({
  queryKey: ['leads'],
});
  },
  onError: (e) => toast({ title: 'Bulk claim failed', description: (e as Error).message, variant: 'error' }),
});
  const bulkAssignMutation = useMutation({
  mutationFn: ({ ids, userId }: { ids: string[]; userId: string | null }) => leadsApi.bulkAssign(ids, userId),
  onSuccess: (r) => {
  toast({ title: `Assigned ${r.assigned.length} leads`, variant: 'success' });
  setBulkAssignOpen(false);
  setSelectedIds(new Set());
  queryClient.invalidateQueries({
  queryKey: ['leads'],
});
  },
  onError: (e) => toast({ title: 'Bulk assign failed', description: (e as Error).message, variant: 'error' }),
});

  // Column ids and the API's sort enum are different namespaces: several columns are
  // display composites (salary_range renders text but the sortable value is a numeric
  // bound). Sending an unmapped id made the API answer 400 and the table rendered
  // "Error loading leads" with no rows -- a header click blanking the page. Anything
  // not in the enum or the map falls back to created_at instead of erroring.
  const SORTABLE_COLUMNS = new Set([
    'lead_score', 'created_at', 'updated_at', 'company_name', 'job_title',
    'source_site', 'hr_name', 'location_type', 'salary_min', 'salary_max', 'posted_at',
    'pipeline_stage', 'data_quality', 'employment_type', 'department',
  ]);
  const SORT_ALIASES: Record<string, string> = {
    salary_range: 'salary_min',
    location: 'location_type',
    stage: 'pipeline_stage',
    role: 'job_title',
    posting_link: 'posted_at',
  };
  const requestedSort = sorting.length > 0 ? sorting[0].id : 'created_at';
  const mappedSort = SORT_ALIASES[requestedSort] ?? requestedSort;
  const sortParam = SORTABLE_COLUMNS.has(mappedSort) ? mappedSort : 'created_at';
  const sortOrder = sorting.length > 0 ? (sorting[0].desc ? 'desc' : 'asc') : 'desc';
  const scoreBand = columnFilters.find((f) => f.id === 'score_band')?.value as string | undefined;
  const pipelineStage = columnFilters.find((f) => f.id === 'pipeline_stage')?.value as string | undefined;
  const sourceSite = columnFilters.find((f) => f.id === 'source_site')?.value as string | undefined;
  const [ownershipFilter, setOwnershipFilter] = useState<'' | 'unclaimed' | 'claimed' | 'assigned' | 'mine'>('');
  const page = pagination.pageIndex + 1;

  // The active filters, in one place so the table query and the export can never
  // drift -- an export that ignored the current filter would silently hand back a
  // different set of leads than the user is looking at.
  // Full-field filters (server-side; every filter narrows the DB query, never
  // just the visible page — client-side filtering on 25 rows lies with pagination).
  const [sourceFilter, setSourceFilter] = useState('');
  const [cityFilter, setCityFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [contactFilter, setContactFilter] = useState<'' | 'none' | 'partial' | 'enriched' | 'verified'>('');
  const [dateFilter, setDateFilter] = useState<'' | '24h' | '7d' | '30d'>('');
  const [freshnessFilter, setFreshnessFilter] = useState<'' | 'fresh' | 'recent' | 'older' | 'unknown'>('');
  const dateFrom = dateFilter === '24h' ? new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    : dateFilter === '7d' ? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
    : dateFilter === '30d' ? new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
    : undefined;
  const exportParams = {
    sort_by: sortParam as any, sort_order: sortOrder as any,
    score_band: scoreBand, pipeline_stage: pipelineStage, source_site: sourceSite || sourceFilter || undefined,
    ownership: ownershipFilter || undefined,
    filter: globalFilter || undefined, experience: experienceFilter || undefined,
    location_type: workplaceFilter || undefined,
    city: cityFilter || undefined, department: deptFilter || undefined,
    contact: contactFilter || undefined, freshness: freshnessFilter || undefined,
    date_from: dateFrom,
    // "₹5L+" means a numeric floor (salary_min), not the has_salary flag -- the old
    // code sent the rupee amount AS has_salary, so every pay band behaved like "disclosed".
    salary_min: salaryFilter && salaryFilter !== 'any' ? Number(salaryFilter) * 100000 : undefined,
    has_salary: salaryFilter === 'any' ? true : undefined,
  };

  const { data, isLoading, refetch, isFetching, isError, error } = useQuery({
  queryKey: ['leads', page, pagination.pageSize, sortParam, sortOrder, scoreBand, pipelineStage, sourceSite, ownershipFilter, globalFilter, experienceFilter, workplaceFilter, salaryFilter, sourceFilter, cityFilter, deptFilter, contactFilter, dateFrom, freshnessFilter],
  queryFn: () => leadsApi.list({
      page, limit: pagination.pageSize, sort_by: sortParam as any, sort_order: sortOrder as any,
      score_band: scoreBand, pipeline_stage: pipelineStage, source_site: sourceSite || sourceFilter || undefined,
      ownership: ownershipFilter || undefined,
      filter: globalFilter || undefined, experience: experienceFilter || undefined,
      location_type: workplaceFilter || undefined,
      city: cityFilter || undefined, department: deptFilter || undefined,
      contact: contactFilter || undefined, freshness: freshnessFilter || undefined,
      date_from: dateFrom,
      salary_min: salaryFilter && salaryFilter !== 'any' ? Number(salaryFilter) * 100000 : undefined,
      has_salary: salaryFilter === 'any' ? true : undefined,
    }),
  staleTime: 15000,
  refetchInterval: 20000,
});

  useSSE('/sse/token', (event) => {
    if (isLeadLifecycleEvent(event.type)) {
      refetch();
    }
  });

  const { data: armyStatus } = useQuery({
  queryKey: ['army-status'],
  queryFn: () => admin.armyStatus(),
  refetchInterval: 5000, refetchOnWindowFocus: false,
});
  const queued = armyStatus ? (armyStatus.raw || 0) + (armyStatus.enrichment || 0) + (armyStatus.verification || 0) + (armyStatus.draft || 0) : 0;
  const [armyConfirmOpen, setArmyConfirmOpen] = useState(false);
  const [armyStopConfirmOpen, setArmyStopConfirmOpen] = useState(false);
  const stopMutation = useMutation({
  mutationFn: () => admin.stopArmy(),
  onSuccess: (d: any) => {
  queryClient.invalidateQueries({
  queryKey: ['army-status'],
});
  setArmyStopConfirmOpen(false);
  toast({
  title: d?.stopped === false ? 'Nothing to stop' : 'Army stopping',
  description: d?.stopped === false
  ? (d?.reason || 'No scrape activity is running.')
  : `In-flight sources cancelling now;${d?.cleared_queued_jobs ? ` ${d.cleared_queued_jobs} queued jobs discarded;` : ''} discovered leads keep flowing through the pipeline.`,
  variant: d?.stopped === false ? 'warning' : 'success',
  });
  },
  onError: (e) => toast({ title: 'Could not stop army', description: (e as Error).message, variant: 'error' }),
});
  // Command palette hands off here so every army trigger is confirmed.
  React.useEffect(() => {
    const open = () => setArmyConfirmOpen(true);
    window.addEventListener('hiregen:confirm-army', open);
    return () => window.removeEventListener('hiregen:confirm-army', open);
  }, []);
  const armyMutation = useMutation({
  mutationFn: () => admin.runArmy(),
  onSuccess: (d: any) => { toast({ title: 'Army deployed', description: d?.sweep_reenqueued ? `Scraping all sources + re-enriching ${d.sweep_reenqueued} leads.` : 'Scraping all sources.', variant: 'success' }); queryClient.invalidateQueries({
  queryKey: ['army-status'],
}); setArmyConfirmOpen(false); },
  onError: (e) => toast({ title: 'Could not start army', description: (e as Error).message, variant: 'error' }),
});

  const runAction = (fn: Promise<unknown>, successMsg: string) =>
    fn.then(() => { toast({ title: successMsg, variant: 'success' }); queryClient.invalidateQueries({
  queryKey: ['leads'],
}); })
      .catch((err: Error) => toast({ title: 'Action failed', description: err.message, variant: 'error' }));

  // Which action is in flight for which row, so the pressed button can show a spinner
  // instead of looking dead for the few hundred ms until the list refetches.
  const [busy, setBusy] = useState<Record<string, string>>({});
  const act = (leadId: string, kind: string, fn: Promise<unknown>, msg: string) => {
    // Double-fire guard: a second click while the first is in flight is ignored.
    let ignored = false;
    setBusy((b) => {
      if (b[leadId]) { ignored = true; return b; }
      return { ...b, [leadId]: kind };
    });
    if (ignored) { try { (fn as Promise<unknown>).catch(() => {}); } catch { /* noop */ } return Promise.resolve(); }
    return runAction(fn, msg).finally(() => {
      setBusy((b) => { const n = { ...b }; delete n[leadId]; return n; });
    });
  };

  // Universal confirmation: every consequential action stages here first and
  // fires only on explicit confirm. The promise factory runs AFTER confirm so
  // nothing starts in the background while the dialog is open.
  const [actionConfirm, setActionConfirm] = useState<{
    title: string; description: string; confirmLabel: string;
    variant?: 'destructive' | 'default'; run: () => void;
  } | null>(null);
  const confirmAct = (
    leadId: string, kind: string, make: () => Promise<unknown>, msg: string,
    title: string, description: string, confirmLabel: string,
    variant?: 'destructive' | 'default',
  ) => setActionConfirm({
    title, description, confirmLabel, variant,
    run: () => { setActionConfirm(null); act(leadId, kind, make(), msg); },
  });
  const who = (lead: any) => `${lead.company_name || 'this lead'}${lead.job_title ? ` · ${lead.job_title}` : ''}`;

  const bulkEnrichMutation = useMutation({
  mutationFn: ({ ids, provider }: { ids: string[]; provider: string }) => Promise.all(ids.map((id) => leadsApi.enrich(id, provider))),
  onSuccess: (_r, v) => { toast({ title: `Enrichment started`, description: `${v.ids.length} leads → ${v.provider}`, variant: 'success' }); setSelectedIds(new Set()); queryClient.invalidateQueries({
  queryKey: ['leads'],
}); }, onError: (e) => toast({ title: 'Bulk enrich failed', description: (e as Error).message, variant: 'error' }),
});
  const bulkDraftMutation = useMutation({
  mutationFn: ({ leadIds, channel }: { leadIds: string[]; channel: 'email' | 'whatsapp' | 'both' }) => leadsApi.bulkDraft(leadIds, channel),
  onSuccess: () => { setSelectedIds(new Set()); queryClient.invalidateQueries({
  queryKey: ['leads'],
}); toast({ title: 'Drafts generated', variant: 'success' }); }, onError: (e) => toast({ title: 'Failed to generate drafts', description: (e as Error).message, variant: 'error' }),
});

  const leadData: any = data ?? { data: [], pagination: { page: 1, limit: 25, total: 0, pages: 0 } };
  // Freshness is server-side (freshnessFilter rides the query above): rows arrive
  // already narrowed, so no client-side pass that would lie under pagination.
  const leadRows: Lead[] = leadData.data || [];

  const toggleSelectAll = () => {
    const allIds = leadRows.map((r) => r.id);
    const allSel = allIds.length > 0 && allIds.every((id) => selectedIds.has(id));
    setSelectedIds(allSel ? new Set() : new Set(allIds));
  };
  const toggleSelect = (id: string) => setSelectedIds((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleExpand = (id: string) => setExpanded((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Export. "Filtered" asks the server for every lead matching the current filters
  // (not just the 25 on screen) and returns all LEAD_COLUMNS; "selected" writes the
  // checked rows from this page using the same column registry.
  const [exporting, setExporting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const downloadBlob = (blob: Blob, name: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  const stamp = () => new Date().toISOString().slice(0, 10);

  const exportSelectedCsv = () => {
    const rows = leadRows.filter((r: any) => selectedIds.has(r.id));
    if (rows.length === 0) { toast({ title: 'Nothing selected', variant: 'error' }); return; }
    downloadBlob(new Blob([leadsToCsv(rows)], { type: 'text/csv;charset=utf-8;' }), `hiregen-leads-selected-${rows.length}.csv`);
    toast({ title: `Exported ${rows.length} selected leads`, variant: 'success' });
  };

  const runExport = async (kind: 'xls' | 'csv') => {
    setExporting(true);
    try {
      const blob = await leadsApi.exportExcel({ ...exportParams, format: kind });
      downloadBlob(blob, `hiregen-leads-${stamp()}.${kind}`);
      toast({ title: `${kind.toUpperCase()} downloaded`, description: `All filtered leads · ${LEAD_COLUMNS.length} columns`, variant: 'success' });
    } catch (e: any) {
      toast({ title: 'Export failed', description: e?.message || 'Try again', variant: 'error' });
    } finally {
      setExporting(false);
    }
  };

  const onImported = (r: ImportResult) => {
    queryClient.invalidateQueries({
  queryKey: ['leads'],
});
    const bits = [r.created && `${r.created} new`, (r.merged + r.merged_fuzzy) && `${r.merged + r.merged_fuzzy} merged`, r.skipped && `${r.skipped} skipped`].filter(Boolean);
    toast({
      title: `Imported ${r.total_rows} rows`,
      description: bits.join(' · ') || 'nothing to write',
      variant: r.skipped && !r.created ? 'warning' : 'success',
    });
  };

  const columnHelper = createColumnHelper<Lead & Record<string, any>>();

  const columns = useMemo(() => [
    columnHelper.display({ id: 'select', size: 40, header: () => (
      <input type="checkbox" aria-label="Select all" checked={leadRows.length > 0 && leadRows.every((r) => selectedIds.has(r.id))} onChange={toggleSelectAll} className="h-4 w-4 cursor-pointer rounded border-input accent-primary" />
    ), cell: ({ row }) => (
      <input type="checkbox" aria-label="Select row" checked={selectedIds.has(row.original.id)} onChange={() => toggleSelect(row.original.id)} className="h-4 w-4 cursor-pointer rounded border-input accent-primary" onClick={(e) => e.stopPropagation()} />
    ) }),
    columnHelper.display({ id: 'expand', size: 34, header: () => null, cell: ({ row }) => (
      <button onClick={(e) => { e.stopPropagation(); toggleExpand(row.original.id); }} className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" aria-label="Expand">
        <ChevronRight className={`h-4 w-4 transition-transform ${expanded.has(row.original.id) ? 'rotate-90' : ''}`} />
      </button>
    ) }),
    columnHelper.accessor('lead_score', { header: 'Score', cell: (info) => {
      const row = info.row.original as any;
      const band = info.row.original.score_band as 'hot' | 'warm' | 'cold'; const meta = SCORE_BAND_META[band];
      const ten = row.score_10 ?? score10(info.getValue() as number);
      return <div className="flex items-center gap-2" title={`${info.getValue()}/100 · band ${band || '—'}`}><span className="inline-flex h-8 w-8 items-center justify-center rounded-full border bg-muted text-[13px] font-bold tabular-nums text-ink-strong">{ten}<span className="text-[10px] font-medium text-muted-foreground">/10</span></span>{meta && <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />}</div>;
    } }),
    columnHelper.accessor('company_name', { header: 'Company', cell: (info) => (
      <div className="min-w-0"><p className="truncate font-medium text-foreground">{info.getValue() || '—'}</p>{info.row.original.company_domain && <p className="truncate text-xs text-muted-foreground">{info.row.original.company_domain}</p>}</div>
    ) }),
    columnHelper.accessor('job_title', { header: 'Job Title', cell: (info) => <span className="line-clamp-1 text-muted-foreground">{info.getValue() || info.row.original.source_site || '—'}</span> }),
    // Location + salary + experience were never surfaced in the table even after
    // scraping them, so reps had to open each lead to tell if a role was worth
    // working. Each facet gets its own column so it can be sorted, toggled and
    // read at a glance; blank rather than a fake placeholder when absent.
    columnHelper.display({ id: 'role', header: 'Role', cell: ({ row }) => {
      const l = row.original;
      return (
        <div className="min-w-0 space-y-1">
          {l.experience_level && <p className="truncate text-[12px] text-muted-foreground">{l.experience_level}</p>}
          {l.department && <p className="truncate text-[11px] text-muted-foreground">{l.department}</p>}
          {(l.openings_count ?? 0) > 1 && <p className="truncate text-[11px] text-muted-foreground">{l.openings_count} openings</p>}
          {!l.experience_level && !l.department && !(l.openings_count! > 1) && <span className="text-[12px] text-muted-foreground">—</span>}
        </div>
      );
    } }),
    columnHelper.display({ id: 'location', header: 'Location', cell: ({ row }) => {
      const l = row.original;
      const loc = [l.city, l.state].filter(Boolean).join(', ') || l.location || '';
      // Workplace and employment type are separate facets; sources provide either,
      // so show whichever is present rather than a dash.
      const mode = l.location_type || (l.is_work_from_home ? 'remote' : '');
      return (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <MapPin className="h-3 w-3 shrink-0" />
            <span className="truncate">{loc || mode || '—'}</span>
          </div>
          {/* Only the facets the location line does not already show, so a city is
              never glued straight onto "remote" with no separator. */}
          {(() => {
            const extra = [mode && mode !== loc ? mode : null, l.employment_type, l.country]
              .filter(Boolean).join(' \u00b7 ');
            return extra ? <p className="truncate pl-[18px] text-[11px] capitalize text-muted-foreground/80">{extra}</p> : null;
          })()}
        </div>
      );
    } }),
    // Sorting this column asks the API for salary_min (see SORT_ALIASES): ordering a
    // free-text band like "2-3 LPA" lexicographically is meaningless, and the raw id
    // is not in the sort enum -- sending it returned 400 and blanked the table.
    columnHelper.accessor('salary_range', { header: 'Salary', cell: (info) => {
      const l = info.row.original;
      const text = info.getValue();
      if (text) return <span className="whitespace-nowrap text-[12px] font-medium text-success">{text}</span>;
      // Many sources only give structured bounds; render those instead of a dash.
      const fmt = (n: any) => n == null ? null : Math.round(Number(n)).toLocaleString('en-IN');
      const lo = fmt(l.salary_min), hi = fmt(l.salary_max);
      if (!lo && !hi) return <span className="text-[12px] text-muted-foreground">—</span>;
      const cur = l.salary_currency === 'INR' || !l.salary_currency ? '₹' : `${l.salary_currency} `;
      const span = lo && hi && lo !== hi ? `${cur}${lo}-${hi}` : `${cur}${lo || hi}`;
      return <span className="whitespace-nowrap text-[12px] font-medium text-success">{span}{l.salary_period ? <span className="text-muted-foreground">/{l.salary_period === 'year' ? 'yr' : 'mo'}</span> : null}</span>;
    } }),
    columnHelper.accessor('hr_name', { header: 'HR Contact', cell: (info) => {
      const lead = info.row.original;
      return lead.hr_name ? (
        <div className="flex items-center gap-2.5"><Avatar name={lead.hr_name} size="sm" /><div className="min-w-0"><p className="truncate text-[13px] font-medium">{lead.hr_name}</p>{(lead as any).hr_title ? <p className="truncate text-xs text-muted-foreground">{(lead as any).hr_title}</p> : lead.hr_email ? <p className="truncate text-xs text-muted-foreground">{lead.hr_email}</p> : null}</div></div>
      ) : <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning"><Sparkles className="h-3 w-3" />needs enrichment</span>;
    } }),
    // Ownership is explicit: Unclaimed / Claimed by X / Assigned to Y / both.
    columnHelper.display({ id: 'assigned', header: 'Owner', cell: ({ row }) => {
      const l = row.original as any;
      const claimed = l.claimed_by_email || l.claimed_by;
      const assigned = l.assigned_to_email || l.assigned_to;
      const short = (v: unknown) => String(v).split('@')[0];
      if (claimed && assigned && claimed !== assigned)
        return <span className="block max-w-[190px] truncate text-[12px] text-muted-foreground" title={`Claimed by ${claimed}, assigned to ${assigned}`}>Claimed by {short(claimed)} · → {short(assigned)}</span>;
      if (assigned)
        return <span className="block max-w-[170px] truncate text-[12px] text-muted-foreground" title={String(assigned)}>Assigned to {short(assigned)}</span>;
      if (claimed)
        return <span className="block max-w-[170px] truncate text-[12px] text-muted-foreground" title={String(claimed)}>Claimed by {short(claimed)}</span>;
      return <span className="text-[12px] text-muted-foreground/60">Unclaimed</span>;
    } }),
    columnHelper.display({ id: 'verification', header: 'Verification', cell: ({ row }) => {
      const lead = row.original; const em = emailStatusMeta(lead.email_status); const wm = whatsappStatusMeta(lead.whatsapp_status);
      return <div className="flex flex-wrap gap-1.5">{em && <Badge className={em.className}>{em.label}</Badge>}{wm && <Badge className={wm.className}>{wm.label}</Badge>}</div>;
    } }),
    columnHelper.display({ id: 'stage', header: 'Stage', cell: ({ row }) => { const meta = stageMeta(row.original.pipeline_stage); return <Badge className={meta.className}><span className="capitalize">{meta.label}</span></Badge>; } }),
    // Hostnames must keep their own casing: CSS capitalize turned timesjobs.com into
    // "Timesjobs.Com", which reads as a different brand than the one on the posting.
    columnHelper.accessor('source_site', { header: 'Source', cell: (info) => <span className="text-[13px] text-muted-foreground">{info.getValue() || '—'}</span> }),
    columnHelper.accessor('posted_at', { header: 'Posted', cell: (info) => {
      const l = info.row.original as any;
      const cat = (l.freshness_category as keyof typeof FRESHNESS_META) || freshnessCategory(l.posted_at, l.created_at);
      const meta = FRESHNESS_META[cat] || FRESHNESS_META.unknown;
      return (
        <div className="flex flex-col gap-1">
          <span className="whitespace-nowrap text-[13px] text-muted-foreground">{info.getValue() ? formatDate(info.getValue()) : '—'}</span>
          <span className="flex w-fit items-center gap-1.5">
            <span className={`inline-flex items-center rounded border px-1 py-px font-mono text-[10px] font-bold tracking-wide ${meta.className}`} title={`Freshness: ${meta.label}${l.posted_at ? '' : ' (posting date unavailable)'}`}>{meta.tag}</span>
            <span className="text-[11px] tabular-nums text-muted-foreground">{cat === 'unknown' ? 'Unknown' : freshnessLabel(l.posted_at, l.created_at, cat)}</span>
          </span>
        </div>
      );
    } }),
    columnHelper.display({ id: 'posting_link', header: 'Apply Link', cell: ({ row }) => {
      const l = row.original;
      const url = l.apply_url || l.job_url;
      return url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
           title={url} className="inline-flex items-center gap-1 text-[12px] text-info hover:underline">
          <ExternalLink className="h-3.5 w-3.5" />Open
        </a>
      ) : <span className="text-[12px] text-muted-foreground">—</span>;
    } }),
    columnHelper.accessor('created_at', { header: 'Discovered', cell: (info) => <span className="text-[13px] text-muted-foreground">{formatDate(info.getValue())}</span> }),
    // Row actions: Eye (open) + dedicated Claim / Assign pills + one Actions
    // menu for the pipeline (enrich → outreach → manage). Claim/assign live
    // outside the menu so ownership takes one obvious click.
    columnHelper.display({ id: 'actions', header: () => <span className="sr-only">Actions</span>, cell: ({ row }) => {
      const lead = row.original;
      const pending = busy[lead.id];
      // Once a message is out, re-running enrich/verify/draft on the row is noise.
      const done = (['contacted', 'replied', 'converted'] as string[]).includes(lead.pipeline_stage);
      const emailOk = lead.email_status === 'valid';
      const waOk = lead.whatsapp_status === 'registered';
      const unclaimed = !(lead as any).claimed_by && !(lead as any).assigned_to;
      return (
        <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          {done && (
            <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success">
              <CheckCircle2 className="h-3 w-3" />{lead.pipeline_stage === 'replied' ? 'Replied' : 'Contacted'}
            </span>
          )}
          {unclaimed && (
            <button
              type="button"
              title="Claim this lead — it becomes yours instantly"
              aria-label={`Claim ${lead.company_name || 'lead'}`}
              disabled={!!pending}
              onClick={() => confirmAct(lead.id, 'claim', () => leadsApi.claim(lead.id), 'Lead claimed',
                'Claim this lead?',
                `${who(lead)}. It becomes yours instantly and leaves the shared claim pool. Another admin can reassign it later.`,
                'Claim lead')}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 py-[7px] text-[12px] font-semibold text-primary-foreground shadow-sm transition-all hover:bg-primary-hover hover:shadow-md hover:-translate-y-px active:translate-y-0 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {pending === 'claim' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
              {pending === 'claim' ? 'Claiming…' : 'Claim'}
            </button>
          )}
          {isAdmin && (
            <button
              type="button"
              title="Assign this lead to a team member"
              aria-label={`Assign ${lead.company_name || 'lead'}`}
              onClick={() => setAssignLead(lead as any)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 py-[7px] text-[12px] font-semibold text-foreground shadow-sm transition-all hover:border-primary/50 hover:bg-primary-soft hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <UserCheck className="h-3.5 w-3.5" />
              Assign
            </button>
          )}
          <button
            type="button"
            title="Open full record"
            aria-label={`Open ${lead.company_name || 'lead'}`}
            onClick={() => navigate(`/leads/${lead.id}`)}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-border text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary-soft hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
          <Menu ariaLabel={`Actions for ${lead.company_name || 'lead'}`} align="end" trigger={
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary-soft px-3 py-1 text-[12px] font-semibold text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" role="button" tabIndex={0}>
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              {pending ? 'Working…' : 'Actions'}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </span>
          } items={[
            { label: 'Open full record', icon: <Eye />, onSelect: () => navigate(`/leads/${lead.id}`) },
            // ONE primary Enrich: the engine picks OSINT → Snov → ContactOut → Apollo.
            { label: 'Enrich', section: 'Enrich', hint: 'auto', icon: <Radar />, disabled: done, onSelect: () => confirmAct(lead.id, 'enrich', () => leadsApi.enrich(lead.id, 'auto'), 'Enrichment started',
              'Enrich this lead?',
              `${who(lead)}. Runs the free OSINT cascade first, then paid providers (Snov.io, ContactOut, Apollo) where keys exist — paid lookups may consume credits. Safe to re-run; verified contacts are never overwritten.`,
              'Enrich') },
            ...ENRICH_PROVIDERS.filter((p) => p.key !== 'auto').map((pc) => ({ label: `Enrich · ${pc.label}`, section: 'Enrich', hint: pc.hint, icon: <Sparkles />, disabled: done, onSelect: () => confirmAct(lead.id, 'enrich', () => leadsApi.enrich(lead.id, pc.key), `${pc.label} enrichment started`,
              `Enrich with ${pc.label}?`,
              `${who(lead)}. Forces the ${pc.label} provider directly (${pc.hint}). Consumes provider credits per lookup.`,
              `Enrich via ${pc.label}`) })),
            { label: 'Verify contact', section: 'Outreach', icon: <BadgeCheck />, disabled: done, onSelect: () => confirmAct(lead.id, 'verify', () => leadsApi.verify(lead.id), 'Verification started',
              'Verify contact?',
              `${who(lead)}. Checks email deliverability and WhatsApp registration. Results are recorded in the verification log.`,
              'Verify') },
            { label: 'Draft outreach', section: 'Outreach', icon: <FileText />, disabled: done, onSelect: () => confirmAct(lead.id, 'draft', () => leadsApi.draft(lead.id, 'both'), 'Draft started',
              'Generate outreach draft?',
              `${who(lead)}. Drafts with Gemini from verified lead context only — nothing is invented, and nothing is sent until you approve.`,
              'Generate draft') },
            { label: 'Verify & send', section: 'Outreach', icon: <Send />, hint: !emailOk && !waOk ? 'verify first' : undefined, disabled: done || (!emailOk && !waOk), onSelect: () => confirmAct(lead.id, 'send', () => leadsApi.verifyAndSend(lead.id, 'both'), 'Verify & send queued',
              'Verify and send now?',
              `${who(lead)}. Verifies first, then SENDS a real message to the HR contact. Sent messages cannot be unsent.`,
              'Verify & send', 'destructive') },
            { label: 'Send message', section: 'Outreach', icon: <Mail />, hint: !emailOk && !waOk ? 'verify first' : undefined, disabled: done || (!emailOk && !waOk), onSelect: () => confirmAct(lead.id, 'send', () => leadsApi.send(lead.id, 'both'), 'Send queued',
              'Send message now?',
              `${who(lead)}. SENDS a real email/WhatsApp message to the HR contact. Sent messages cannot be unsent.`,
              'Send now', 'destructive') },
            ...((lead as any).hr_email ? [{ label: 'Copy HR email', section: 'Manage', icon: <Copy />, onSelect: () => { navigator.clipboard?.writeText((lead as any).hr_email); toast({ title: 'Email copied', variant: 'success' }); } }] : []),
            { label: lead.do_not_contact ? 'Allow contact again' : 'Mark Do-Not-Contact', section: 'Manage', icon: <XCircle />, danger: !lead.do_not_contact, onSelect: () => confirmAct(lead.id, 'dnc', () => leadsApi.setDoNotContact(lead.id, !lead.do_not_contact), lead.do_not_contact ? 'Contact allowed' : 'Marked do-not-contact',
              lead.do_not_contact ? 'Allow contact again?' : 'Mark do-not-contact?',
              lead.do_not_contact
                ? `${who(lead)}. The lead re-enters outreach eligibility.`
                : `${who(lead)}. It will be excluded from all outreach until re-allowed. Reversible.`,
              lead.do_not_contact ? 'Allow contact' : 'Suppress lead') },
          ]} />
        </div>
      );
    } }),
  ], [leadRows, selectedIds, expanded, visibility, density, navigate, toast, busy, isAdmin]);

  const table = useReactTable({
    data: leadRows, columns, state: { sorting, columnFilters, globalFilter, pagination, columnVisibility: visibility },
    onSortingChange: setSorting, onColumnFiltersChange: setColumnFilters, onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: setPagination, onColumnVisibilityChange: setVisibility,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getFilteredRowModel: getFilteredRowModel(), getPaginationRowModel: getPaginationRowModel(),
    manualPagination: true, manualSorting: true, manualFiltering: true, pageCount: leadData.pagination?.pages ?? 0,
  });

  if (isLoading) return <PageLoader label="Loading leads..." />;
  if (isError) return <ErrorState title="Error loading leads" message={(error as Error).message} onRetry={() => (error instanceof Error && error.message?.includes('401') ? (navigate('/login')) : refetch())} />;

  const pad = density === 'compact' ? 'py-1.5' : 'py-3.5';

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Workspace" title="Leads" description="Your full India-fresher intelligence table — enrich, verify and draft any lead, one at a time or in bulk" actions={
        <>
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input value={globalFilter} onChange={(e) => setGlobalFilter(e.target.value)} placeholder="Search company, title, HR, email, source, city…" className="input pl-9" />
          </div>
          {armyMutation.isPending || stopMutation.isPending ? (
            <Button variant="outline" loading disabled title="Army action in flight">
              <Zap className="h-4 w-4" />Working…
            </Button>
          ) : queued > 0 ? (
            <Button variant="destructive" onClick={() => setArmyStopConfirmOpen(true)} title="Stop the running army — in-flight sources cancel, queued scrape jobs are discarded">
              <Square className="h-4 w-4" />Stop · {queued} running
            </Button>
          ) : (
            <Button variant="outline" onClick={() => setArmyConfirmOpen(true)} title="Scrape every source and auto-enrich all leads">
              <Zap className="h-4 w-4" />Run Army
            </Button>
          )}
        </>
      } />
      <ConfirmDialog
        open={armyStopConfirmOpen}
        onClose={() => setArmyStopConfirmOpen(false)}
        onConfirm={() => stopMutation.mutate()}
        title="Stop the running army?"
        description={`In-flight source scrapes cancel within seconds — already-scraped leads are kept. Queued scrape jobs are discarded. ${queued} lead${queued === 1 ? '' : 's'} already in the pipeline keep processing to completion.`}
        confirmLabel="Stop Army"
        confirmVariant="destructive"
        loading={stopMutation.isPending}
      />
      <ConfirmDialog
        open={armyConfirmOpen}
        onClose={() => setArmyConfirmOpen(false)}
        onConfirm={() => armyMutation.mutate()}
        title="Run Data Collection Army?"
        description={`Sources to run: all configured. ${queued} lead${queued === 1 ? '' : 's'} currently in flight. Enrichment (OSINT → paid providers) fires where keys exist and may consume credits. This starts a long-running background job — safe to leave the page; progress streams live in the toolbar.`}
        confirmLabel="Run Army"
        confirmVariant="default"
        loading={armyMutation.isPending}
      />

      {/* toolbar */}
      <div className="card flex flex-wrap items-center gap-2 p-3">
        <Select value={experienceFilter} onChange={(e) => setExperienceFilter(e.target.value as never)} className="w-40" aria-label="Experience"><option value="">All experience</option><option value="fresher">Fresher</option><option value="0-1yr">0-1 years</option><option value="0-2yr">0-2 years</option><option value="no-experience">No experience</option></Select>
        <Select value={workplaceFilter} onChange={(e) => setWorkplaceFilter(e.target.value as never)} className="w-32" aria-label="Workplace"><option value="">All workplaces</option><option value="remote">Remote</option><option value="onsite">On-site</option><option value="hybrid">Hybrid</option></Select>
        <Select value={salaryFilter} onChange={(e) => setSalaryFilter(e.target.value as never)} className="w-36" aria-label="Salary"><option value="">Any salary</option><option value="any">Salary disclosed</option><option value="5">₹5L+</option><option value="10">₹10L+</option><option value="20">₹20L+</option></Select>
        <Select value={scoreBand || ''} onChange={(e) => setColumnFilters((f) => [...f.filter((x) => x.id !== 'score_band'), ...(e.target.value ? [{ id: 'score_band', value: e.target.value }] : [])])} className="w-32" aria-label="Score"><option value="">All scores</option><option value="hot">Hot 7–10</option><option value="warm">Warm 4–6</option><option value="cold">Cold 1–3</option></Select>
        <Select value={freshnessFilter} onChange={(e) => { setFreshnessFilter(e.target.value as any); setPagination((p) => ({ ...p, pageIndex: 0 })); }} className="w-36" aria-label="Freshness"><option value="">All freshness</option><option value="fresh">&lt;24 hrs</option><option value="recent">&lt;7 days</option><option value="older">Older</option><option value="unknown">Unknown</option></Select>
        <Select value={pipelineStage || ''} onChange={(e) => setColumnFilters((f) => [...f.filter((x) => x.id !== 'pipeline_stage'), ...(e.target.value ? [{ id: 'pipeline_stage', value: e.target.value }] : [])])} className="w-40" aria-label="Stage"><option value="">All stages</option><option value="discovered">New</option><option value="enriched">Enriched</option><option value="verified">Verified</option><option value="drafted">Ready to send</option><option value="contacted">Sent</option><option value="replied">Replied</option><option value="bounced">Failed</option><option value="contact_unavailable">Needs enrichment</option><option value="verification_failed">Verify failed</option><option value="send_failed">Send failed</option><option value="suppressed">Suppressed</option></Select>
        <Select value={ownershipFilter} onChange={(e) => { setOwnershipFilter(e.target.value as never); setPagination((p) => ({ ...p, pageIndex: 0 })); }} className="w-36" aria-label="Owner"><option value="">All owners</option><option value="unclaimed">Unclaimed</option><option value="claimed">Claimed</option><option value="assigned">Assigned</option><option value="mine">Mine</option></Select>
        <Select value={contactFilter} onChange={(e) => { setContactFilter(e.target.value as any); setPagination((p) => ({ ...p, pageIndex: 0 })); }} className="w-36" aria-label="Contact"><option value="">All contacts</option><option value="none">No contact</option><option value="partial">Partial</option><option value="enriched">Enriched</option><option value="verified">Verified</option></Select>
        <Select value={dateFilter} onChange={(e) => { setDateFilter(e.target.value as any); setPagination((p) => ({ ...p, pageIndex: 0 })); }} className="w-36" aria-label="Discovered"><option value="">Any time</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option></Select>
        <input value={sourceFilter} onChange={(e) => { setSourceFilter(e.target.value); setPagination((p) => ({ ...p, pageIndex: 0 })); }} placeholder="Source…" className="input w-32" aria-label="Source" />
        <input value={cityFilter} onChange={(e) => { setCityFilter(e.target.value); setPagination((p) => ({ ...p, pageIndex: 0 })); }} placeholder="City…" className="input w-32" aria-label="City" />
        <input value={deptFilter} onChange={(e) => { setDeptFilter(e.target.value); setPagination((p) => ({ ...p, pageIndex: 0 })); }} placeholder="Department…" className="input w-36" aria-label="Department" />
        <div className="h-6 w-px bg-border" />
        <Menu align="start" ariaLabel="Columns" trigger={<Button variant="outline" size="sm"><Columns3 className="h-4 w-4" />Columns</Button>} items={ALL_COLUMNS.map((c) => ({ label: c.label, checked: visibility[c.id] !== false, onSelect: () => setVisibility((v) => ({ ...v, [c.id]: v[c.id] === false })) }))} />
        <Menu align="start" ariaLabel="Density" trigger={<Button variant="outline" size="sm" title={`Row density: ${density}`}><LayoutGrid className="h-4 w-4" />{density === 'compact' ? 'Compact' : 'Comfortable'}</Button>} items={[{ label: 'Comfortable', checked: density === 'comfortable', onSelect: () => setDensity('comfortable') }, { label: 'Compact', checked: density === 'compact', onSelect: () => setDensity('compact') }]} />
        <Menu
          align="start"
          ariaLabel="Export"
          trigger={<Button variant="outline" size="sm" loading={exporting}><Download className="h-4 w-4" />Export</Button>}
          items={[
            { label: 'Excel workbook — all filtered', onSelect: () => runExport('xls'), hint: `${LEAD_COLUMNS.length} columns + summary sheet` },
            { label: 'CSV — all filtered', onSelect: () => runExport('csv'), hint: 'same columns, plain text' },
            { label: `CSV — ${selectedIds.size} selected`, onSelect: exportSelectedCsv, disabled: selectedIds.size === 0 },
          ]}
        />
        <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}><Upload className="h-4 w-4" />Import</Button>
        <div className="ml-auto flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${queued > 0 ? 'border-success/40 bg-success/10 text-success' : 'border-border text-muted-foreground'}`}><Radar className={`h-3 w-3 ${queued > 0 ? 'animate-pulse' : ''}`} />{queued > 0 ? `${queued} processing` : 'idle'}</span>
          <Button variant="outline" size="sm" onClick={() => refetch()} loading={isFetching}><RefreshCw className="h-4 w-4" /></Button>
        </div>
      </div>

      {/* bulk bar */}
      <AnimatePresence>
        {selectedIds.size > 0 && (
          <motion.div initial={{ opacity: 0, y: -8, height: 0 }} animate={{ opacity: 1, y: 0, height: 'auto' }} exit={{ opacity: 0, y: -8, height: 0 }} className="overflow-hidden">
            <div className="card flex flex-wrap items-center gap-2.5 border-primary/30 bg-primary-soft/60 px-4 py-3">
              <Users className="h-4 w-4 text-primary" /><span className="text-sm font-medium">{selectedIds.size} selected</span>
              <div className="h-5 w-px bg-border" />
              <span className="text-xs text-muted-foreground">Enrich:</span>
              <Button variant="secondary" size="sm" onClick={() => setActionConfirm({ title: `Enrich ${selectedIds.size} leads?`, description: 'The engine picks OSINT first, then Snov.io, ContactOut and Apollo automatically. Paid lookups consume provider credits per lead.', confirmLabel: `Enrich ${selectedIds.size}`, run: () => { setActionConfirm(null); bulkEnrichMutation.mutate({ ids: Array.from(selectedIds), provider: 'auto' }); } })}><Sparkles className="h-3.5 w-3.5" />Enrich {selectedIds.size}</Button>
              <div className="h-5 w-px bg-border" />
              <span className="text-xs text-muted-foreground">Own:</span>
              <Button variant="secondary" size="sm" onClick={() => setActionConfirm({ title: `Claim ${selectedIds.size} leads?`, description: 'They become yours instantly and leave the shared claim pool. Leads already owned by someone else are skipped.', confirmLabel: `Claim ${selectedIds.size}`, run: () => { setActionConfirm(null); bulkClaimMutation.mutate(Array.from(selectedIds)); } })} loading={bulkClaimMutation.isPending}><Users className="h-3.5 w-3.5" />Claim {selectedIds.size}</Button>
              {isAdmin && <Button variant="secondary" size="sm" onClick={() => setBulkAssignOpen(true)}><Users className="h-3.5 w-3.5" />Assign {selectedIds.size}</Button>}
              <Select value={draftChannel} onChange={(e) => setDraftChannel(e.target.value as any)} className="h-8 w-32" aria-label="Channel"><option value="both">Both</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option></Select>
              <Button size="sm" onClick={() => setActionConfirm({ title: `Generate drafts for ${selectedIds.size} leads?`, description: 'Drafts are written by Gemini from verified lead context only. Nothing is sent until you review and approve each draft.', confirmLabel: 'Generate drafts', run: () => { setActionConfirm(null); bulkDraftMutation.mutate({ leadIds: Array.from(selectedIds), channel: draftChannel }); } })} loading={bulkDraftMutation.isPending}><Play className="h-3.5 w-3.5" />Draft</Button>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSelectedIds(new Set())}>Clear</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* table */}
      <div className="card overflow-hidden">
        <div className="max-h-[calc(100vh-280px)] overflow-auto">
          <table className="w-full border-separate border-spacing-0">
            <thead className="sticky top-0 z-20">
              {table.getHeaderGroups().map((hg) => (
                <tr key={hg.id}>
                  {hg.headers.map((header) => {
                    const canSort = header.column.getCanSort();
                    // Actions must stay reachable while the wide table scrolls sideways;
                    // otherwise every row's buttons sit off-screen on a laptop.
                    const pinRight = header.id === 'actions';
                    const active = header.column.getIsSorted();
                    return (
                      <th key={header.id} onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                          aria-sort={!canSort ? undefined : active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none'}
                          tabIndex={canSort ? 0 : undefined}
                          role={canSort ? 'button' : undefined}
                          onKeyDown={canSort ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); header.column.getToggleSortingHandler()?.(e); }
                          } : undefined} style={{ width: header.getSize() }} className={`${pinRight ? 'sticky right-0 z-30 bg-surface shadow-[-6px_0_10px_-8px_rgba(0,0,0,0.35)]' : ''} table-th sticky top-0 bg-surface/90 backdrop-blur-xl ${canSort ? 'cursor-pointer select-none hover:text-foreground' : ''}`}>
                        <span className="inline-flex items-center gap-1">
                          {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                          {canSort && <span className="inline-flex flex-col">{active === 'asc' ? <ChevronUp className="h-3 w-3 text-primary" /> : active === 'desc' ? <ChevronDown className="h-3 w-3 text-primary" /> : <ChevronUp className="h-3 w-3 opacity-30" />}</span>}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.length === 0 ? (
                <tr><td colSpan={columns.length} className="p-4"><EmptyState icon={Users} title="No leads found." description="Deploy the army to discover India fresher jobs, or adjust your search." action={<Button variant="outline" size="sm" onClick={() => setArmyConfirmOpen(true)}><Zap className="h-3.5 w-3.5" />Run Army</Button>} /></td></tr>
              ) : table.getRowModel().rows.map((row) => {
                const open = expanded.has(row.original.id);
                const lead: any = row.original;
                return (
                  <React.Fragment key={row.id}>
                    <tr onClick={() => toggleExpand(row.original.id)} className={`group cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-accent/50 ${selectedIds.has(row.original.id) ? 'bg-primary-soft/30' : ''}`}>
                      {row.getVisibleCells().map((cell) => <td key={cell.id} className={`table-td ${pad}${cell.column.id === 'actions' ? ' sticky right-0 z-20 bg-surface shadow-[-6px_0_10px_-8px_rgba(0,0,0,0.35)]' : ''}`}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}
                    </tr>
                    <AnimatePresence initial={false}>
                      {open && (
                        <tr>
                          <td colSpan={columns.length} className="border-b border-border p-0">
                            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25 }} className="overflow-hidden">
                              <div className="grid grid-cols-1 gap-4 bg-muted/30 px-6 py-4 md:grid-cols-3">
                                <DetailBlock title="Contact"><KV k="HR" v={lead.hr_name || '—'} /><KV k="Email" v={lead.hr_email} copyable mailto /><KV k="Phone" v={lead.hr_mobile} copyable /><KV k="LinkedIn" v={lead.hr_linkedin_url} link /></DetailBlock>
                                <DetailBlock title="Company & Job"><KV k="Company" v={lead.company_name} /><KV k="Domain" v={lead.company_domain} link /><KV k="Job" v={lead.job_title} /><KV k="Source" v={lead.source_site} /><KV k="Location" v={[lead.city, lead.state, lead.country].filter(Boolean).join(', ') || lead.location} /><KV k="Workplace" v={lead.location_type || (lead.is_work_from_home ? 'remote' : null)} /><KV k="Employment" v={lead.employment_type} /><KV k="Experience" v={lead.experience_level} /><KV k="Department" v={lead.department} /><KV k="Openings" v={lead.openings_count != null ? String(lead.openings_count) : undefined} /><KV k="Salary" v={lead.salary_range} /><KV k="Posted" v={lead.posted_at ? formatDate(lead.posted_at) : undefined} /><KV k="Apply URL" v={lead.apply_url || lead.job_url} link copyable /></DetailBlock>
                                <DetailBlock title="Pipeline">
                                  <KV k="Stage" v={lead.pipeline_stage?.replace(/_/g, ' ')} />
                                  <KV k="Email" v={lead.email_status} />
                                  <KV k="WhatsApp" v={lead.whatsapp_status} />
                                  <KV k="Owner" v={lead.assigned_to_email || lead.assigned_to} />
                                  <KV k="No-contact" v={lead.do_not_contact ? 'yes' : undefined} />
                                  <p className="pt-1 text-[11px] text-muted-foreground">Everything else lives under the row's Actions button.</p>
                                </DetailBlock>
                              </div>
                            </motion.div>
                          </td>
                        </tr>
                      )}
                    </AnimatePresence>
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {leadData.pagination && <div className="border-t border-border"><Pagination pagination={leadData.pagination} onPageChange={(p: number) => setPagination({ ...pagination, pageIndex: p - 1 })} /></div>}
      </div>

      <ImportLeadsModal open={importOpen} onClose={() => setImportOpen(false)} onDone={onImported} />

      {actionConfirm && (
        <ConfirmDialog
          open
          onClose={() => setActionConfirm(null)}
          onConfirm={() => actionConfirm.run()}
          title={actionConfirm.title}
          description={actionConfirm.description}
          confirmLabel={actionConfirm.confirmLabel}
          confirmVariant={actionConfirm.variant || 'default'}
        />
      )}

      {bulkAssignOpen && (
        <div className="fixed inset-0 z-overlay grid place-items-center bg-black/50 p-4" onClick={() => setBulkAssignOpen(false)}>
          <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-4 shadow-float" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Assign selected leads">
            <p className="mb-1 text-sm font-semibold">Assign {selectedIds.size} leads to</p>
            <input value={memberSearch} onChange={(e) => setMemberSearch(e.target.value)} placeholder="Search member…" className="input mb-2" aria-label="Search member" />
            <div className="max-h-64 space-y-1 overflow-auto">
              {members.filter((m) => m.email.toLowerCase().includes(memberSearch.toLowerCase())).map((m) => (
                <button key={m.id} onClick={() => setActionConfirm({ title: `Assign ${selectedIds.size} leads to ${m.email}?`, description: 'Ownership moves immediately; the previous owner loses access unless they are admin. Reversible by reassigning.', confirmLabel: 'Assign leads', run: () => { setActionConfirm(null); setBulkAssignOpen(false); bulkAssignMutation.mutate({ ids: Array.from(selectedIds), userId: m.id }); } })} className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-accent">
                  <span className="min-w-0 flex-1 truncate">{m.email}</span>
                  <span className="text-xs capitalize text-muted-foreground">{m.role}</span>
                </button>
              ))}
              {members.length === 0 && <p className="text-xs text-muted-foreground">No members found.</p>}
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setBulkAssignOpen(false)}>Cancel</Button>
            </div>
          </div>
        </div>
      )}

      {assignLead && (
        <div className="fixed inset-0 z-overlay grid place-items-center bg-black/50 p-4" onClick={() => setAssignLead(null)}>
          <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-4 shadow-float" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Assign lead">
            <p className="mb-1 text-sm font-semibold">Assign to</p>
            <p className="mb-3 truncate text-xs text-muted-foreground">{(assignLead as any).company_name || 'lead'}</p>
            <input value={memberSearch} onChange={(e) => setMemberSearch(e.target.value)} placeholder="Search member…" className="input mb-2" aria-label="Search member" />
            <div className="max-h-64 space-y-1 overflow-auto">
              {members.filter((m) => m.email.toLowerCase().includes(memberSearch.toLowerCase())).map((m) => (
                <button key={m.id} onClick={() => setActionConfirm({ title: `Assign lead to ${m.email}?`, description: `${(assignLead as any)?.company_name || 'This lead'} moves to ${m.email} immediately. Reversible by reassigning.`, confirmLabel: 'Assign lead', run: () => { setActionConfirm(null); if (assignLead) assignMutation.mutate({ id: assignLead.id, userId: m.id }); } })} className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-accent">
                  <span className="min-w-0 flex-1 truncate">{m.email}</span>
                  <span className="text-xs capitalize text-muted-foreground">{m.role}</span>
                </button>
              ))}
              {members.length === 0 && <p className="text-xs text-muted-foreground">No members found.</p>}
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setAssignLead(null)}>Cancel</Button>
              <Button size="sm" loading={assignMutation.isPending} onClick={() => assignLead && assignMutation.mutate({ id: assignLead.id, userId: null })}>Unassign</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function DetailBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p><div className="space-y-1">{children}</div></div>;
}

function KV({ k, v, link, mailto, copyable }: { k: string; v?: string | null; link?: boolean; mailto?: boolean; copyable?: boolean }) {
  const [copied, setCopied] = useState(false);
  const show = v && v !== '—';
  return (
    <div className="flex items-center gap-2 text-[13px]">
      <span className="w-16 shrink-0 text-muted-foreground">{k}</span>
      {show && link ? <a href={v!.startsWith('http') ? v : `https://${v}`} target="_blank" rel="noreferrer" className="truncate text-info hover:underline">{v}</a>
        : show && mailto ? <a href={`mailto:${v}`} className="truncate text-info hover:underline">{v}</a>
        : <span className="truncate text-foreground">{v || '—'}</span>}
      {show && copyable && <button onClick={() => { navigator.clipboard?.writeText(v!); setCopied(true); setTimeout(() => setCopied(false), 1200); }} className="shrink-0 text-muted-foreground hover:text-foreground" title="Copy">{copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}</button>}
    </div>
  );
}

export default Leads;
