import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from 'react-query';
import Hackathons, { statusBadgeClass } from './Hackathons';

jest.mock('@/lib/api', () => ({
  hackathons: {
    list: jest.fn(),
    claim: jest.fn(),
    exportCsv: jest.fn(),
    // Bulk actions and saved views are wired into this page; stub them so the
    // page renders without pretending their behaviour is under test here.
    bulkClaim: jest.fn(),
    bulkAssign: jest.fn(),
    bulkStatus: jest.fn(),
  },
  savedFilters: {
    list: jest.fn().mockResolvedValue({ data: [] }),
    save: jest.fn(),
    use: jest.fn(),
    remove: jest.fn(),
  },
}));

const mockedApi = require('@/lib/api');
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const renderPage = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Hackathons />
      </MemoryRouter>
    </QueryClientProvider>,
  );

const confirmed = {
  id: 'h1',
  name: 'Smart India Hackathon',
  organizer_name: 'Ministry of Education',
  status: 'REGISTRATION_OPEN',
  mode: 'offline',
  city: 'Delhi',
  state: 'Delhi',
  technology: 'AI',
  event_start: '2026-12-01',
  registration_deadline: '2026-11-01',
  prize_pool: 1000000,
  contact_email: 'sih@innovateindia.gov.in',
  occurrence_type: 'recurring',
  prediction_confidence: null,
};

const predicted = {
  id: 'h2',
  name: 'Acme Annual Hack',
  organizer_name: 'Acme',
  status: 'PREDICTED',
  mode: 'online',
  city: null,
  state: null,
  event_start: null,
  registration_deadline: null,
  prize_pool: null,
  contact_email: null,
  occurrence_type: 'recurring',
  prediction_confidence: 72,
};

describe('Hackathons page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryClient.clear();
  });

  it('renders discovered hackathons with their organizer and status', async () => {
    mockedApi.hackathons.list.mockResolvedValue({
      data: [confirmed],
      pagination: { page: 1, limit: 25, total: 1, pages: 1 },
    });

    renderPage();

    await waitFor(() => expect(screen.getByText('Smart India Hackathon')).toBeTruthy());
    // Scope to the row: the status filter also contains an option with this label.
    const row = screen.getByText('Smart India Hackathon').closest('tr') as HTMLElement;
    expect(within(row).getByText('Ministry of Education')).toBeTruthy();
    expect(within(row).getByText('REGISTRATION OPEN')).toBeTruthy();
    expect(within(row).getByText('recurring series')).toBeTruthy();
  });

  it('labels a predicted row as a prediction with its confidence, never as confirmed', async () => {
    mockedApi.hackathons.list.mockResolvedValue({
      data: [predicted],
      pagination: { page: 1, limit: 25, total: 1, pages: 1 },
    });

    renderPage();

    await waitFor(() => expect(screen.getByText('Acme Annual Hack')).toBeTruthy());
    const row = screen.getByText('Acme Annual Hack').closest('tr') as HTMLElement;
    expect(within(row).getByText('PREDICTED')).toBeTruthy();
    expect(within(row).getByText('72% confidence')).toBeTruthy();
    // The two labels must never be visually interchangeable.
    expect(statusBadgeClass('PREDICTED')).not.toBe(statusBadgeClass('CONFIRMED'));
    expect(statusBadgeClass('PREDICTED')).toContain('border-dashed');
    expect(statusBadgeClass('CONFIRMED')).not.toContain('border-dashed');
  });

  it('flags a row with no contact as needing enrichment instead of faking one', async () => {
    mockedApi.hackathons.list.mockResolvedValue({
      data: [predicted],
      pagination: { page: 1, limit: 25, total: 1, pages: 1 },
    });

    renderPage();

    await waitFor(() => expect(screen.getByText('needs enrichment')).toBeTruthy());
  });

  it('only offers Claim on hackathons nobody owns yet', async () => {
    mockedApi.hackathons.list.mockResolvedValue({
      data: [confirmed, { ...predicted, id: 'h3', name: 'Owned Hack', claimed_by: 'user-9' }],
      pagination: { page: 1, limit: 25, total: 2, pages: 1 },
    });

    renderPage();

    await waitFor(() => expect(screen.getByText('Owned Hack')).toBeTruthy());
    expect(screen.getAllByText('Claim')).toHaveLength(1);
  });

  it('sends the prediction filter to the API rather than filtering client-side', async () => {
    mockedApi.hackathons.list.mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 25, total: 0, pages: 0 },
    });

    renderPage();
    // Wait for the filter bar to be painted before interacting with it.
    await waitFor(() => expect(screen.getByText('No hackathons match these filters.')).toBeTruthy());

    // Two checkboxes now exist (row selection + the prediction filter), so target
    // the labelled one rather than the first in the DOM.
    fireEvent.click(screen.getByLabelText(/Predictions only/i));

    await waitFor(() => {
      const lastCall = mockedApi.hackathons.list.mock.calls.pop()[0];
      expect(lastCall.predicted).toBe(true);
    });
  });

  it('shows an honest empty state pointing at the army that fills it', async () => {
    mockedApi.hackathons.list.mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 25, total: 0, pages: 0 },
    });

    renderPage();

    await waitFor(() => expect(screen.getByText('No hackathons match these filters.')).toBeTruthy());
    expect(screen.getByText(/Run the Hackathon Army/)).toBeTruthy();
  });
});
