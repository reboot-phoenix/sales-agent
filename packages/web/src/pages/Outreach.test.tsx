/**
 * The outreach page is the screen a rep works from, so the tests pin what it must
 * never do: present an unverified locator as ready, or hide the reason a lead is
 * not sendable.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/ui/toast';

const queue = jest.fn();
const summary = jest.fn();
const reassess = jest.fn();

jest.mock('@/lib/api', () => ({
  outreach: {
    queue: (...args: unknown[]) => queue(...args),
    summary: (...args: unknown[]) => summary(...args),
    reassess: (...args: unknown[]) => reassess(...args),
  },
  hackathons: { bulkClaim: jest.fn() },
  colleges: { bulkClaim: jest.fn() },
  savedFilters: {
    list: jest.fn().mockResolvedValue({ data: [] }),
    save: jest.fn(),
    use: jest.fn(),
    remove: jest.fn(),
  },
}));

import Outreach from '@/pages/Outreach';

const READY_LEAD = {
  domain: 'colleges',
  entity_id: '11111111-1111-4111-8111-111111111111',
  name: 'ABC College of Engineering',
  score: 84,
  priority: 'P0',
  readiness: 'OUTREACH_READY',
  best_contact: {
    full_name: 'Asha Rao',
    email: 'asha.rao@abc.edu',
    verification_status: 'verified',
  },
  reasons: ['verified personal email', 'reaches tpo', 'placement season in progress'],
  blockers: [],
  lead: { city: 'Pune', state: 'MH' },
};

const PARTIAL_LEAD = {
  domain: 'hackathons',
  entity_id: '22222222-2222-4222-8222-222222222222',
  name: 'Smart India Hackathon',
  score: 41,
  priority: 'P2',
  readiness: 'PARTIALLY_ENRICHED',
  best_contact: { email: 'organizer@sih.gov.in', verification_status: 'unverified' },
  reasons: ['unverified email (discovered, not deliverability-checked)'],
  blockers: ['locator discovered but not verified'],
  lead: { city: 'Delhi' },
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <Outreach />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  queue.mockResolvedValue({
    data: [READY_LEAD, PARTIAL_LEAD],
    counts: { assessed: 2, ready: 1, returned: 2 },
  });
  summary.mockResolvedValue({
    readiness: {
      jobs: { OUTREACH_READY: 3 },
      hackathons: { OUTREACH_READY: 7 },
      colleges: { OUTREACH_READY: 11 },
    },
    leads_with_a_locator: { jobs: 20, hackathons: 30, colleges: 40 },
  });
  reassess.mockResolvedValue({ ok: true });
});

describe('Outreach worklist', () => {
  it('shows the readiness mix per domain', async () => {
    renderPage();
    expect(await screen.findByText('ABC College of Engineering')).toBeInTheDocument();
    expect(screen.getByText('11')).toBeInTheDocument();  // colleges ready
    expect(screen.getByText('7')).toBeInTheDocument();   // hackathons ready
  });

  it('labels readiness and priority, and shows why a lead ranks where it does', async () => {
    renderPage();
    // Each label also appears as a filter option, so assert on the rows' badges
    // rather than expecting a unique node.
    await screen.findByText('ABC College of Engineering');
    expect(screen.getAllByText('Outreach ready').length).toBeGreaterThan(1);
    expect(screen.getAllByText('Partially enriched').length).toBeGreaterThan(1);
    expect(screen.getAllByText('P0').length).toBeGreaterThan(0);
    expect(screen.getByText('verified personal email')).toBeInTheDocument();
  });

  it('surfaces the blocker for a lead that is not sendable yet', async () => {
    renderPage();
    expect(await screen.findByText('locator discovered but not verified')).toBeInTheDocument();
  });

  it('defaults to unclaimed, outreach-ready leads', async () => {
    renderPage();
    await waitFor(() => expect(queue).toHaveBeenCalled());
    expect(queue.mock.calls[0][0]).toMatchObject({ readiness: 'OUTREACH_READY', unclaimed_only: 'true' });
  });

  it('re-checks a lead on demand', async () => {
    renderPage();
    const buttons = await screen.findAllByRole('button', { name: /re-check/i });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(reassess).toHaveBeenCalledWith(
      'colleges', '11111111-1111-4111-8111-111111111111',
    ));
  });

  it('explains the rule a rep has to trust', async () => {
    renderPage();
    expect(await screen.findByText(/A URL alone never does/)).toBeInTheDocument();
  });

  it('shows an empty state instead of a blank table', async () => {
    queue.mockResolvedValue({ data: [], counts: { assessed: 0, ready: 0, returned: 0 } });
    renderPage();
    expect(await screen.findByText(/Nothing sendable matches these filters/)).toBeInTheDocument();
  });
});
