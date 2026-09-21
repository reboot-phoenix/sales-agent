import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { hackathons as hackathonsApi } from '@/lib/api';
import { Hackathon, HackathonOccurrence, HackathonPrediction, DomainContact } from '@/lib/types';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoader } from '@/components/ui/spinner';
import { ErrorState } from '@/components/ui/error-state';
import { formatDate } from '@/lib/format';
import { statusBadgeClass } from './Hackathons';
import { ArrowLeft, ExternalLink, Mail, Phone, Link2, AlertTriangle, History, Sparkles } from 'lucide-react';

const PROVENANCE_TONE = 'text-[12px] text-muted-foreground';

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    return <div><dt className="text-[12px] text-muted-foreground">{label}</dt><dd className="text-[13px] text-muted-foreground/60">Not recorded</dd></div>;
  }
  return <div><dt className="text-[12px] text-muted-foreground">{label}</dt><dd className="text-[13px]">{value}</dd></div>;
}

const HackathonDetail: React.FC = () => {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [note, setNote] = useState('');

  const { data, isLoading, isError, error, refetch } = useQuery(['hackathon', id], () => hackathonsApi.get(id), { enabled: !!id });
  const { data: predictionData } = useQuery(['hackathon-prediction', id], () => hackathonsApi.prediction(id), { enabled: !!id });
  const { data: activityData } = useQuery(['hackathon-activity', id], () => hackathonsApi.activity(id), { enabled: !!id });

  const claim = useMutation(() => hackathonsApi.claim(id), {
    onSuccess: () => { toast({ title: 'Claimed', variant: 'success' }); queryClient.invalidateQueries(['hackathon', id]); },
    onError: (e: Error) => toast({ title: 'Claim failed', description: e.message, variant: 'error' }),
  });
  const enrich = useMutation(() => hackathonsApi.enrich(id), {
    onSuccess: () => { toast({ title: 'Organizer enrichment started', variant: 'success' }); },
    onError: (e: Error) => toast({ title: 'Enrichment failed', description: e.message, variant: 'error' }),
  });

  const addNote = useMutation((body: string) => hackathonsApi.addNote(id, body), {
    onSuccess: () => {
      setNote('');
      toast({ title: 'Note saved', variant: 'success' });
      queryClient.invalidateQueries(['hackathon', id]);
      queryClient.invalidateQueries(['hackathon-activity', id]);
    },
    onError: (e: Error) => toast({ title: 'Could not save note', description: e.message, variant: 'error' }),
  });

  if (isLoading) return <PageLoader label="Loading hackathon profile..." />;
  if (isError || !data) return <ErrorState title="Error loading hackathon" message={(error as Error)?.message || 'Not found'} onRetry={() => refetch()} />;

  const h: Hackathon = data.hackathon;
  const occurrences: HackathonOccurrence[] = data.occurrences || [];
  const contacts: DomainContact[] = data.contacts || [];
  const sources = data.sources || [];
  const prediction: HackathonPrediction | null = predictionData?.prediction || data.predictions?.[0] || null;
  const activity = activityData?.activity || data.activity || [];
  const notes = data.notes || [];

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={`Hackathons / ${h.source_platform || 'discovered'}`}
        title={h.name}
        description={[h.organizer_name, h.mode, [h.city, h.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => navigate('/hackathons')}><ArrowLeft className="h-4 w-4" />Back</Button>
            {h.hackathon_url && (
              <a href={h.hackathon_url} target="_blank" rel="noreferrer noopener" className="btn btn-outline btn-sm inline-flex items-center gap-1.5">
                <ExternalLink className="h-4 w-4" />Open source
              </a>
            )}
            {!h.claimed_by && !h.assigned_to && (
              <Button size="sm" onClick={() => claim.mutate()} loading={claim.isLoading}><Sparkles className="h-4 w-4" />Claim</Button>
            )}
            <Button variant="outline" size="sm" onClick={() => enrich.mutate()} loading={enrich.isLoading}>Enrich organizer</Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge className={statusBadgeClass(h.status)}>{h.status.replace(/_/g, ' ')}</Badge>
        <Badge className="border-border">{h.outreach_readiness.replace(/_/g, ' ')}</Badge>
        <Badge className="border-border">confidence {h.confidence_score}%</Badge>
        <Badge className="border-border">completeness {h.completeness_score}%</Badge>
        <span className={PROVENANCE_TONE}>verification: {h.verification_status} · sources: {h.source_count}</span>
      </div>

      {/* Prediction first when present, and unmissable: it is not a confirmed fact. */}
      {prediction && (
        <div className="card border-dashed border-amber-500/40 p-4">
          <div className="mb-2 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-amber-300">PREDICTED — not confirmed</h2>
            <Badge className={statusBadgeClass(prediction.status)}>{prediction.status.replace(/_/g, ' ')}</Badge>
            <span className="text-[12px] text-amber-400">{prediction.confidence}% confidence</span>
          </div>
          <p className="text-[13px]">
            Expected occurrence: <strong>{prediction.predicted_occurrence || 'unknown'}</strong>
            {prediction.expected_registration_window ? ` · registration window ${prediction.expected_registration_window}` : ''}
          </p>
          <p className="mt-1 text-[12px] text-muted-foreground">{prediction.basis}</p>
          <p className="mt-1 text-[12px] text-muted-foreground">Method: {prediction.method}</p>
          {prediction.limitations && <p className="mt-1 text-[12px] text-muted-foreground/80">Limitations: {prediction.limitations}</p>}
          <div className="mt-3">
            <p className="mb-1 text-[12px] font-medium">Evidence</p>
            <ul className="space-y-1">
              {(prediction.evidence || []).map((e, i) => (
                <li key={i} className="text-[12px] text-muted-foreground">
                  {e.month ? `${new Date(2000, e.month - 1).toLocaleString('en', { month: 'long' })} ` : ''}{e.year}
                  {e.event_start ? ` · ${e.event_start}` : ''}
                  {e.source_url ? <> · <a className="underline" href={e.source_url} target="_blank" rel="noreferrer noopener">source</a></> : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-4 lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold">Overview</h2>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Event start" value={h.event_start ? formatDate(h.event_start) : null} />
            <Field label="Event end" value={h.event_end ? formatDate(h.event_end) : null} />
            <Field label="Registration deadline" value={h.registration_deadline ? formatDate(h.registration_deadline) : null} />
            <Field label="Mode" value={h.mode} />
            <Field label="Venue" value={h.venue} />
            <Field label="Country" value={h.country} />
            <Field label="Team size" value={h.team_size_min || h.team_size_max ? `${h.team_size_min ?? '?'}–${h.team_size_max ?? '?'}` : null} />
            <Field label="Student only" value={h.student_only === null ? null : (h.student_only ? 'Yes' : 'No')} />
            <Field label="Open to public" value={h.open_to_public === null ? null : (h.open_to_public ? 'Yes' : 'No')} />
            <Field label="Technology" value={h.technology} />
            <Field label="Domain" value={h.domain} />
            <Field label="Prize pool" value={h.prize_pool ? `₹${Number(h.prize_pool).toLocaleString('en-IN')}` : null} />
            <Field label="Internships" value={h.internship_opportunities === null ? null : (h.internship_opportunities ? 'Yes' : 'No')} />
            <Field label="Hiring link" value={h.hiring_opportunities === null ? null : (h.hiring_opportunities ? 'Yes' : 'No')} />
            <Field label="Eligibility" value={h.eligibility} />
          </dl>
          {h.problem_statements?.length > 0 && (
            <div className="mt-4">
              <p className="mb-1 text-[12px] font-medium">Problem statements</p>
              <ul className="list-disc pl-5 text-[13px] text-muted-foreground">
                {h.problem_statements.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            </div>
          )}
        </div>

        <div className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">Contacts</h2>
          {contacts.length === 0 && (
            <p className="text-[13px] text-muted-foreground">
              No contact yet. A record with only a URL is never outreach-ready.
            </p>
          )}
          <ul className="space-y-3">
            {contacts.map((c) => (
              <li key={c.id} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[13px] font-medium">{c.full_name || 'Unnamed contact'}</p>
                  <Badge className="border-border">{c.priority}</Badge>
                </div>
                {c.designation && <p className="text-[12px] text-muted-foreground">{c.designation}</p>}
                <div className="mt-1 flex flex-wrap gap-2 text-[12px]">
                  {c.email && <a className="inline-flex items-center gap-1 underline" href={`mailto:${c.email}`}><Mail className="h-3 w-3" />{c.email}</a>}
                  {c.phone && <a className="inline-flex items-center gap-1 underline" href={`tel:${c.phone}`}><Phone className="h-3 w-3" />{c.phone}</a>}
                  {c.linkedin_url && <a className="inline-flex items-center gap-1 underline" href={c.linkedin_url} target="_blank" rel="noreferrer noopener"><Link2 className="h-3 w-3" />LinkedIn</a>}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">source: {c.contact_source || 'unknown'} · {c.verification_status}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><History className="h-4 w-4" />Historical occurrences</h2>
          {occurrences.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No historical editions recorded yet — without history there is no prediction.</p>
          ) : (
            <table className="w-full text-[13px]">
              <thead><tr><th className="table-th">Year</th><th className="table-th">Start</th><th className="table-th">End</th><th className="table-th">City</th><th className="table-th">Confirmed</th></tr></thead>
              <tbody>
                {occurrences.map((o) => (
                  <tr key={o.id} className="border-b border-border last:border-0">
                    <td className="table-td">{o.year}</td>
                    <td className="table-td">{o.event_start || '—'}</td>
                    <td className="table-td">{o.event_end || '—'}</td>
                    <td className="table-td">{o.city || '—'}</td>
                    <td className="table-td">{o.is_confirmed ? 'yes' : 'unverified'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">Sources &amp; provenance</h2>
          <ul className="space-y-2">
            {sources.map((s: any) => (
              <li key={s.id} className="text-[12px]">
                <span className="font-medium">{s.source_platform}</span>
                {' · '}
                <a className="underline" href={s.source_url} target="_blank" rel="noreferrer noopener">open</a>
                {s.confidence != null && <span className="text-muted-foreground"> · confidence {s.confidence}</span>}
                <span className="text-muted-foreground"> · fetched {formatDate(s.fetched_at)}</span>
              </li>
            ))}
            {sources.length === 0 && <li className="text-[13px] text-muted-foreground">No source rows recorded.</li>}
          </ul>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">Activity</h2>
          <ul className="space-y-2">
            {activity.map((a: any, i: number) => (
              <li key={a.id || i} className="text-[12px] text-muted-foreground">
                <span className="font-medium text-foreground">{a.action}</span>
                {a.actor_email ? ` by ${a.actor_email}` : ''} · {formatDate(a.created_at)}
              </li>
            ))}
            {activity.length === 0 && <li className="text-[13px] text-muted-foreground">No activity recorded.</li>}
          </ul>
        </div>

        <div className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">Notes</h2>
          <div className="mb-3 flex gap-2">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…" className="input flex-1" />
            <Button size="sm" disabled={!note.trim() || addNote.isLoading} onClick={() => addNote.mutate(note.trim())}>Save</Button>
          </div>
          <ul className="space-y-2">
            {notes.map((n: any) => (
              <li key={n.id} className="rounded-lg border border-border p-2 text-[13px]">
                <p>{n.body}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">{n.author_email || 'unknown'} · {formatDate(n.created_at)}</p>
              </li>
            ))}
            {notes.length === 0 && <li className="text-[13px] text-muted-foreground">No notes yet.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
};

export default HackathonDetail;
