/**
 * The API-side scorer must agree with the python one on the rules that decide
 * whether a rep can send. These tests pin those rules (a URL is never readiness,
 * an unverified locator is only partial, a dead mailbox scores zero) rather than
 * incidental weights.
 */
import {
  assessLead,
  bestContact,
  contactLocatorScore,
  contactRole,
  countDataPoints,
  freshnessPoints,
  isRoleAddress,
  phoneWorthSending,
  priorityFor,
  rankAssessments,
  readinessFrom,
  type OutreachContact,
} from '../src/utils/outreach';

const NOW = new Date('2026-09-21T02:00:00Z');

function contact(overrides: Partial<OutreachContact> = {}): OutreachContact {
  return {
    full_name: 'Asha Rao',
    role_category: 'tpo',
    verification_status: 'unverified',
    ...overrides,
  };
}

describe('role and phone classification', () => {
  it('recognises shared mailboxes', () => {
    expect(isRoleAddress('placement@college.edu')).toBe(true);
    expect(isRoleAddress('tpo.office@college.edu')).toBe(true);
    expect(isRoleAddress('info@college.edu')).toBe(true);
    expect(isRoleAddress('asha.rao@college.edu')).toBe(false);
    expect(isRoleAddress(null)).toBe(false);
  });

  it('rejects filler phone numbers', () => {
    expect(phoneWorthSending('+91 98765 43210')).toBe(true);
    expect(phoneWorthSending('1111111111')).toBe(false);
    expect(phoneWorthSending('12345')).toBe(false);
    expect(phoneWorthSending('')).toBe(false);
  });

  it('classifies a published job title into an outreach role', () => {
    expect(contactRole('jobs', { job_title: 'Senior Technical Recruiter' })).toBe('recruiter');
    expect(contactRole('jobs', { job_title: 'HR Business Partner' })).toBe('hr');
    expect(contactRole('jobs', { job_title: 'Engineering Manager' })).toBe('hiring_manager');
    expect(contactRole('jobs', { job_title: 'Software Engineer' })).toBe('other');
    expect(contactRole('colleges', { role_category: 'principal' })).toBe('principal');
  });
});

describe('locator scoring', () => {
  it('pays the most for a verified personal mailbox', () => {
    const personal = contactLocatorScore(contact({ email: 'asha.rao@x.edu', verification_status: 'verified', verification_grade: 'A' }));
    const role = contactLocatorScore(contact({ email: 'placement@x.edu', verification_status: 'verified', verification_grade: 'B' }));
    expect(personal.score).toBeGreaterThan(role.score);
    expect(personal.reasons).toContain('verified personal email');
  });

  it('gives a dead locator nothing and explains why', () => {
    const dead = contactLocatorScore(contact({ email: 'gone@x.edu', verification_status: 'failed' }));
    expect(dead.score).toBe(0);
    expect(dead.reasons[0]).toMatch(/failed verification/);
  });

  it('counts an unverified email as partial credit only', () => {
    const unverified = contactLocatorScore(contact({ email: 'tpo@x.edu' }));
    const verified = contactLocatorScore(contact({ email: 'tpo@x.edu', verification_status: 'verified' }));
    expect(unverified.score).toBeGreaterThan(0);
    expect(unverified.score).toBeLessThan(verified.score);
  });
});

describe('readiness vocabulary', () => {
  it('never declares ready without a verified locator', () => {
    expect(readinessFrom({ hasVerifiedLocator: false, locatorCount: 2, completeness: 90, dataPoints: 5 }).readiness)
      .toBe('PARTIALLY_ENRICHED');
    expect(readinessFrom({ hasVerifiedLocator: false, locatorCount: 0, completeness: 90, dataPoints: 5 }).readiness)
      .toBe('NEEDS_ENRICHMENT');
    expect(readinessFrom({ hasVerifiedLocator: false, locatorCount: 0, completeness: 5, dataPoints: 0 }).readiness)
      .toBe('INSUFFICIENT_DATA');
  });

  it('declares ready on a verified locator with context', () => {
    expect(readinessFrom({ hasVerifiedLocator: true, locatorCount: 1, completeness: 60, dataPoints: 2 }).readiness)
      .toBe('OUTREACH_READY');
    // Verified but the record itself is empty: partial, with a blocker to act on.
    const thin = readinessFrom({ hasVerifiedLocator: true, locatorCount: 1, completeness: 10, dataPoints: 0 });
    expect(thin.readiness).toBe('PARTIALLY_ENRICHED');
    expect(thin.blockers).toHaveLength(1);
  });

  it('keeps a high-priority label off a lead nobody can reach', () => {
    const assessment = assessLead('jobs', {
      id: 'j1', title: 'Fresher SDE', company_name: 'Acme', posted_at: NOW,
      completeness_score: 100,
    }, [], NOW);
    expect(assessment.readiness).toBe('NEEDS_ENRICHMENT');
    expect(['P3', 'P4']).toContain(assessment.priority);
  });

  it('maps scores to priority buckets', () => {
    expect(priorityFor(80, 'OUTREACH_READY')).toBe('P0');
    expect(priorityFor(60, 'OUTREACH_READY')).toBe('P1');
    expect(priorityFor(45, 'PARTIALLY_ENRICHED')).toBe('P2');
    expect(priorityFor(10, 'NEEDS_ENRICHMENT')).toBe('P4');
  });
});

describe('freshness is domain-correct', () => {
  it('decays job postings by day', () => {
    const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
    const points = [1, 10, 30, 200].map((n) => freshnessPoints('jobs', { posted_at: days(n) }, NOW).points);
    expect(points[0]).toBeGreaterThan(points[1]);
    expect(points[1]).toBeGreaterThan(points[2]);
    expect(points[2]).toBeGreaterThan(points[3]);
  });

  it('counts down to a hackathon registration deadline', () => {
    const soon = freshnessPoints('hackathons', { registration_deadline: '2026-09-28T00:00:00Z' }, NOW);
    expect(soon.points).toBe(22);
    // The exact day count follows floor(elapsed); the bucket is what matters and
    // the bucket boundaries are shared with the python scorer.
    expect(soon.reasons[0]).toMatch(/registration closes in \d+ day/);
    // A predicted recurrence is worth a fraction of a live window.
    const predicted = freshnessPoints('hackathons', { occurrence_type: 'PREDICTED' }, NOW);
    expect(predicted.points).toBeLessThan(soon.points);
    expect(predicted.reasons[0]).toMatch(/predicted/);
  });

  it('uses the placement season for colleges', () => {
    expect(freshnessPoints('colleges', {}, new Date('2026-10-01T00:00:00Z')).reasons[0])
      .toMatch(/placement season/);
    expect(freshnessPoints('colleges', {}, new Date('2026-02-01T00:00:00Z')).reasons[0])
      .toMatch(/off-season/);
  });

  it('says so when a date is missing rather than guessing one', () => {
    expect(freshnessPoints('jobs', {}, NOW).reasons[0]).toMatch(/no posting date/);
  });
});

describe('assessment', () => {
  const college = {
    id: 'c1',
    name: 'ABC College',
    city: 'Pune',
    state: 'MH',
    website_url: 'https://abc.edu',
    completeness_score: 70,
  };

  it('makes a verified TPO contact P0 outreach-ready', () => {
    const assessment = assessLead('colleges', college, [
      contact({ email: 'asha.rao@abc.edu', verification_status: 'verified', verification_grade: 'A' }),
    ], NOW);
    expect(assessment.readiness).toBe('OUTREACH_READY');
    expect(assessment.priority).toBe('P0');
    expect(assessment.reasons).toContain('verified personal email');
    expect(assessment.reasons).toContain('reaches tpo');
  });

  it('never makes a bare URL outreach-ready', () => {
    const assessment = assessLead('colleges', { ...college, completeness_score: 40 }, [], NOW);
    expect(assessment.readiness).toBe('NEEDS_ENRICHMENT');
    expect(assessment.best_contact).toBeNull();
  });

  it('picks the contact a rep would actually use', () => {
    const best = bestContact([
      contact({ full_name: 'Dean', role_category: 'dean', email: 'dean@x.edu' }),
      contact({ full_name: 'Head', role_category: 'placement_head', email: 'ph@x.edu', verification_status: 'verified', verification_grade: 'A' }),
    ]);
    expect(best?.full_name).toBe('Head');
  });

  it('rejects an unknown domain instead of silently scoring it', () => {
    expect(() => assessLead('schools' as any, { id: 'x' }, [], NOW)).toThrow(/unknown outreach domain/);
  });

  it('ranks by score then readiness', () => {
    const low = { ...assessLead('colleges', college, [], NOW), score: 20, readiness: 'NEEDS_ENRICHMENT' as const };
    const high = { ...assessLead('colleges', college, [], NOW), score: 80, readiness: 'OUTREACH_READY' as const };
    expect(rankAssessments([low, high]).map((a) => a.score)).toEqual([80, 20]);
  });

  it('counts data points the way the python scorer does', () => {
    expect(countDataPoints({ city: 'Pune', state: '', skills: [], themes: ['ai'], description: null })).toBe(2);
  });
});
