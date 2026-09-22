import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { colleges as collegesApi } from '@/lib/api';
import { College, DomainContact } from '@/lib/types';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { PageLoader } from '@/components/ui/spinner';
import { ErrorState } from '@/components/ui/error-state';
import { formatDate } from '@/lib/format';
import { readinessClass } from './Colleges';
import { ArrowLeft, ExternalLink, Mail, Phone, Link2, RefreshCw, UserRound } from 'lucide-react';

const ROLE_LABEL: Record<string, string> = {
  tpo: 'TPO', placement_head: 'Placement Head', placement_cell: 'Placement Cell',
  director: 'Director', principal: 'Principal', dean: 'Dean', hod: 'HOD',
  official: 'Official', faculty: 'Faculty', other: 'Other',
};

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] text-muted-foreground">{label}</dt>
      <dd className="text-[13px]">{value === null || value === undefined || value === '' ? <span className="text-muted-foreground/60">Not recorded</span> : value}</dd>
    </div>
  );
}

function ContactCard({ contact }: { contact: DomainContact }) {
  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium">{contact.full_name || 'Unnamed contact'}</p>
        <div className="flex items-center gap-1.5">
          <Badge className="border-border">{contact.priority}</Badge>
          <Badge className="border-border">{ROLE_LABEL[contact.role_category] || contact.role_category}</Badge>
        </div>
      </div>
      {contact.designation && <p className="text-[12px] text-muted-foreground">{contact.designation}</p>}
      <div className="mt-1 flex flex-wrap gap-2 text-[12px]">
        {contact.email && <a className="inline-flex items-center gap-1 underline" href={`mailto:${contact.email}`}><Mail className="h-3 w-3" />{contact.email}</a>}
        {contact.phone && <a className="inline-flex items-center gap-1 underline" href={`tel:${contact.phone}`}><Phone className="h-3 w-3" />{contact.phone}</a>}
        {contact.linkedin_url && <a className="inline-flex items-center gap-1 underline" href={contact.linkedin_url} target="_blank" rel="noreferrer noopener"><Link2 className="h-3 w-3" />LinkedIn</a>}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        source: {contact.contact_source || 'unknown'} · {contact.verification_status}
        {contact.source_url && <> · <a className="underline" href={contact.source_url} target="_blank" rel="noreferrer noopener">page</a></>}
      </p>
    </li>
  );
}

const CollegeDetail: React.FC = () => {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [note, setNote] = useState('');

  const { data, isLoading, isError, error, refetch } = useQuery({
  queryKey: ['college', id],
  queryFn: () => collegesApi.get(id),
  enabled: !!id,
});

  const enrich = useMutation({
  mutationFn: () => collegesApi.enrich(id),
  onSuccess: () => toast({ title: 'Enrichment started', description: 'TPO / principal / placement pages are being scanned.', variant: 'success' }),
  onError: (e: Error) => toast({ title: 'Enrichment failed', description: e.message, variant: 'error' }),
});
  const claim = useMutation({
  mutationFn: () => collegesApi.claim(id),
  onSuccess: () => { toast({ title: 'Claimed', variant: 'success' }); queryClient.invalidateQueries({
  queryKey: ['college', id],
}); },
  onError: (e: Error) => toast({ title: 'Claim failed', description: e.message, variant: 'error' }),
});
  const addNote = useMutation({
  mutationFn: (body: string) => collegesApi.addNote(id, body),
  onSuccess: () => {
  setNote('');
  toast({ title: 'Note saved', variant: 'success' });
  queryClient.invalidateQueries({
  queryKey: ['college', id],
});
  },
  onError: (e: Error) => toast({ title: 'Could not save note', description: e.message, variant: 'error' }),
});

  if (isLoading) return <PageLoader label="Loading college profile..." />;
  if (isError || !data) return <ErrorState title="Error loading college" message={(error as Error)?.message || 'Not found'} onRetry={() => refetch()} />;

  const c: College = data.college;
  const contacts: DomainContact[] = data.contacts || [];
  const sources = data.sources || [];
  const enrichmentRuns = data.enrichment_runs || [];
  const activity = data.activity || [];
  const notes = data.notes || [];

  const byRole = (roles: string[]) => contacts.filter((x) => roles.includes(x.role_category));
  const tpoContacts = byRole(['tpo', 'placement_head', 'placement_cell']);
  const leadership = byRole(['principal', 'director', 'dean']);
  const hods = byRole(['hod']);
  const otherContacts = contacts.filter((x) => !tpoContacts.includes(x) && !leadership.includes(x) && !hods.includes(x));

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={`Colleges / ${c.state || 'unknown state'}`}
        title={c.name}
        description={[c.city, c.district, c.university_affiliation].filter(Boolean).join(' · ')}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => navigate('/colleges')}><ArrowLeft className="h-4 w-4" />Back</Button>
            {c.website_url && (
              <a href={c.website_url} target="_blank" rel="noreferrer noopener" className="btn btn-outline btn-sm inline-flex items-center gap-1.5">
                <ExternalLink className="h-4 w-4" />Website
              </a>
            )}
            <Button variant="outline" size="sm" onClick={() => enrich.mutate()} loading={enrich.isPending}><RefreshCw className="h-4 w-4" />Enrich contacts</Button>
            {!c.claimed_by && !c.assigned_to && (
              <Button size="sm" onClick={() => claim.mutate()} loading={claim.isPending}>Claim</Button>
            )}
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge className={readinessClass(c.outreach_readiness)}>{c.outreach_readiness.replace(/_/g, ' ')}</Badge>
        <Badge className="border-border">{c.enrichment_status}</Badge>
        <Badge className="border-border">completeness {c.completeness_score}%</Badge>
        <Badge className="border-border">confidence {c.confidence_score}%</Badge>
        <span className="text-[12px] text-muted-foreground">
          contacts {c.contact_coverage?.contacts ?? contacts.length} · verified {c.contact_coverage?.verified ?? 0}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card p-4 lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold">Institution</h2>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Official name" value={c.official_name} />
            <Field label="AISHE code" value={c.aishe_code} />
            <Field label="University / affiliation" value={c.university_affiliation} />
            <Field label="Type" value={c.institution_type} />
            <Field label="Ownership" value={c.ownership} />
            <Field label="Autonomous" value={c.autonomous === null ? null : (c.autonomous ? 'Yes' : 'No')} />
            <Field label="Accreditation" value={c.accreditation} />
            <Field label="NAAC grade" value={c.naac_grade} />
            <Field label="NIRF rank" value={c.nirf_rank} />
            <Field label="AICTE approved" value={c.aicte_approved === null ? null : (c.aicte_approved ? 'Yes' : 'No')} />
            <Field label="Address" value={c.address} />
            <Field label="PIN code" value={c.pincode} />
            <Field label="Official email" value={c.official_email && <a className="underline" href={`mailto:${c.official_email}`}>{c.official_email}</a>} />
            <Field label="Phone" value={c.phone} />
            <Field label="Admissions contact" value={c.admissions_contact} />
            <Field label="Placement contact" value={c.placement_contact} />
          </dl>
        </div>

        <div className="card p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><UserRound className="h-4 w-4" />Placement / TPO</h2>
          {tpoContacts.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              No placement contact recorded. Use “Enrich contacts” — the cascade prioritises TPO, then placement head, then the placement cell.
            </p>
          ) : (
            <ul className="space-y-3">{tpoContacts.map((x) => <ContactCard key={x.id} contact={x} />)}</ul>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">Leadership</h2>
          {leadership.length === 0 ? <p className="text-[13px] text-muted-foreground">No principal/director/dean contact recorded.</p> : (
            <ul className="space-y-3">{leadership.map((x) => <ContactCard key={x.id} contact={x} />)}</ul>
          )}
          {hods.length > 0 && (
            <>
              <h3 className="mb-2 mt-4 text-[13px] font-medium">Heads of department</h3>
              <ul className="space-y-3">{hods.map((x) => <ContactCard key={x.id} contact={x} />)}</ul>
            </>
          )}
          {otherContacts.length > 0 && (
            <>
              <h3 className="mb-2 mt-4 text-[13px] font-medium">Other contacts</h3>
              <ul className="space-y-3">{otherContacts.map((x) => <ContactCard key={x.id} contact={x} />)}</ul>
            </>
          )}
        </div>

        <div className="card p-4">
          <h2 className="mb-3 text-sm font-semibold">Sources &amp; enrichment</h2>
          <ul className="space-y-2">
            {sources.map((s: any) => (
              <li key={s.id} className="text-[12px]">
                <span className="font-medium">{s.source_name}</span>
                {' · '}
                <a className="underline" href={s.source_url} target="_blank" rel="noreferrer noopener">open</a>
                <span className="text-muted-foreground"> · fetched {formatDate(s.fetched_at)}</span>
              </li>
            ))}
            {sources.length === 0 && <li className="text-[13px] text-muted-foreground">No sources recorded.</li>}
          </ul>
          <h3 className="mb-2 mt-4 text-[13px] font-medium">Enrichment runs</h3>
          <ul className="space-y-1">
            {enrichmentRuns.map((r: any) => (
              <li key={r.id} className="text-[12px] text-muted-foreground">
                {r.status} · {r.contacts_found} contacts · {formatDate(r.started_at)}
              </li>
            ))}
            {enrichmentRuns.length === 0 && <li className="text-[13px] text-muted-foreground">Never enriched.</li>}
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
            <Button size="sm" disabled={!note.trim() || addNote.isPending} onClick={() => addNote.mutate(note.trim())}>Save</Button>
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

export default CollegeDetail;
