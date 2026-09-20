import React, { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { leads as leadsApi, admin } from '@/lib/api';
import { LeadDetail as LeadDetailType, OutreachDraft } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { PageLoader } from '@/components/ui/spinner';
import { ErrorState } from '@/components/ui/error-state';
import { EmptyState } from '@/components/ui/empty-state';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/components/ui/toast';
import { useSSE, shouldRefreshLeadDetail } from '@/hooks/useSSE';
import {
  ArrowLeft,
  Sparkles,
  BadgeCheck,
  FileText,
  Send,
  UserPlus,
  User,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Loader2,
  Link2,
  Briefcase,
  Mail,
  Phone,
  Globe,
  Building2,
  ExternalLink,
  AlertTriangle,
} from 'lucide-react';
import {
  SCORE_BAND_META,
  stageMeta,
  emailStatusMeta,
  whatsappStatusMeta,
  DATA_QUALITY_META,
  formatDateTime,
  formatDate,
} from '@/lib/format';
import { score10 } from '@/lib/freshness';

type EditingState = {
  draftId: string;
  subject: string;
  body: string;
} | null;

const TIMELINE_TYPE_LABELS: Record<string, string> = {
  created: 'Lead discovered',
  enrichment_started: 'Enrichment started',
  enrichment_completed: 'Enrichment completed',
  verification_completed: 'Verification completed',
  draft_generated: 'Draft generated',
  draft_edited: 'Draft edited',
  send_completed: 'Message sent',
  replied: 'Lead replied',
  bounced: 'Message bounced',
  assigned: 'Lead assigned',
  do_not_contact: 'Do-not-contact updated',
};

const LeadDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const {
    data,
    isLoading,
    error: leadError,
    refetch,
  } = useQuery(['lead', id], () => leadsApi.get(id!), { enabled: !!id });

  const { data: timelineData } = useQuery(['lead-timeline', id], () => leadsApi.timeline(id!), {
    enabled: !!id,
  });

  const { data: scoreData } = useQuery(['lead-score', id], () => leadsApi.scoreExplanation(id!), {
    enabled: !!id,
  });

  const { data: usersData } = useQuery('users-list', () => admin.getUsers(), {
    // /admin/users is admin-only; don't fire it as sales_rep (was a 403 + console error).
    enabled: !!id && useAuthStore.getState().user?.role === 'admin',
    retry: false,
  });

  const { data: providerStatus } = useQuery(
    'provider-status',
    () => admin.providerStatus(),
    { enabled: !!id, staleTime: 60000, retry: false },
  );
  const enrichmentReady = providerStatus?.enrichment as Record<string, boolean> | undefined;
  const sendingReady = providerStatus?.sending;

  // Live enrichment lifecycle: poll the persistent job while it is active so
  // the operator sees Queued → Running → Completed/Partial/Failed instead of
  // a fire-and-forget button. Polling stops on terminal states.
  const { data: enrichmentState } = useQuery(
    ['lead-enrichment', id],
    () => leadsApi.enrichment(id!),
    {
      enabled: !!id,
      retry: false,
      refetchInterval: (data: any) => {
        const jobs = data?.jobs || [];
        const active = jobs.some((j: any) => j.status === 'queued' || j.status === 'running');
        return active ? 4000 : false;
      },
    },
  );
  const activeJob = (enrichmentState?.jobs || []).find((j: any) => j.status === 'queued' || j.status === 'running');
  const lastJob = (enrichmentState?.jobs || [])[0];

  // Backend -> frontend: live updates for this lead (enrich/verify/draft/send
  // completing elsewhere refresh the detail, timeline and score in place).
  // Scoped to THIS lead's lifecycle events only — heartbeats, connects and
  // other leads' events must not refetch (was a refetch storm).
  useSSE('/sse/token', (event) => {
    if (shouldRefreshLeadDetail(event, id)) {
      queryClient.invalidateQueries(['lead', id]);
      queryClient.invalidateQueries(['lead-timeline', id]);
      queryClient.invalidateQueries(['lead-score', id]);
      queryClient.invalidateQueries(['lead-enrichment', id]);
    }
  });

  const [editing, setEditing] = useState<EditingState>(null);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractProvider, setExtractProvider] = useState<'contactout' | 'snovio' | 'osint' | undefined>(undefined);
  const [pendingSend, setPendingSend] = useState<{ channel: string; draftId?: string } | null>(null);
  // Universal confirmation for consequential actions (claim/verify/draft/assign/suppress).
  const [confirmStep, setConfirmStep] = useState<{
    title: string; description: string; confirmLabel: string;
    variant?: 'destructive' | 'default'; run: () => void;
  } | null>(null);
  const [sending, setSending] = useState(false);

  const editDraftMutation = useMutation(
    ({ leadId, draftId, patch }: { leadId: string; draftId: string; patch: { subject?: string; body?: string } }) =>
      leadsApi.editDraft(leadId, draftId, patch),
    {
      onSuccess: () => {
        queryClient.invalidateQueries(['lead', id]);
        toast({ title: 'Draft saved', variant: 'success' });
      },
      onError: (err) => toast({ title: 'Failed to save draft', description: (err as Error).message, variant: 'error' }),
    },
  );

  const doNotContactMutation = useMutation(
    ({ leadId, value }: { leadId: string; value: boolean }) => leadsApi.setDoNotContact(leadId, value),
    {
      onSuccess: () => {
        queryClient.invalidateQueries(['lead', id]);
        queryClient.invalidateQueries('dashboard-stats');
      },
      onError: (err) => toast({ title: 'Failed to update preference', description: (err as Error).message, variant: 'error' }),
    },
  );

  const assignMutation = useMutation(
    ({ leadId, userId }: { leadId: string; userId: string | null }) => leadsApi.assign(leadId, userId),
    {
      onSuccess: () => {
        queryClient.invalidateQueries(['lead', id]);
        setShowAssignModal(false);
        toast({ title: 'Lead assigned', variant: 'success' });
      },
      onError: (err) => toast({ title: 'Assignment failed', description: (err as Error).message, variant: 'error' }),
    },
  );

  const enrichMutation = useMutation(
    ({ leadId, provider }: { leadId: string; provider?: string }) => leadsApi.enrich(leadId, provider),
    {
      onSuccess: () => {
        setExtracting(false);
        queryClient.invalidateQueries(['lead', id]);
        queryClient.invalidateQueries(['lead-timeline', id]);
        queryClient.invalidateQueries(['lead-enrichment', id]);
        toast({ title: 'HR extraction started', description: 'Watch the live status badge — no need to refresh.', variant: 'success' });
      },
      onError: (err) => {
        setExtracting(false);
        toast({ title: 'Extraction failed', description: (err as Error).message, variant: 'error' });
      },
    },
  );

  // All hooks above the early returns: anything below `if (isLoading) return`
  // renders conditionally and breaks hook order (React #310).
  const claimMutation = useMutation(() => leadsApi.claim(id!), {
    onSuccess: () => {
      queryClient.invalidateQueries(['lead', id]);
      queryClient.invalidateQueries(['lead-timeline', id]);
      toast({ title: 'Lead claimed', variant: 'success' });
    },
    onError: (e) => toast({ title: 'Claim failed', description: (e as Error).message, variant: 'error' }),
  });

  if (isLoading) return <PageLoader label="Loading lead..." />;

  if (leadError) {
    const isAuthError = leadError instanceof Error && leadError.message?.includes('401');
    return (
      <ErrorState
        title="Error loading lead"
        message={leadError instanceof Error ? leadError.message : 'Unknown error'}
        onRetry={() => {
          if (isAuthError) {
            useAuthStore.getState?.()?.logout?.();
            navigate('/login');
          } else {
            refetch();
          }
        }}
        retryLabel={isAuthError ? 'Re-login' : 'Retry'}
      />
    );
  }

  const lead: LeadDetailType = data.lead;
  const timeline = (timelineData as any)?.timeline || [];
  const users = (usersData as any)?.users || [];

  const startEditing = (draft: OutreachDraft) => {
    // Restore an unsent local backup first (reload-proof editing).
    let backup = null;
    try {
      const raw = localStorage.getItem(`draft-backup:${lead.id}:${draft.id}`);
      backup = raw ? JSON.parse(raw) : null;
    } catch { /* corrupted backup: fall through to server draft */ }
    setEditing({
      draftId: draft.id,
      subject: backup?.subject ?? draft.subject ?? '',
      body: backup?.body ?? draft.body ?? '',
    });
  };

  const updateEditing = (patch: Partial<{ subject: string; body: string }>) => {
    setEditing((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(`draft-backup:${lead.id}:${prev.draftId}`, JSON.stringify({
          subject: next.subject, body: next.body, savedAt: Date.now(),
        }));
      } catch { /* storage full/blocked: editing still works in memory */ }
      return next;
    });
  };

  const clearBackup = (draftId: string) => {
    try {
      localStorage.removeItem(`draft-backup:${lead.id}:${draftId}`);
    } catch { /* ignore */ }
  };

  const saveEditing = () => {
    if (!editing) return;
    editDraftMutation.mutate(
      { leadId: lead.id, draftId: editing.draftId, patch: { subject: editing.subject, body: editing.body } },
      { onSuccess: () => { clearBackup(editing.draftId); setEditing(null); } },
    );
  };

  const handleEnrich = () => {
    const providerLabel = extractProvider === 'contactout' ? 'ContactOut'
      : extractProvider === 'snovio' ? 'Snov.io'
      : extractProvider === 'osint' ? 'OSINT (free)' : 'Auto (OSINT → Snov → ContactOut → Apollo)';
    setConfirmStep({
      title: `Enrich with ${providerLabel}?`,
      description: `${lead.company_name || 'This lead'}${lead.job_title ? ` · ${lead.job_title}` : ''}. Free OSINT runs first; paid providers consume credits per lookup where keys exist. Safe to re-run; verified contacts are never overwritten.`,
      confirmLabel: 'Enrich',
      run: () => {
        setExtracting(true);
        enrichMutation.mutate({ leadId: lead.id, provider: extractProvider });
      },
    });
  };

  const runAction = (fn: Promise<unknown>, successMsg: string) => {
    fn.then(() => {
      queryClient.invalidateQueries(['lead', id]);
      queryClient.invalidateQueries(['lead-timeline', id]);
      toast({ title: successMsg, variant: 'success' });
    }).catch((err: Error) => toast({ title: 'Action failed', description: err.message, variant: 'error' }));
  };

  const handleDoNotContactChange = (value: boolean) => {
    setConfirmStep({
      title: value ? 'Mark do-not-contact?' : 'Allow contact again?',
      description: value
        ? `${lead.company_name || 'This lead'} will be excluded from all outreach until re-allowed. Reversible.`
        : `${lead.company_name || 'This lead'} re-enters outreach eligibility.`,
      confirmLabel: value ? 'Suppress lead' : 'Allow contact',
      run: () => doNotContactMutation.mutate({ leadId: lead.id, value }),
    });
  };

  const confirmSend = () => {
    if (!pendingSend) return;
    setSending(true);
    leadsApi.send(lead.id, pendingSend.channel as any, pendingSend.draftId)
      .then(() => {
        queryClient.invalidateQueries(['lead', id]);
        queryClient.invalidateQueries(['lead-timeline', id]);
        toast({ title: 'Send queued — provider result will update the timeline', variant: 'success' });
        setPendingSend(null);
      })
      .catch((err: Error) => toast({ title: 'Send blocked', description: err.message, variant: 'error' }))
      .finally(() => setSending(false));
  };

  const sendBlockReason = lead.do_not_contact
    ? 'This lead is flagged Do Not Contact — sending is blocked.'
    : null;

  const handleAssign = (userId: string) => {
    const target = userId ? users.find((u: any) => u.id === userId) : null;
    setShowAssignModal(false);
    setConfirmStep({
      title: target ? `Assign lead to ${target.email}?` : 'Unassign this lead?',
      description: `${lead.company_name || 'This lead'}${lead.job_title ? ` · ${lead.job_title}` : ''} moves ${target ? `to ${target.email}` : 'back to the unassigned pool'} immediately. Reversible by reassigning.`,
      confirmLabel: target ? 'Assign lead' : 'Unassign',
      run: () => assignMutation.mutate({ leadId: lead.id, userId: userId || null }),
    });
  };

  const assignedUser = users.find((u: any) => u.id === lead.assigned_to);
  const currentUserId = useAuthStore.getState().user?.id;
  const isAdmin = useAuthStore.getState().user?.role === 'admin';
  const shortMail = (v: unknown) => String(v).split('@')[0];
  const claimedEmail = (lead as any).claimed_by_email;
  const assignedEmail = assignedUser?.email || (lead as any).assigned_to_email;
  const ownershipLabel = claimedEmail && assignedEmail && claimedEmail !== assignedEmail
    ? `Claimed by ${shortMail(claimedEmail)} · Assigned to ${shortMail(assignedEmail)}`
    : assignedEmail
      ? `Assigned to ${assignedEmail === currentUserId || lead.assigned_to === currentUserId ? 'you' : shortMail(assignedEmail)}`
      : claimedEmail
        ? `Claimed by ${lead.claimed_by === currentUserId || (lead as any).claimed_by === currentUserId ? 'you' : shortMail(claimedEmail)}`
        : assignedEmail || 'Unassigned';
  const assignedLabel = ownershipLabel;
  const bandMeta = SCORE_BAND_META[lead.score_band];
  const stageMetaV = stageMeta(lead.pipeline_stage);
  const emailMeta = emailStatusMeta(lead.email_status);
  const waMeta = whatsappStatusMeta(lead.whatsapp_status);
  const dqMeta = DATA_QUALITY_META[lead.data_quality];

  const providerNote =
    extractProvider === 'contactout'
      ? `ContactOut uses LinkedIn URL to find email/phone. Highest accuracy. Per-row manual trigger — 1 credit only when YOU click Enrich, never bulk, never automatic.${enrichmentReady?.contactout === false ? ' Key missing.' : ''}`
      : extractProvider === 'snovio'
        ? `Snov.io uses company name + HR name to find email/phone. Good fallback. Per-row manual trigger — credits only on your click.${enrichmentReady?.snovio === false ? ' Key missing.' : ''}`
        : extractProvider === 'osint'
          ? 'OSINT fallback searches public sources for contact info. Lowest confidence. Free — no credits.'
          : 'Auto: OSINT → Snov.io → ContactOut → Apollo. Free sources first, paid only for missing fields. No credits consumed until you click Enrich.';

// Values that behave like enums (single word, safe to title-case for display).
const ENUM_LIKE_KEYS = new Set([
  'Workplace', 'Employment', 'Experience', 'Openings', 'Posted',
  'Contact confidence', 'Last updated', 'Data quality', 'Stage',
  'Score', 'Band', 'Pipeline Stage', 'Email Status', 'WhatsApp Status',
]);

  return (
    <div className="space-y-phi4">
      <div>
        <Link to="/leads" className="mb-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Back to leads
        </Link>

        <div className="card overflow-hidden">
          <div className="border-b border-border bg-sage-soft/50 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge className={bandMeta.className} title={`Engine score ${lead.lead_score}/100`}>
                    Score {score10(lead.lead_score)}/10 · {bandMeta.label}
                  </Badge>
                  <Badge className={stageMetaV.className}>
                    <span className="capitalize">{stageMetaV.label}</span>
                  </Badge>
                  {lead.do_not_contact && (
                    <Badge variant="danger">
                      <ShieldAlert className="h-3 w-3" />
                      Do Not Contact
                    </Badge>
                  )}
                </div>
                <h1 className="text-2xl font-semibold tracking-tight">{lead.company_name || 'Untitled lead'}</h1>
                <p className="mt-1 text-[15px] text-muted-foreground">
                  {lead.job_title || 'Job title not available'}
                  {lead.experience_level && <span className="text-muted-foreground/70"> · {lead.experience_level}</span>}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={handleEnrich} loading={extracting || enrichMutation.isLoading} variant="secondary" title="One-click enrich: OSINT → Snov → ContactOut → Apollo automatically">
                  <Sparkles className="h-4 w-4" />
                  {extracting ? 'Enriching…' : 'Enrich'}
                </Button>
                {activeJob ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-info/40 bg-info/10 px-2.5 py-1 text-[11px] font-medium text-info" title={`Provider: ${activeJob.provider}`}>
                    <Loader2 className="h-3 w-3 animate-spin" />Enrichment {activeJob.status} · {activeJob.current_stage}
                  </span>
                ) : lastJob ? (
                  <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${lastJob.status === 'completed' ? 'border-success/40 bg-success/10 text-success' : lastJob.status === 'partial' ? 'border-warning/40 bg-warning/10 text-warning' : 'border-border text-muted-foreground'}`} title={`Provider: ${lastJob.provider}`}>
                    {lastJob.status === 'completed' && <CheckCircle2 className="h-3 w-3" />}Enriched · {lastJob.status} via {lastJob.provider}
                  </span>
                ) : null}
                {!(lead as any).claimed_by && !lead.assigned_to && (
                  <Button onClick={() => setConfirmStep({ title: 'Claim this lead?', description: `${lead.company_name || 'This lead'}${lead.job_title ? ` · ${lead.job_title}` : ''} becomes yours instantly and leaves the shared claim pool. Another admin can reassign it later.`, confirmLabel: 'Claim lead', run: () => claimMutation.mutate() })} loading={claimMutation.isLoading} variant="outline">
                    <UserPlus className="h-4 w-4" />
                    Claim Lead
                  </Button>
                )}
                <Button
                  onClick={() => setConfirmStep({ title: 'Verify contact?', description: `${lead.company_name || 'This lead'}: checks email deliverability and WhatsApp registration. Results are recorded in the verification log.`, confirmLabel: 'Verify', run: () => runAction(leadsApi.verify(lead.id), 'Verification completed') })}
                  disabled={lead.pipeline_stage === 'verified' || lead.pipeline_stage === 'discovered'}
                  variant="outline"
                >
                  <BadgeCheck className="h-4 w-4" />
                  Verify
                </Button>
                <Button
                  onClick={() => setConfirmStep({ title: 'Generate outreach draft?', description: `${lead.company_name || 'This lead'}: drafted with Gemini from verified context only — nothing is sent until you approve.`, confirmLabel: 'Generate draft', run: () => runAction(leadsApi.draft(lead.id, 'both'), 'Draft generated') })}
                  disabled={lead.pipeline_stage === 'drafted'}
                  variant="outline"
                >
                  <FileText className="h-4 w-4" />
                  Draft
                </Button>
                <Button
                  onClick={() => setPendingSend({ channel: 'both' })}
                  disabled={(lead.pipeline_stage !== 'drafted' && lead.pipeline_stage !== 'verified') || !!sendBlockReason}
                  title={sendBlockReason || 'Verify + preview before sending'}
                  variant="default"
                >
                  <Send className="h-4 w-4" />
                  Send
                </Button>
                {isAdmin && (
                  <Button onClick={() => setShowAssignModal(true)} variant="ghost">
                    <UserPlus className="h-4 w-4" />
                    Assign
                  </Button>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 text-[13px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Briefcase className="h-3.5 w-3.5" />
              {lead.source_site ? <span className="capitalize">{lead.source_site}</span> : 'Source unknown'}
            </span>
            {lead.company_domain && (
              <span className="inline-flex items-center gap-1.5">
                <Globe className="h-3.5 w-3.5" />
                {lead.company_domain}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <User className="h-3.5 w-3.5" />
              {assignedLabel}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-success" />
              Discovered {formatDateTime(lead.created_at)}
            </span>
          </div>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Extraction Settings
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {[
              { value: undefined, label: 'Auto (OSINT → Snov.io → ContactOut → Apollo)', key: undefined },
              { value: 'contactout', label: 'ContactOut', key: 'contactout' },
              { value: 'snovio', label: 'Snov.io', key: 'snovio' },
              { value: 'osint', label: 'OSINT first', key: 'osint' },
            ].map((opt) => {
              // Paid providers show live configured/NOT-CONFIGURED state;
              // OSINT/Auto need no key. Keys are never exposed — booleans only.
              const needsKey = opt.key === 'contactout' || opt.key === 'snovio';
              const ready = !needsKey || (opt.key && enrichmentReady?.[opt.key]);
              return (
                <button
                  key={opt.label}
                  onClick={() => setExtractProvider(opt.value as never)}
                  title={needsKey && !ready ? `${opt.label} API key not configured — runs but cannot spend credits` : `${opt.label} — per-row, on-demand only`}
                  className={`rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
                    extractProvider === opt.value
                      ? 'border-primary bg-primary-soft text-primary'
                      : 'border-border bg-background text-muted-foreground hover:border-foreground/20 hover:text-foreground'
                  }`}
                >
                  {opt.label}
                  {needsKey && (
                    <span className={`ml-1.5 text-[11px] font-semibold ${ready ? 'text-success' : 'text-warning'}`}>
                      {ready ? '●' : '○'}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {providerNote && <p className="mt-3 text-[13px] text-muted-foreground">{providerNote}</p>}
          {extractProvider && (extractProvider === 'contactout' || extractProvider === 'snovio') && enrichmentReady?.[extractProvider] === false && (
            <p className="mt-2 text-[13px] font-medium text-warning">
              ACTION REQUIRED: no {extractProvider === 'contactout' ? 'ContactOut' : 'Snov.io'} key configured — enriching with it will fail honestly. Add a key in Settings or use Auto/OSINT.
            </p>
          )}
          {extracting && (
            <div className="mt-4 flex items-center gap-2.5 rounded-lg border border-primary/20 bg-primary-soft px-4 py-3 text-[13px] text-primary animate-fade-in">
              <Loader2 className="h-4 w-4 animate-spin" />
              Extracting HR contact… This may take a few moments.
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-phi3 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Lead Info</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-border text-[13px]">
              {[
                ['Score', `${score10(lead.lead_score)}/10 (${lead.score_band})`],
                ['Stage', lead.pipeline_stage],
                ['Data quality', dqMeta?.label || '—'],
                ['Email', lead.hr_email || '—'],
                ['Phone', lead.hr_mobile || '—'],
                ['Experience', lead.experience_level || '—'],
                ['Salary range', lead.salary_range || '—'],
                ['Source site', lead.source_site || '—'],
              ].map(([k, v]) => (
                <div key={k} className="flex items-start justify-between gap-4 py-2.5">
                  <dt className="text-muted-foreground">{k}</dt>
                  {/* Emails, URLs and salary strings are mangled by CSS capitalize;
                      only enum-like labels are safe to title-case. */}
                  <dd className={`text-right font-medium text-foreground${
                    ENUM_LIKE_KEYS.has(k as string) ? ' capitalize' : ''}`}>{v}</dd>
                </div>
              ))}
              {/* Posting facets the scrapers captured but never surfaced. Applied
                  conditionally so a missing value shows nothing rather than a row
                  of dashes. */}
              {[
                ['Location', [lead.city, lead.state, lead.country].filter(Boolean).join(', ') || lead.location],
                ['Workplace', lead.location_type || (lead.is_work_from_home ? 'remote' : null)],
                ['Employment', lead.employment_type],
                ['Country', lead.country],
                ['Salary', [lead.salary_min, lead.salary_max].filter((n) => n != null).length
                  ? `${lead.salary_currency === 'INR' || !lead.salary_currency ? '₹' : lead.salary_currency + ' '}` +
                    [lead.salary_min, lead.salary_max].filter((n) => n != null)
                      .map((n: any) => Math.round(Number(n)).toLocaleString('en-IN')).join('-') +
                    (lead.salary_period ? ` / ${lead.salary_period}` : '')
                  : null],
                ['Department', lead.department],
                ['Openings', lead.openings_count != null ? String(lead.openings_count) : null],
                ['Posted', lead.posted_at ? formatDate(lead.posted_at) : null],
                // How sure we are that this contact is really the person at this
                // company -- reps use it to decide whether to email or re-verify.
                ['Contact confidence', lead.hr_confidence != null
                  ? `${Math.round(Number(lead.hr_confidence))}${Number(lead.hr_confidence) <= 1 ? '%' : ''}` : null],
                ['Last updated', lead.updated_at ? formatDate(lead.updated_at) : null],
                // Compliance fields: populated on every lead yet never shown, so a
                // rep could not see the lawful basis for contacting someone or that
                // this row duplicates another one.
                // assignedLabel was computed from the users list for a long time and
                // never rendered, so ownership was invisible on the detail page.
                ['Owner', assignedLabel && assignedLabel !== 'Unassigned'
                  && !/^[0-9a-f-]{36}$/.test(assignedLabel) ? assignedLabel : null],
                ['Legal basis', lead.legal_basis],
                ['Processing purpose', lead.processing_purpose],
                ['Website', lead.website_url],
                ['Company email', lead.default_email],
                ['Company phone', lead.default_phone],
                ['Industry', lead.industry],
                ['Company size', lead.size_estimate],
              ].filter(([, v]) => v).map(([k, v]) => (
                <div key={k} className="flex items-start justify-between gap-4 py-2.5">
                  <dt className="text-muted-foreground">{k}</dt>
                  {/* Only genuinely enum-like values are capitalised: emails, URLs,
                      salary strings and department names get mangled by CSS
                      capitalize (e.g. qa-probe@example.com -> Qa-Probe@Example.Com). */}
                  <dd className={`text-right font-medium text-foreground${
                    ENUM_LIKE_KEYS.has(k as string) ? ' capitalize' : ''}`}>{v}</dd>
                </div>
              ))}
              {(lead.apply_url || lead.job_url) && (
                <div className="flex items-start justify-between gap-4 py-2.5">
                  <dt className="text-muted-foreground">Apply</dt>
                  <dd className="text-right">
                    <a
                      href={lead.apply_url || lead.job_url || undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                    >
                      Open posting <ExternalLink className="h-3 w-3" />
                    </a>
                  </dd>
                </div>
              )}
            </dl>
            {lead.hr_name && (
              <div className="mt-4 rounded-lg border border-border bg-muted/40 p-3">
                <p className="text-xs text-muted-foreground">HR Contact</p>
                <p className="mt-1 text-sm font-medium">{lead.hr_name}</p>
                {(lead as any).hr_title && <p className="text-[13px] text-muted-foreground">{(lead as any).hr_title}{(lead as any).hr_department ? ` · ${(lead as any).hr_department}` : ''}{(lead as any).hr_location ? ` · ${(lead as any).hr_location}` : ''}</p>}
                {(lead as any).hr_email_verified && <p className="mt-1 text-xs font-medium text-success">✓ Verified email</p>}
                {lead.hr_linkedin_url && (
                  <a
                    href={lead.hr_linkedin_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-flex items-center gap-1.5 text-[13px] text-info hover:underline"
                  >
                    <Link2 className="h-3.5 w-3.5" />
                    LinkedIn profile
                  </a>
                )}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {emailMeta && <Badge className={emailMeta.className}>{emailMeta.label}</Badge>}
                  {waMeta && <Badge className={waMeta.className}>{waMeta.label}</Badge>}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Deterministic score explanation — no black-box number. */}
        {scoreData && Object.keys(scoreData.breakdown || {}).length > 0 && (
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" />Why this score</span>
                <span className="text-ink-strong text-lg font-semibold tabular-nums" title={`Engine score ${scoreData.score}/100`}>{(scoreData as any).score_10 ?? score10(scoreData.score)}/10</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5 text-[13px]">
                {Object.values(scoreData.breakdown).filter(Boolean).map((b: any) => (
                  <li key={b.reason} className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">{b.reason}</span>
                    <span className="font-medium tabular-nums text-success">+{b.points}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[11px] text-muted-foreground/70">Score is deterministic from these fields; re-verifying or enriching updates it.</p>
            </CardContent>
          </Card>
        )}

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              About the Company & Role
            </CardTitle>
          </CardHeader>
          <CardContent>
            {lead.about_company && (
              <p className="mb-4 text-[13px] leading-relaxed text-muted-foreground">{lead.about_company}</p>
            )}
            <h4 className="mb-2 text-[13px] font-semibold text-foreground">Job Description</h4>
            {/* Rendered as a plain string. The old path ran the text through a
                helper that set textContent and read innerHTML back -- that
                ESCAPES rather than sanitizes, so '<b>x</b>' displayed as
                '&lt;b&gt;x&lt;/b&gt;' -- and then passed the result to
                dangerouslySetInnerHTML. React escapes a string child for us, so
                the raw description is correct and the HTML sink is gone.
                whitespace-pre-wrap keeps the source line breaks legible. */}
            <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-4 text-[13px] leading-relaxed text-muted-foreground">
              {lead.job_description || 'No description available'}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Contact Preferences</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Do Not Contact</p>
              <p className="text-[13px] text-muted-foreground">
                {lead.do_not_contact
                  ? 'This lead is excluded from all outreach.'
                  : 'This lead can receive emails and WhatsApp messages.'}
              </p>
            </div>
            <Switch
              checked={lead.do_not_contact}
              onCheckedChange={handleDoNotContactChange}
              disabled={doNotContactMutation.isLoading}
            />
          </div>
          {doNotContactMutation.isError && (
            <p className="mt-2 text-[13px] text-destructive">Failed to update preference. Please retry.</p>
          )}
        </CardContent>
      </Card>

      {lead.drafts && lead.drafts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-muted-foreground" />
              Outreach Drafts
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {lead.drafts.map((draft: OutreachDraft) => {
              const isEditing = editing?.draftId === draft.id;
              return (
                <div key={draft.id} className="rounded-lg border border-border">
                  <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="uppercase">{draft.channel}</Badge>
                      <span className="text-xs text-muted-foreground">v{draft.version}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {draft.is_edited ? 'Edited' : 'Auto-generated'}
                    </span>
                  </div>

                  {isEditing ? (
                    <div className="space-y-3 p-4">
                      <div>
                        <label className="mb-1 block text-[13px] font-medium text-foreground">Subject</label>
                        <Input
                          value={editing.subject}
                          onChange={(e) => updateEditing({ subject: e.target.value })}
                          placeholder="Email subject"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[13px] font-medium text-foreground">Body</label>
                        <Textarea
                          value={editing.body}
                          onChange={(e) => updateEditing({ body: e.target.value })}
                          rows={8}
                          placeholder="Message body"
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button onClick={saveEditing} loading={editDraftMutation.isLoading}>
                          {editDraftMutation.isLoading ? 'Saving…' : 'Save Draft'}
                        </Button>
                        <Button onClick={() => { clearBackup(draft.id); setEditing(null); }} variant="outline" disabled={editDraftMutation.isLoading}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="p-4">
                      {draft.subject && <p className="mb-2 text-sm font-semibold text-foreground">{draft.subject}</p>}
                      <pre className="max-h-64 min-h-[80px] overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 font-sans text-[13px] leading-relaxed text-foreground">
                        {draft.body || 'No draft body available'}
                      </pre>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button onClick={() => startEditing(draft)} variant="outline" size="sm">
                          Edit Draft
                        </Button>
                        <Button
                          onClick={() => setPendingSend({ channel: draft.channel, draftId: draft.id })}
                          variant="soft"
                          size="sm"
                          disabled={!!sendBlockReason}
                          title={sendBlockReason || `Send via ${draft.channel} — you will confirm first`}
                        >
                          <Send className="h-3.5 w-3.5" />
                          Send this draft
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {lead.possible_duplicate_of && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-[13px]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>
            Flagged as a possible duplicate of another lead.{' '}
            <button type="button" className="font-medium underline" onClick={() => navigate(`/leads/${lead.possible_duplicate_of}`)}>
              Open the other lead
            </button>{' '}
            — review both before sending anything twice.
          </span>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          {timeline.length === 0 ? (
            <EmptyState icon={XCircle} title="No events yet" description="Actions on this lead will appear here." />
          ) : (
            <ol className="space-y-0">
              {timeline.map((event: any, i: number) => (
                <li key={i} className="relative flex gap-4 pb-6 last:pb-0">
                  {i < timeline.length - 1 && (
                    <span className="absolute left-[5px] top-4 h-full w-px bg-border" />
                  )}
                  <span className={`relative mt-1 h-[11px] w-[11px] shrink-0 rounded-full border-2 border-background ${
                    event.status === 'failed' || event.status === 'bounced'
                      ? 'bg-destructive'
                      : event.status === 'success' || event.status === 'replied'
                        ? 'bg-success'
                        : 'bg-primary'
                  }`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[13px] font-medium text-foreground">
                        {TIMELINE_TYPE_LABELS[event.type] || event.type.replace(/_/g, ' ')}
                      </p>
                      <span className="text-xs text-muted-foreground">
                        {event.timestamp ? formatDateTime(event.timestamp) : '—'}
                      </span>
                    </div>
                    {(event.status || event.delivery_status || event.provider || event.channel) && (
                      <p className="mt-0.5 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        {event.status && <span className="capitalize">{event.status}</span>}
                        {event.delivery_status && <span className="capitalize">delivery: {event.delivery_status}</span>}
                        {event.channel && <span className="capitalize">via {event.channel}</span>}
                        {event.provider && <span className="capitalize">via {event.provider}</span>}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!pendingSend}
        onClose={() => (sending ? null : setPendingSend(null))}
        onConfirm={confirmSend}
        title={sendBlockReason ? 'Sending blocked' : `Send via ${pendingSend?.channel}?`}
        description={
          sendBlockReason ||
          `To: ${lead.hr_email || lead.hr_mobile || 'no verified contact'}\nEmail: ${lead.email_status || 'unknown'} · WhatsApp: ${lead.whatsapp_status || 'unknown'}\nEmail provider: ${sendingReady?.email ? 'configured' : 'NOT CONFIGURED — send will fail honestly, configure keys in Settings'}\nWhatsApp provider: ${sendingReady?.whatsapp ? 'configured' : 'NOT CONFIGURED — send will fail honestly, configure in Settings'}\nQueued sends report the real provider result — "queued" is not "sent".`
        }
        confirmLabel={sendBlockReason ? 'Blocked' : 'Confirm send'}
        loading={sending}
      />

      {confirmStep && (
        <ConfirmDialog
          open
          onClose={() => setConfirmStep(null)}
          onConfirm={() => { const fn = confirmStep.run; setConfirmStep(null); fn(); }}
          title={confirmStep.title}
          description={confirmStep.description}
          confirmLabel={confirmStep.confirmLabel}
          confirmVariant={confirmStep.variant || 'default'}
        />
      )}

      <Modal open={showAssignModal} onClose={() => setShowAssignModal(false)} title="Assign Lead">
        <div className="space-y-2">
          <button
            onClick={() => handleAssign('')}
            className="flex w-full items-center gap-2.5 rounded-lg border border-border px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent"
          >
            <User className="h-4 w-4 text-muted-foreground" />
            <span>Unassigned</span>
          </button>
          {users.map((user: any) => (
            <button
              key={user.id}
              onClick={() => handleAssign(user.id)}
              className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                lead.assigned_to === user.id
                  ? 'border-primary bg-primary-soft text-primary'
                  : 'border-border hover:bg-accent'
              }`}
            >
              <User className="h-4 w-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{user.email}</p>
                <p className="text-xs capitalize text-muted-foreground">{user.role}</p>
              </div>
              {lead.assigned_to === user.id && <CheckCircle2 className="h-4 w-4 text-primary" />}
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="outline" onClick={() => setShowAssignModal(false)}>
            Cancel
          </Button>
        </div>
      </Modal>
    </div>
  );
};

export default LeadDetail;